/**
 * PixiJS transparent overlay — renders Spine-animated characters on top of
 * the CSS combat grid.  The canvas sits flat (no CSS 3D transform) while
 * character positions are computed via DOM `getBoundingClientRect`, which
 * naturally accounts for the grid's CSS 3D perspective tilt.
 *
 * This component does NOT render cells, highlights, labels, or handle
 * interaction.  Those are handled by the CSS-based CombatGrid.
 */
import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { Application, Container, Graphics, Texture } from "pixi.js";
import { AtlasAttachmentLoader, SkeletonBinary, Spine, type SkeletonData } from "@pixi-spine/runtime-3.8";
import { TextureAtlas } from "@pixi-spine/base";
import type { CombatUnitDTO } from "../../types";
import { getCellCenter } from "./gridUtils";
import { resolveAnimSpec, type AnimSpec } from "./spineAnimSpecs";
import { createSpineVariantCache, type SpineVariants } from "../../utils/spineVariants";
import { createGridResourceLoadGuard, gridSpineActor, gridSpineResource, gridSpineFileUrl,
  gridUnitResourceKey, type GridSpineResource } from "../../utils/gridCombatResources";
import { makeFallbackToken } from "./fallbackToken";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * 战斗小人统一比例基准。
 *
 * 导入模型的包围盒可能包含武器、披风和技能特效，直接按包围盒归一化会
 * 错误缩小这些角色。这里使用统一的骨骼空间参考高度，保留素材自身的体型差异。
 * 内容包如需微调比例，可扩展 SPINE_SCALE_OVERRIDE。
 */
const REF_MODEL_H = 420;

/** 脚线：格心下方 0.2 格（沿用既有构图，脚底大致落在此处） */
const FOOT_DROP_RATIO = 0.2;

/**
 * 逐角色比例微调（可选逃生口）：值为相对统一比例的倍率。
 * 仅当某个模型因美术原因需要单独修正时才添加，默认空。
 */
const SPINE_SCALE_OVERRIDE: Record<string, number> = {};

/** 归一化所需的最小信息：统一 scale 与「包围盒底边（脚底）到骨骼原点的距离」 */
function unitScaleFor(name: string, team: string, cellSize: number, enemyScale: number): number {
  const base = (cellSize * 1.6) / REF_MODEL_H;
  const tuned = base * (SPINE_SCALE_OVERRIDE[name] ?? 1);
  return team === "enemy" ? tuned * enemyScale : tuned;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PixiCombatSceneProps {
  units: CombatUnitDTO[];
  /** The CSS grid's root DOM element (for computing cell screen positions). */
  gridEl: HTMLElement | null;
  /** The container element whose top-left corner serves as the coordinate origin. */
  containerEl: HTMLElement | null;
  /** Incremented on resize to trigger repositioning. */
  resizeTick: number;
  /** Grid cell size in px (used to compute spine scale). */
  cellSize?: number;
  /** 敌方小人高度缩放系数（相对我方目标高度）。等比缩放，不改素材宽高比。 */
  enemyScale?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface UnitEntry {
  resourceKey: string;
  displayObject: Container;
  cell: [number, number];
  yAnchorOffset: number;
  /** 是否为 Spine（false = fallback 圆点，动画方法 no-op） */
  isSpine?: boolean;
  spec?: AnimSpec;
  /** 是否正在播死亡动画（销毁前不再 remove） */
  dying?: boolean;
  /** 移动 tween 进行中（防止 resize 重排覆盖） */
  tweening?: boolean;
  baseScale?: number;
  flipped?: boolean;
  cancelTween?: () => void;
  killTimeout?: ReturnType<typeof setTimeout>;
  /** fallback 令牌 HP 条（isSpine=false 时存在；scale.x = hp/max_hp 控制宽度） */
  hpBar?: Graphics;
  /** fallback 令牌 HP 条满宽（px），用于按比例更新宽度 */
  hpWidth?: number;
}

/**
 * 脚底锚点偏移：让单位包围盒底边（脚线）落在格心下方 FOOT_DROP_RATIO 格处。
 *
 * 用「底边」而非「包围盒中心」锚定——武器/技能特效把包围盒撑高时，
 * 以中心锚定会把角色整体压低、脚不落地，这是尺寸不一的另一个来源。
 * `localBottom` = 包围盒底边在骨骼本地空间（scale=1）的 y 值；
 * 实测绝大多数模型的骨骼原点就在脚底（localBottom ≈ 0）。
 */
function calcFootAnchor(localBottom: number, scale: number, cellSize: number): number {
  return cellSize * FOOT_DROP_RATIO - localBottom * scale;
}

/** Load a Spine 3.8 character from .atlas + .skel files. */
async function loadSpine(resource: GridSpineResource, signal: AbortSignal): Promise<SkeletonData> {
  const atlasUrl = gridSpineFileUrl(resource, `${resource.fileName}.atlas`);
  const skelUrl = gridSpineFileUrl(resource, `${resource.fileName}.skel`);
  const fetchFile = async (url: string) => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`模型资源读取失败（${response.status}）：${url}`);
    return response;
  };

  const [atlasText, skelBuffer] = await Promise.all([
    fetchFile(atlasUrl).then((r) => r.text()),
    fetchFile(skelUrl).then((r) => r.arrayBuffer()),
  ]);
  signal.throwIfAborted();

  let onAbort: () => void;
  return new Promise<SkeletonData>((resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    new TextureAtlas(
      atlasText,
      (path, loaderFn) => {
        const imgUrl = gridSpineFileUrl(resource, path);
        Texture.fromURL(imgUrl).then((tex) => {
          signal.throwIfAborted();
          loaderFn(tex.baseTexture);
        }).catch(reject);
      },
      (atlas) => {
        if (!atlas) { reject(new Error("TextureAtlas returned null")); return; }
        try {
          signal.throwIfAborted();
          const al = new AtlasAttachmentLoader(atlas);
          const skeletonData = new SkeletonBinary(al).readSkeletonData(new Uint8Array(skelBuffer));
          // 兼容「附件存放在命名 skin、defaultSkin 为空」的模型（如 enemy_1011_wizard）：
          // 这类模型 Skeleton.getAttachment() 对每个插槽都返回 null，装配不出任何 sprite，
          // getBounds() 得到 0×0 → 小人完全不显示。此处把首个命名 skin 当作默认皮肤。
          if (!skeletonData.defaultSkin && skeletonData.skins.length > 0) {
            skeletonData.defaultSkin = skeletonData.skins[0];
          }
          resolve(skeletonData);
        } catch (e) {
          reject(e);
        }
      },
    );
  }).finally(() => signal.removeEventListener("abort", onAbort));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface PixiCombatSceneHandle {
  playAttack(unitId: string, targetId?: string): void;
  playHit(unitId: string, critical?: boolean, sourceId?: string): void;
  playDeath(unitId: string): void;
  playStart(unitId: string): void;
  moveTo(unitId: string, to: [number, number], durationMs?: number): void;
  /**
   * 单位当前的实际渲染包围盒，坐标系与覆盖层容器（= 网格相对容器）一致。
   * 供 UI（如敌方意图徽标）按真实尺寸定位，避免硬编码偏移。
   */
  getUnitRect(unitId: string): { left: number; top: number; width: number; height: number } | null;
}

/** 顺序播放动画链，末段结束回 finalIdle。listener 挂在 entry 上，被新动画中断时自动失效。 */
function playChain(spine: Spine, names: string[], finalIdle: string) {
  if (names.length === 0) return;
  let i = 0;
  const advance = (entry: any) => {
    if (spine.state.tracks[0] !== entry) return; // 已被新动画打断
    i += 1;
    if (i < names.length) {
      const e = spine.state.setAnimation(0, names[i], false);
      if (e) e.listener = { complete: advance };
    } else if (finalIdle) {
      spine.state.setAnimation(0, finalIdle, true);
    }
  };
  const first = spine.state.setAnimation(0, names[0], false);
  if (first) first.listener = { complete: advance };
}

const PixiCombatScene = forwardRef<PixiCombatSceneHandle, PixiCombatSceneProps>(function PixiCombatScene(
  { units, gridEl, containerEl, resizeTick, cellSize = 64, enemyScale = 1 }, ref,
) {
  const [variants, setVariants] = useState<Map<string, SpineVariants>>(() => new Map());
  const [loadVariants] = useState(createSpineVariantCache);
  const ownerKey = JSON.stringify([...new Set(units.filter(unit => unit.is_alive)
    .map(gridSpineActor).filter(actor => actor !== null).map(actor => actor.bookId))].sort());
  useEffect(() => {
    let cancelled = false;
    // Owners load in parallel; duplicate units and rerenders share one request per book.
    for (const bookId of JSON.parse(ownerKey) as string[]) {
      void loadVariants(bookId).then(registry => {
        if (!cancelled) setVariants(previous => new Map(previous).set(bookId, registry));
      }).catch(error => {
        if (!cancelled) console.warn(`模型目录不可用（${bookId}），使用职业棋子`, error);
      });
    }
    return () => { cancelled = true; };
  }, [ownerKey, loadVariants]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const unitLayerRef = useRef<Container | null>(null);
  const unitMapRef = useRef<Map<string, UnitEntry>>(new Map());
  const latestUnitsRef = useRef(units);
  latestUnitsRef.current = units;
  // Cache skeleton data, never a live Spine display object shared by multiple units.
  const loadingRef = useRef<Map<string, Promise<SkeletonData>>>(new Map());
  const loadingUnitsRef = useRef(createGridResourceLoadGuard());
  const loadAbortRef = useRef<AbortController | null>(null);
  /** 加载失败的资产负缓存（cacheKey）：避免每次重渲染重复请求 404 */
  const failedRef = useRef<Set<string>>(new Set());
  const [ready, setReady] = useState(false);
  const [gridReady, setGridReady] = useState(false);
  const [posTick, setPosTick] = useState(0);
  const initialPosDoneRef = useRef(false);
  const canvasSizeRef = useRef({ w: 800, h: 600 });

  // ── Compute canvas size from container ────────────────────────────
  const syncCanvasSize = useCallback(() => {
    if (!containerEl) return;
    const rect = containerEl.getBoundingClientRect();
    const w = Math.max(rect.width, 100);
    const h = Math.max(rect.height, 100);
    canvasSizeRef.current = { w, h };
    appRef.current?.renderer.resize(w, h);
  }, [containerEl]);

  // Keep a ref to the latest syncCanvasSize so the init effect can call it
  const syncCanvasSizeRef = useRef(syncCanvasSize);
  syncCanvasSizeRef.current = syncCanvasSize;

  // ── Compute a unit's screen position relative to the canvas ─────────
  const getCanvasPos = useCallback((row: number, col: number): [number, number] | null => {
    if (!gridEl || !containerEl) return null;
    const screen = getCellCenter(gridEl, row, col);
    if (!screen) return null;
    const cr = containerEl.getBoundingClientRect();
    return [screen.x - cr.left, screen.y - cr.top];
  }, [gridEl, containerEl]);

  // Keep a ref to latest getCanvasPos so async callbacks always use current positions
  const getCanvasPosRef = useRef(getCanvasPos);
  getCanvasPosRef.current = getCanvasPos;

  // Keep a ref to latest cellSize：动画 handle（deps 为 []）需读取最新值，避免闭包过期
  const cellSizeRef = useRef(cellSize);
  cellSizeRef.current = cellSize;

  // ── Init / destroy PixiJS app ──────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const { w, h } = canvasSizeRef.current;

    const app = new Application({
      width: w, height: h,
      backgroundAlpha: 0,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });

    const canvas = app.view as HTMLCanvasElement;
    canvas.style.background = "transparent";
    canvas.style.pointerEvents = "none";
    container.appendChild(canvas);
    appRef.current = app;
    const loadAbort = new AbortController();
    loadAbortRef.current = loadAbort;

    const unitLayer = new Container();
    unitLayer.sortableChildren = true;
    app.stage.addChild(unitLayer);
    unitLayerRef.current = unitLayer;
    setReady(true);
    // Sync canvas size now that the renderer is initialized
    syncCanvasSizeRef.current();

    return () => {
      loadAbort.abort();
      loadAbortRef.current = null;
      for (const entry of unitMapRef.current.values()) {
        entry.cancelTween?.();
        if (entry.killTimeout) clearTimeout(entry.killTimeout);
      }
      app.destroy(true, { children: true });
      appRef.current = null;
      unitLayerRef.current = null;
      unitMapRef.current.clear();
      loadingRef.current.clear();
      loadingUnitsRef.current.clear();
      failedRef.current.clear();
      initialPosDoneRef.current = false;
      setReady(false);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Wait for CSS 3D layout to settle before computing positions ─────
  // Double rAF ensures both layout AND compositing of the 3D perspective are complete.
  useEffect(() => {
    if (gridEl && containerEl) {
      let cancelled = false;
      requestAnimationFrame(() => {
        if (cancelled) return;
        const firstCell = getCellCenter(gridEl, 0, 0);
        if (firstCell && firstCell.x > 0 && firstCell.y > 0) {
          requestAnimationFrame(() => {
            if (!cancelled) {
              setGridReady(true);
            }
          });
        } else {
          requestAnimationFrame(() => {
            if (!cancelled) {
              setGridReady(true);
            }
          });
        }
      });
      return () => { cancelled = true; };
    } else {
      setGridReady(false);
      initialPosDoneRef.current = false;
    }
  }, [gridEl, containerEl]);

  // ── Resize canvas when container size changes ──────────────────────
  useEffect(() => {
    if (!ready) return;
    syncCanvasSize();
    const onResize = () => syncCanvasSize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [syncCanvasSize, ready]);

  // ── Unit management ───────────────────────────────────────────────
  useEffect(() => {
    if (!ready || !gridReady) return;
    const ul = unitLayerRef.current;
    if (!ul) return;

    const alive = units.filter((u) => u.is_alive);
    const aliveById = new Map(alive.map((u) => [u.unit_id, u]));
    const map = unitMapRef.current;
    const requests = loadingUnitsRef.current;
    for (const [id, request] of requests.entries()) {
      const unit = aliveById.get(id);
      if (!unit || gridUnitResourceKey(unit) !== request.resourceKey) requests.cancel(id);
    }

    // Remove departed — 尊重 dying（死亡动画播完再销毁，由 playDeath 的 timeout 负责）
    for (const [id, entry] of map) {
      const unit = aliveById.get(id);
      const identityChanged = unit && gridUnitResourceKey(unit) !== entry.resourceKey;
      if (!unit || identityChanged) {
        if (entry.dying && !identityChanged) continue;
        entry.cancelTween?.();
        if (entry.killTimeout) clearTimeout(entry.killTimeout);
        ul.removeChild(entry.displayObject);
        entry.displayObject.destroy({ children: true });
        map.delete(id);
      }
    }

    // Add / update
    for (const u of alive) {
      const resourceKey = gridUnitResourceKey(u);
      let exists = map.get(u.unit_id);
      const pos = getCanvasPos(u.pos[0], u.pos[1]);
      const sx = pos?.[0] ?? 0;
      const sy = pos?.[1] ?? 0;
      const zIndex = u.pos[0]; // higher row = closer to camera = render on top

      // Keep the established token visible while the registry/model is loading.
      if (!exists) {
        const fb = makeFallbackToken(u, sx, sy, cellSize);
        fb.container.zIndex = zIndex;
        ul.addChild(fb.container);
        exists = {
          resourceKey, displayObject: fb.container, cell: [u.pos[0], u.pos[1]], yAnchorOffset: 0,
          isSpine: false, flipped: u.team === "enemy", hpBar: fb.hpBar, hpWidth: fb.hpWidth,
        };
        map.set(u.unit_id, exists);
      }

      if (exists) {
        // fallback 令牌：按最新 hp/max_hp 更新 HP 条宽度（前景几何左锚定，scale.x 即宽度比例）
        if (exists.hpBar && exists.hpWidth) {
          const ratio = u.max_hp > 0 ? Math.max(0, Math.min(1, u.hp / u.max_hp)) : 0;
          exists.hpBar.scale.x = ratio;
        }
        // moveTo tween 进行中跳过位置重排，避免覆盖 tween
        if (!exists.tweening) {
          exists.cell = [u.pos[0], u.pos[1]];
          exists.displayObject.x = sx;
          exists.displayObject.y = sy + exists.yAnchorOffset;
        }
        if (exists.displayObject.zIndex !== zIndex) {
          exists.displayObject.zIndex = zIndex;
        }
      }
      const resource = gridSpineResource(u, variants);
      if (!exists.isSpine && resource && !failedRef.current.has(resource.cacheKey)) {
        // Guard: skip if this unit is already being loaded (prevents duplicate on re-render)
        if (requests.get(u.unit_id)) continue;
        const request = requests.begin(u.unit_id, resourceKey);
        const { cacheKey } = resource;

        const loadingApp = appRef.current;
        const signal = loadAbortRef.current!.signal;
        const stillCurrent = () => appRef.current === loadingApp && !ul.destroyed
          && !signal.aborted && requests.isCurrent(request)
          && latestUnitsRef.current.some(unit => unit.unit_id === u.unit_id && unit.is_alive
            && gridUnitResourceKey(unit) === resourceKey);
        (async () => {
          let spine: Spine | undefined;
          try {
            let pending = loadingRef.current.get(cacheKey);
            if (!pending) {
              pending = loadSpine(resource, signal);
              loadingRef.current.set(cacheKey, pending);
            }
            const skeletonData = await pending;
            if (!stillCurrent()) return;
            // Sharing data coalesces concurrent requests without reparenting live actors.
            spine = new Spine(skeletonData);

            // Re-compute position from DOM now that Spine is ready (layout has settled)
            const latestUnit = latestUnitsRef.current.find(unit => unit.unit_id === u.unit_id)!;
            const latestPos = getCanvasPosRef.current(latestUnit.pos[0], latestUnit.pos[1]);
            const finalSx = latestPos?.[0] ?? sx;
            const finalSy = latestPos?.[1] ?? sy;
            // 解析动画规格（战斗变体动画名带角色后缀，用前缀匹配）
            const spec = resolveAnimSpec(spine.spineData.animations.map((a: any) => a.name));

            // ── 统一比例 + 脚底锚定 ──
            // scale 为全阵容共用常数（仅敌方额外乘 enemyScale），不再逐角色归一化，
            // 避免武器/技能特效污染包围盒导致的大小不一（详见 REF_MODEL_H 注释）。
            // 脚线取自 idle 姿态包围盒底边：setup 姿态会带出技能特效（锏的 C_EX_Skill
            // 底边比脚底低 38px），idle 才是玩家实际看到的站姿。
            let localBottom = 0;
            try {
              // 测量前归零：包围盒必须在骨骼本地空间（scale=1、位置 0）读取
              spine.scale.set(1);
              spine.position.set(0, 0);
              const idleName = spec.idle || spec.start;
              if (idleName) {
                spine.state.setAnimation(0, idleName, true);
                spine.update(0);
              }
              const bounds = spine.getBounds();
              if (bounds && bounds.height > 0) localBottom = bounds.y + bounds.height;
            } catch { /* 保持原点锚定 */ }

            const scale = unitScaleFor(resource.characterId, u.team, cellSize, enemyScale);
            const yOff = calcFootAnchor(localBottom, scale, cellSize);
            spine.zIndex = latestUnit.pos[0];
            spine.x = finalSx;
            spine.y = finalSy + yOff;
            const flipped = u.team === "enemy";
            // 起始动画（spec.start 播完自动回 idle）
            const startAnim = spec.start ?? spec.idle;
            spine.state.setAnimation(0, startAnim, !spec.start);
            if (spec.start) {
              const e = spine.state.tracks[0];
              const actor = spine;
              if (e) e.listener = { complete: () => actor.state.setAnimation(0, spec.idle, true) };
            }
            if (flipped) { spine.scale.set(-scale, scale); }
            else { spine.scale.set(scale); }

            const previous = map.get(u.unit_id);
            if (previous) {
              previous.cancelTween?.();
              if (previous.killTimeout) clearTimeout(previous.killTimeout);
              previous.displayObject.removeFromParent();
              previous.displayObject.destroy({ children: true });
            }
            ul.addChild(spine);
            map.set(u.unit_id, {
              resourceKey, displayObject: spine, cell: [latestUnit.pos[0], latestUnit.pos[1]], yAnchorOffset: yOff,
              isSpine: true, spec, baseScale: scale, flipped,
            });
            spine = undefined; // The scene now owns the display object's lifetime.
            setPosTick((t) => t + 1);
          } catch (err) {
            spine?.destroy({ children: true });
            if (!stillCurrent()) return;
            // 负缓存：失败资产只记一次详细日志，之后直接走 fallback
            if (!failedRef.current.has(cacheKey)) {
              console.error(`[PixiCombatScene] Spine load failed for ${resource.bookId}/${resource.characterId}:`, err);
              if (err instanceof Error) {
                console.error(`[PixiCombatScene]   message: ${err.message}`);
                console.error(`[PixiCombatScene]   stack:`, err.stack);
              }
            }
            failedRef.current.add(cacheKey);
            // The loading-time token already has current HP, position and avatar.
          } finally {
            requests.finish(request);
          }
        })();
      }
    }

    ul.sortChildren();

    // On first layout, re-check positions after browser fully settles CSS 3D transforms
    if (!initialPosDoneRef.current && alive.length > 0) {
      initialPosDoneRef.current = true;
      requestAnimationFrame(() => {
        if (unitLayerRef.current === ul && !ul.destroyed) setPosTick((t) => t + 1);
      });
    }
  }, [ready, units, getCanvasPos, gridReady, posTick, cellSize, enemyScale, variants]);

  // ── Reposition units on resize ─────────────────────────────────────
  useEffect(() => {
    if (!ready || !gridReady) return;
    const map = unitMapRef.current;
    for (const [, entry] of map) {
      if (entry.tweening || entry.dying) continue;
      const pos = getCanvasPos(entry.cell[0], entry.cell[1]);
      if (pos) {
        entry.displayObject.x = pos[0];
        entry.displayObject.y = pos[1] + entry.yAnchorOffset;
      }
    }
  }, [ready, getCanvasPos, resizeTick]);

  // A unit owns one bounded presentation tween. Interruption restores its base pose.
  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tween = (entry: UnitEntry, duration: number, update: (t: number) => void, finish?: () => void) => {
    entry.cancelTween?.();
    const ticker = appRef.current?.ticker;
    if (!ticker || entry.displayObject.destroyed) return;
    const start = performance.now();
    const stop = () => { ticker.remove(tick); entry.cancelTween = undefined; finish?.(); };
    const tick = () => {
      if (entry.displayObject.destroyed) { stop(); return; }
      const t = Math.min(1, (performance.now() - start) / duration);
      update(t);
      if (t >= 1) stop();
    };
    entry.cancelTween = stop;
    ticker.add(tick);
  };
  const faceTarget = (entry: UnitEntry, targetId?: string) => {
    const target = targetId ? unitMapRef.current.get(targetId) : undefined;
    if (!target || Math.abs(target.displayObject.x - entry.displayObject.x) < 1) return;
    entry.flipped = target.displayObject.x < entry.displayObject.x;
    if (entry.isSpine) {
      const base = entry.baseScale ?? 1;
      entry.displayObject.scale.set(entry.flipped ? -base : base, base);
    }
  };
  const attackFeedback = (entry: UnitEntry) => {
    entry.cancelTween?.();
    const obj = entry.displayObject;
    const x = obj.x, base = entry.baseScale ?? 1;
    const sx = entry.isSpine && entry.flipped ? -base : base;
    const direction = entry.flipped ? -1 : 1;
    const distance = reducedMotion() ? 0 : Math.min(12, cellSizeRef.current * .16);
    entry.tweening = true;
    tween(entry, 360, t => {
      const pulse = t < .5 ? Math.sin(t * Math.PI) : Math.pow(2 - 2 * t, 2);
      obj.x = x + direction * distance * pulse;
      if (!entry.isSpine) obj.scale.set(1 + (reducedMotion() ? 0 : .045 * pulse));
    }, () => {
      if (!obj.destroyed) { obj.x = x; obj.scale.set(sx, base); }
      entry.tweening = false;
    });
  };
  const hitFeedback = (entry: UnitEntry, critical: boolean, sourceId?: string) => {
    entry.cancelTween?.();
    const obj = entry.displayObject;
    const x = obj.x;
    const source = sourceId ? unitMapRef.current.get(sourceId) : undefined;
    const direction = source ? Math.sign(x - source.displayObject.x) || 1 : entry.flipped ? 1 : -1;
    const distance = reducedMotion() ? 0 : (critical ? 7 : 4);
    const tinted: { node: Container & { tint: number }; original: number }[] = [];
    const tint = (node: Container) => {
      if ("tint" in node && typeof node.tint === "number") {
        const item = node as Container & { tint: number };
        tinted.push({ node: item, original: item.tint });
        item.tint = critical ? 0xffcd9c : 0xffb6a7;
      } else for (const child of node.children) if (child instanceof Container) tint(child);
    };
    tint(obj);
    entry.tweening = true;
    tween(entry, critical ? 220 : 170, t => {
      obj.x = x + direction * distance * Math.sin(Math.PI * t) * (1 - t);
      obj.alpha = .78 + .22 * t;
    }, () => {
      for (const { node, original } of tinted) if (!node.destroyed) node.tint = original;
      if (!obj.destroyed) { obj.x = x; obj.alpha = 1; }
      entry.tweening = false;
    });
  };

  useImperativeHandle(ref, () => ({
    playAttack(unitId: string, targetId?: string) {
      const entry = unitMapRef.current.get(unitId);
      if (!entry || entry.dying) return;
      entry.cancelTween?.();
      faceTarget(entry, targetId);
      attackFeedback(entry);
      if (entry.isSpine && entry.spec?.attack.length)
        playChain(entry.displayObject as Spine, entry.spec.attack, entry.spec.idle);
    },
    playHit(unitId: string, critical = false, sourceId?: string) {
      const entry = unitMapRef.current.get(unitId);
      if (!entry || entry.dying) return;
      hitFeedback(entry, critical, sourceId);
    },
    playDeath(unitId: string) {
      const entry = unitMapRef.current.get(unitId);
      if (!entry || entry.dying) return;
      entry.cancelTween?.();
      entry.dying = true;
      const obj = entry.displayObject;
      const y = obj.y;
      if (entry.isSpine && entry.spec?.die) playChain(obj as Spine, [entry.spec.die], "");
      tween(entry, reducedMotion() ? 100 : 630, t => {
        obj.alpha = 1 - Math.max(0, (t - .3) / .7);
        if (!entry.isSpine && !reducedMotion()) obj.y = y + 7 * t;
      });
      entry.killTimeout = setTimeout(() => {
        entry.cancelTween?.();
        if (!obj.destroyed) { obj.removeFromParent(); obj.destroy({ children: true }); }
        if (unitMapRef.current.get(unitId) === entry) unitMapRef.current.delete(unitId);
      }, reducedMotion() ? 120 : 650);
    },

    playStart(unitId: string) {
      const entry = unitMapRef.current.get(unitId);
      if (!entry || !entry.isSpine || !entry.spec) return;
      const spine = entry.displayObject as Spine;
      const spec = entry.spec;
      if (spec.start) {
        const e = spine.state.setAnimation(0, spec.start, false);
        if (e) e.listener = { complete: () => spine.state.setAnimation(0, spec.idle, true) };
      } else {
        spine.state.setAnimation(0, spec.idle, true);
      }
    },

    moveTo(unitId: string, to: [number, number], durationMs = 300) {
      const entry = unitMapRef.current.get(unitId);
      if (!entry || entry.dying) return;
      const from = getCanvasPosRef.current(entry.cell[0], entry.cell[1]);
      const target = getCanvasPosRef.current(to[0], to[1]);
      if (!from || !target) { entry.cell = to; return; }
      entry.cancelTween?.();
      entry.tweening = true;
      if (entry.isSpine && Math.abs(target[0] - from[0]) > 1) {
        entry.flipped = target[0] < from[0];
        const base = entry.baseScale ?? 1;
        entry.displayObject.scale.set(entry.flipped ? -base : base, base);
      }
      tween(entry, reducedMotion() ? 1 : Math.max(50, durationMs), t => {
        const progress = 1 - Math.pow(1 - t, 3);
        entry.displayObject.x = from[0] + (target[0] - from[0]) * progress;
        entry.displayObject.y = from[1] + (target[1] - from[1]) * progress + entry.yAnchorOffset;
      }, () => {
        if (!entry.displayObject.destroyed) entry.displayObject.position.set(target[0], target[1] + entry.yAnchorOffset);
        entry.cell = to;
        entry.tweening = false;
      });
    },

    getUnitRect: (unitId: string) => {
      const entry = unitMapRef.current.get(unitId);
      if (!entry) return null;
      // unitLayer 位于 stage 原点，故 getBounds() 即覆盖层局部坐标
      const b = entry.displayObject.getBounds();
      if (!b || b.width <= 0 || b.height <= 0) return null;
      return { left: b.x, top: b.y, width: b.width, height: b.height };
    },
  }), []);

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 1,
      }}
    />
  );
});

export default PixiCombatScene;
