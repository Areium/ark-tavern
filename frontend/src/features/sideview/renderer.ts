import { Application, Container, Graphics, Rectangle, SCALE_MODES, Sprite, Text, TextStyle, Texture, TilingSprite } from 'pixi.js';
import type { Body, Effect, Simulation, SimulationLevel, SideviewOperator } from './types';
import { hasSideviewSpine, loadSideviewSpine, makeSideviewSpine } from './spineActors';
import { ELITE_LUNGE, ENEMY_WINDUP, eliteLungeBox, exitBarrierX, exitLocked, guardStrikeBox, levelTables } from './simulation';
import { getBaseUrl } from '../../utils/baseUrl';

const C = { sky: 0x0b1722, stone: 0x243b43, cyan: 0x8ce5e0, orange: 0xf4a66b, red: 0xe77977, heal: 0xbde6a0, white: 0xe1ffff };
/** A defeated enemy holds its death pose, then fades out. */
const DEATH = { hold: 0.55, fade: 0.45 };
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** Pixi 7 joins `arc()` to the previous path's last point; start every arc at its own first point. */
const arcStroke = (g: Graphics, x: number, y: number, r: number, from: number, to: number) => g.moveTo(x + Math.cos(from) * r, y + Math.sin(from) * r).arc(x, y, r, from, to);
const NUMBER_FONT = ['Bahnschrift', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'];
const numberStyle = (fill: number, size: number) => new TextStyle({ fontFamily: NUMBER_FONT, fontSize: size, fontWeight: '700', fill, stroke: 0x061019, strokeThickness: 4, lineJoin: 'round' });

/** Texture scenery and Spine presentation; simulation remains authoritative. */
export function createRenderer(host: HTMLDivElement, level: SimulationLevel, reducedMotion: boolean, operator: SideviewOperator, onAssets: (message: string) => void = () => {}) {
  const app = new Application({ width: host.clientWidth || 1000, height: host.clientHeight || 600, backgroundColor: C.sky, antialias: true, resolution: Math.min(devicePixelRatio || 1, 2), autoDensity: true, autoStart: false });
  const operatorName = operator.name;
  const canvas = app.view as HTMLCanvasElement;
  canvas.setAttribute('aria-hidden', 'true'); host.appendChild(canvas);
  const scenery = new Graphics(); const backdrop = new Container(); const world = new Container();
  const fallback = { platforms: new Graphics(), obstacles: new Graphics(), hazards: new Graphics() };
  const surfaces = new Container(); const terrain = new Graphics(); const gate = new Graphics();
  const telegraphs = new Graphics(); const tokens = new Graphics(); const figures = new Container();
  const bars = new Graphics(); const fx = new Graphics(); const labels = new Container();
  const foreground = new Graphics(); const overlay = new Graphics();
  app.stage.addChild(scenery, backdrop, world, foreground, overlay);
  world.addChild(fallback.platforms, fallback.obstacles, fallback.hazards, surfaces, terrain, gate, telegraphs, tokens, figures, bars, fx, labels);
  let disposed = false, lastElapsed = 0, firstFrame = true;
  let city: Sprite | undefined, playerPortrait: Sprite | undefined, portraitFailed = false;
  const units = new Map<string, ReturnType<typeof makeSideviewSpine>>();
  const failures = new Set<string>();
  const { specs } = levelTables(level);
  let pendingAssets = 5 + Number(operatorName === '临光'); // Scenery, models, and the demo portrait fallback.
  const report = () => onAssets([
    pendingAssets ? '正在装载场景与战斗模型…' : '',
    failures.size ? `简化显示：${[...failures].join('、')}；操作不受影响。` : '',
  ].filter(Boolean).join(' '));
  const loadScenery = async (file: string, label: string, apply: (texture: Texture) => void) => {
    try {
      const texture = await Texture.fromURL(`./assets/sideview/${file}.png`);
      if (disposed) return;
      texture.baseTexture.scaleMode = SCALE_MODES.LINEAR;
      apply(texture);
    } catch { if (!disposed) failures.add(label); }
    finally { if (!disposed) { pendingAssets--; report(); } }
  };
  void loadScenery('rainbound-city', '雨夜废城背景', texture => {
    city = new Sprite(texture); city.alpha = 0.86; backdrop.addChild(city);
  });
  void loadScenery('ruin-terrain', '平台纹理', texture => {
    for (const p of level.platforms) {
      const body = new TilingSprite(texture, p.width, p.height);
      body.position.set(p.x, p.y); body.tileScale.set(0.28);
      body.tilePosition.set(-p.x, -p.y); surfaces.addChild(body);
    }
    fallback.platforms.visible = false;
  });
  void loadScenery('cargo-barrier', '障碍箱', texture => {
    // Alpha > 100 bounds of the supplied image: transparent export padding is
    // excluded so the visible body occupies the simulation's collision box.
    const cropped = new Texture(texture.baseTexture, new Rectangle(54, 133, 1195, 913));
    for (const o of level.obstacles) {
      const box = new Sprite(cropped); box.position.set(o.x, o.y);
      box.width = o.width; box.height = o.height; surfaces.addChild(box);
    }
    fallback.obstacles.visible = false;
  });
  void loadScenery('crystal-hazard', '晶体危险带', texture => {
    const cropped = new Texture(texture.baseTexture, new Rectangle(7, 183, 2158, 403));
    for (const h of level.hazards) {
      const crystals = new Sprite(cropped);
      const visualHeight = Math.max(h.height, Math.min(48, h.width * 0.38));
      crystals.position.set(h.x, h.y + h.height - visualHeight);
      crystals.width = h.width; crystals.height = visualHeight; surfaces.addChild(crystals);
    }
    fallback.hazards.visible = false;
  });
  if (operatorName === '临光') void (async () => {
    try {
      const texture = await Texture.fromURL(`${await getBaseUrl()}/api/characters/${encodeURIComponent(operatorName)}/skin`);
      if (disposed) return;
      texture.baseTexture.scaleMode = SCALE_MODES.LINEAR;
      playerPortrait = new Sprite(texture);
      playerPortrait.anchor.set(0.5, 1);
      figures.addChild(playerPortrait);
    } catch {
      portraitFailed = true;
      if (!disposed && !units.has('player')) failures.add(operatorName);
    } finally { if (!disposed) { pendingAssets--; report(); } }
  })();
  // Authored enemy names with a registered model win; otherwise the role picks a stand-in model.
  const kindModel = { ranger: '整合运动狙击手', elite: '整合运动盾卫', guard: '整合运动士兵' } as const;
  const names = [{ id: 'player', name: operatorName }, ...level.enemies.map(e => ({ id: e.id, name: e.name && hasSideviewSpine(e.name) ? e.name : kindModel[e.kind] }))];
  const cache = new Map<string, ReturnType<typeof loadSideviewSpine>>();
  report();
  Promise.all(names.map(async ({ id, name }) => {
    try {
      if (!cache.has(name)) cache.set(name, loadSideviewSpine(name));
      const data = await cache.get(name)!;
      if (disposed) return;
      const unit = makeSideviewSpine(data); units.set(id, unit); figures.addChild(unit.spine);
      if (id === 'player') failures.delete(name);
    } catch { if (!disposed && (id !== 'player' || operatorName !== '临光' || portraitFailed)) failures.add(name); }
  })).then(() => { if (!disposed) { pendingAssets--; report(); } });

  // Level geometry never changes during a run: draw fallbacks and edge markings once.
  for (const p of level.platforms) fallback.platforms.beginFill(C.stone).drawRect(p.x, p.y, p.width, p.height).endFill();
  for (const o of level.obstacles) fallback.obstacles.beginFill(C.stone).drawRect(o.x, o.y, o.width, o.height).endFill();
  for (const h of level.hazards) for (let x = h.x; x < h.x + h.width; x += 16) {
    const right = Math.min(x + 14, h.x + h.width);
    fallback.hazards.beginFill(C.red, 0.8).drawPolygon([x, h.y + h.height, (x + right) / 2, h.y, right, h.y + h.height]).endFill();
  }
  for (const p of level.platforms) {
    terrain.beginFill(0x020c11, 0.24).drawRect(p.x, p.y + 4, p.width, Math.max(0, p.height - 4)).endFill();
    terrain.beginFill(0xb4d7d8, 0.85).drawRect(p.x, p.y, p.width, 2).endFill();
    terrain.beginFill(0x07171f, 0.8).drawRect(p.x, p.y + p.height - 2, p.width, 2).endFill();
  }
  // The thin top rail identifies the full standable width, including the
  // open handles in the illustration, without painting over the artwork.
  for (const o of level.obstacles) terrain.lineStyle(1, C.orange, 0.7).moveTo(o.x, o.y).lineTo(o.x + o.width, o.y).lineStyle(0);
  for (const h of level.hazards) {
    terrain.beginFill(C.red, 0.09).drawRect(h.x, h.y, h.width, h.height).endFill();
    // End ticks and a red baseline expose the exact dangerous interval.
    terrain.lineStyle(1.5, C.red, 0.9).moveTo(h.x, h.y).lineTo(h.x, h.y + h.height)
      .lineTo(h.x + h.width, h.y + h.height).lineTo(h.x + h.width, h.y).lineStyle(0);
  }

  const styles = { enemy: numberStyle(0xfff1dc, 20), heavy: numberStyle(0xffd08a, 26), player: numberStyle(0xff8f86, 20), heal: numberStyle(C.heal, 20) };
  const pool: Text[] = [];
  const perfectLabel = new Text('极限闪避', new TextStyle({ fontFamily: NUMBER_FONT, fontSize: 17, fontWeight: '700', fill: C.white, stroke: 0x0b3a44, strokeThickness: 4, letterSpacing: 2 }));
  perfectLabel.anchor.set(0.5, 1); perfectLabel.visible = false; labels.addChild(perfectLabel);
  const label = (i: number) => {
    while (pool.length <= i) { const t = new Text('', styles.enemy); t.anchor.set(0.5, 1); labels.addChild(t); pool.push(t); }
    return pool[i];
  };
  const deathAt = new Map<string, number>();

  function drawUnit(id: string, body: Body, dt: number, attacking: boolean, hurt: boolean, deadFor?: number) {
    const unit = units.get(id);
    if (!unit) return false;
    const { spine, spec } = unit;
    const size = body.height * 1.35 / 420;
    spine.scale.set(size * body.facing, size);
    spine.position.set(body.x + body.width / 2, body.y + body.height - unit.bottom * size);
    if (deadFor !== undefined) {
      const alpha = 1 - clamp01((deadFor - DEATH.hold) / DEATH.fade);
      spine.visible = alpha > 0; spine.alpha = alpha; spine.tint = 0xffffff;
      if (!unit.dead) {
        unit.dead = true; unit.attackPlaying = false;
        if (spec.die && alpha > 0) spine.state.setAnimation(0, spec.die, false);
      }
      if (alpha > 0) spine.update(dt);
      return true;
    }
    spine.visible = true; spine.alpha = 1;
    spine.tint = hurt ? 0xffd5a9 : 0xffffff;
    if (attacking && !unit.attacking && !unit.attackPlaying && spec.attack.length) {
      unit.attackPlaying = true;
      let finalEntry = spine.state.setAnimation(0, spec.attack[0], false);
      for (const name of spec.attack.slice(1)) finalEntry = spine.state.addAnimation(0, name, false, 0);
      // The short simulation hit window does not own the visual animation's lifetime.
      // Only completion of the final segment releases locomotion; later attack edges
      // during this chain are consumed without restarting or truncating it.
      finalEntry.listener = { complete: () => { unit.attackPlaying = false; } };
      if (spec.idle) spine.state.addAnimation(0, spec.idle, true, 0);
      unit.action = 'attack';
    } else if (!unit.attackPlaying) {
      const action = Math.abs(body.vx) > 15 && unit.move ? unit.move : spec.idle;
      if (action && unit.action !== action) { spine.state.setAnimation(0, action, true); unit.action = action; }
    }
    unit.attacking = attacking;
    spine.update(dt);
    return true;
  }

  let camera = 0, anchor = 0.37;
  const resize = () => app.renderer.resize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight));
  const observer = new ResizeObserver(resize); observer.observe(host);
  function token(g: Graphics, x: number, y: number, w: number, h: number, facing: number, color: number, hurt = false, alpha = 1) {
    // Explicit tactical token when the local model is absent; never an imitation character.
    const cx = x + w / 2;
    g.beginFill(0x071b20, 0.95 * alpha).lineStyle(2, hurt ? 0xffffff : color, alpha).drawRoundedRect(cx - 18, y + 8, 36, h - 8, 5).endFill();
    g.lineStyle(2, color, alpha).moveTo(cx - facing * 5, y + 25).lineTo(cx + facing * 8, y + 32).lineTo(cx - facing * 5, y + 39).lineStyle(0);
  }

  function telegraph(s: Simulation) {
    telegraphs.clear();
    const p = s.player;
    for (const e of s.enemies) {
      if (e.hp <= 0 || e.windup <= 0) continue;
      const spec = specs.get(e.id)!;
      const progress = 1 - e.windup / ENEMY_WINDUP[spec.kind];
      const floor = e.y + e.height;
      if (spec.kind === 'guard') {
        const box = guardStrikeBox(e);
        telegraphs.beginFill(C.orange, 0.05 + 0.12 * progress).drawRect(box.x, box.y, box.width, box.height).endFill();
        telegraphs.beginFill(C.orange, 0.85).drawRect(box.x + box.width / 2 * (1 - progress), floor - 3, box.width * progress, 3).endFill();
        telegraphs.lineStyle(1, C.orange, 0.6).drawRect(box.x, floor - 3, box.width, 3).lineStyle(0);
      } else if (spec.kind === 'elite') {
        // The full lunge corridor: where the charge starts, where it ends.
        const box = eliteLungeBox(e), reach = ELITE_LUNGE.speed * ELITE_LUNGE.time;
        const x = e.facing > 0 ? box.x : box.x - reach, width = box.width + reach;
        telegraphs.beginFill(C.red, 0.06 + 0.14 * progress).drawRect(x, box.y, width, box.height).endFill();
        telegraphs.beginFill(C.red, 0.9).drawRect(e.facing > 0 ? x : x + width * (1 - progress), floor - 4, width * progress, 4).endFill();
        for (let n = 0; n < 3; n++) {
          const cx = e.x + e.width / 2 + e.facing * (54 + n * 34), cy = e.y + e.height / 2;
          telegraphs.lineStyle(3, C.red, clamp01(progress * 3 - n * 0.6)).moveTo(cx - e.facing * 9, cy - 12).lineTo(cx + e.facing * 5, cy).lineTo(cx - e.facing * 9, cy + 12).lineStyle(0);
        }
      } else {
        // Ranger: sight line toward the player's chest while aiming.
        const bx = e.x + e.width / 2 + e.facing * 10, by = e.y + 24;
        const tx = p.x + p.width / 2, ty = p.y + p.height * 0.45;
        const len = Math.hypot(tx - bx, ty - by) || 1, reach = Math.min(len, 420);
        const ux = (tx - bx) / len, uy = (ty - by) / len;
        for (let d = 0; d < reach; d += 18) telegraphs.lineStyle(1.5, C.orange, 0.25 + 0.6 * progress).moveTo(bx + ux * d, by + uy * d).lineTo(bx + ux * Math.min(reach, d + 9), by + uy * Math.min(reach, d + 9));
        telegraphs.lineStyle(0);
      }
    }
  }

  function drawEffect(e: Effect) {
    const alpha = Math.min(1, e.life * 3);
    if (e.kind === 'slash' && e.tone === 'enemy') {
      arcStroke(fx.lineStyle(4, C.orange, alpha), e.x, e.y, 56, e.facing > 0 ? -1 : 2.1, e.facing > 0 ? 1 : 4.1).lineStyle(0);
    } else if (e.kind === 'slash') {
      // Alternate the arc between the first and second hit so the chain reads as two swings.
      const low = e.value === 2 ? 0.35 : 0;
      arcStroke(fx.lineStyle(5, C.white, alpha), e.x, e.y, 71, (e.facing > 0 ? -1.2 : 1.9) + low, (e.facing > 0 ? 1.2 : 4.3) + low).lineStyle(0);
    } else if (e.kind === 'finisher') {
      const grow = 1 + (0.3 - e.life) * 1.2;
      arcStroke(fx.lineStyle(9, C.cyan, alpha * 0.55), e.x, e.y, 92 * grow, e.facing > 0 ? -1.35 : 1.8, e.facing > 0 ? 1.35 : 4.5).lineStyle(0);
      arcStroke(fx.lineStyle(4, C.white, alpha), e.x, e.y, 84 * grow, e.facing > 0 ? -1.25 : 1.9, e.facing > 0 ? 1.25 : 4.4).lineStyle(0);
    } else if (e.kind === 'skill' || e.kind === 'support') {
      const r = e.kind === 'skill' ? (1 - e.life / 0.65) * 230 : (1 - e.life) * 390;
      fx.lineStyle(e.kind === 'skill' ? 5 : 2, e.kind === 'skill' ? C.cyan : C.heal, alpha).drawEllipse(e.x, e.y, r, r * 0.6).lineStyle(0);
      fx.beginFill(C.cyan, alpha * 0.05).drawCircle(e.x, e.y, r).endFill();
    } else if (e.kind === 'dash') fx.beginFill(C.cyan, alpha * 0.25).drawRect(e.x, e.y + 10, 30, 45).endFill();
    else if (e.kind === 'perfect') {
      const r = 26 + (0.6 - e.life) * 170;
      fx.lineStyle(3, C.white, alpha).drawCircle(e.x, e.y, r).lineStyle(0);
      fx.lineStyle(1.5, C.cyan, alpha * 0.7).drawCircle(e.x, e.y, r * 0.72).lineStyle(0);
    } else if (e.kind === 'lunge') {
      for (let n = 0; n < 4; n++) fx.lineStyle(2, C.red, alpha * 0.8).moveTo(e.x - e.facing * (20 + n * 18), e.y - 24 + n * 15).lineTo(e.x - e.facing * (70 + n * 26), e.y - 24 + n * 15).lineStyle(0);
    } else if (e.kind === 'hit') for (let n = 0; n < 6; n++) { const a = n * Math.PI / 3; const r = (0.3 - e.life) * 150; fx.lineStyle(2, C.orange, alpha).moveTo(e.x + Math.cos(a) * r, e.y + Math.sin(a) * r).lineTo(e.x + Math.cos(a) * (r + 10), e.y + Math.sin(a) * (r + 10)).lineStyle(0); }
  }

  function render(s: Simulation) {
    const dt = Math.max(0, Math.min(0.1, s.elapsed - lastElapsed)); lastElapsed = s.elapsed;
    const width = app.screen.width, height = app.screen.height;
    const p = s.player;
    // Keep the play plane at a useful vertical size on portrait devices.
    // Narrow screens see less of the world and track the player horizontally.
    const scale = height / 640;
    const vw = width / scale, vh = height / scale;
    // Look ahead in the facing direction; ease the anchor so turning does not snap the view.
    anchor += ((p.facing > 0 ? 0.37 : 0.6) - anchor) * (reducedMotion ? 1 : 0.035);
    const target = Math.max(0, Math.min(level.worldWidth - vw, p.x - vw * anchor));
    camera += (target - camera) * (reducedMotion ? 1 : 0.12);
    const cy = Math.max(0, Math.min(level.worldHeight - vh + 30, p.y - vh * 0.55));
    const shake = reducedMotion ? 0 : s.shake * 20;
    const sx = Math.sin(s.elapsed * 97) * shake, sy = Math.cos(s.elapsed * 83) * shake * 0.6;
    world.scale.set(scale); world.position.set(-camera * scale + sx, -cy * scale + sy);
    scenery.clear(); scenery.scale.set(scale);
    scenery.beginFill(C.sky).drawRect(0, 0, vw, vh).endFill();
    if (city) {
      // Cover once, never repeat. Overscan allows a restrained parallax pan
      // across the full level without exposing an edge at either camera limit.
      const cover = Math.max(width / city.texture.width, height / city.texture.height) * 1.08;
      city.scale.set(cover);
      const travel = Math.max(1, level.worldWidth - vw);
      const progress = Math.max(0, Math.min(1, camera / travel));
      const horizontalRoom = Math.max(0, city.width - width);
      const pan = Math.min(horizontalRoom, width * 0.1);
      city.position.set(-horizontalRoom / 2 + (0.5 - progress) * pan, (height - city.height) / 2);
    }
    gate.clear();
    const goal = level.goal, unlocked = !exitLocked(s, level);
    if (!unlocked) {
      const gateX = exitBarrierX(level);
      gate.beginFill(C.cyan, 0.15).drawRect(gateX, 0, 24, level.worldHeight).endFill();
      gate.lineStyle(2, C.cyan, 0.8).moveTo(gateX, 0).lineTo(gateX, level.worldHeight)
        .moveTo(gateX + 24, 0).lineTo(gateX + 24, level.worldHeight).lineStyle(0);
      for (let y = 16; y < level.worldHeight; y += 42) {
        gate.lineStyle(2, C.cyan, 0.45).moveTo(gateX + 3, y).lineTo(gateX + 21, y + 18).lineStyle(0);
      }
    }
    const beacon = unlocked && !reducedMotion ? 0.12 + 0.08 * Math.sin(s.elapsed * 4) : 0.17;
    gate.lineStyle(4, unlocked ? C.cyan : 0x71858b).drawRect(goal.x, goal.y, goal.width, goal.height).lineStyle(0);
    gate.beginFill(unlocked ? C.cyan : 0x40545e, unlocked ? beacon : 0.12).drawRect(goal.x + 5, goal.y + 5, goal.width - 10, goal.height - 5).endFill();
    gate.lineStyle(3, unlocked ? C.cyan : 0x71858b).moveTo(goal.x + 30, goal.y + 45).lineTo(goal.x + 62, goal.y + 62).lineTo(goal.x + 30, goal.y + 80).lineStyle(0);

    telegraph(s);
    tokens.clear(); bars.clear();
    for (const e of s.enemies) {
      const spec = specs.get(e.id)!;
      if (e.hp <= 0) {
        // Enemies already defeated in a restored save do not replay their death.
        if (!deathAt.has(e.id)) deathAt.set(e.id, firstFrame ? -Infinity : s.elapsed);
        const deadFor = s.elapsed - deathAt.get(e.id)!;
        if (!drawUnit(e.id, e, dt, false, false, deadFor)) {
          const alpha = 1 - clamp01((deadFor - DEATH.hold) / DEATH.fade);
          if (alpha > 0) token(tokens, e.x, e.y, e.width, e.height, e.facing, C.orange, false, alpha * 0.6);
        }
        continue;
      }
      if (!drawUnit(e.id, e, dt, e.windup > 0 || e.lunge > 0, e.hurt > 0)) token(tokens, e.x, e.y, e.width, e.height, e.facing, C.orange, e.hurt > 0);
      const elite = spec.kind === 'elite', barH = elite ? 6 : 4;
      // The outlined track keeps a nearly empty bar readable against the dark street.
      bars.lineStyle(1, 0x8aa3a8, 0.55).beginFill(0x0a141c, 0.9).drawRect(e.x - 5, e.y - 17, e.width + 10, barH).endFill().lineStyle(0);
      bars.beginFill(elite ? C.red : C.orange).drawRect(e.x - 5, e.y - 17, (e.width + 10) * e.hp / spec.hp, barH).endFill();
      if (e.stagger > 0) bars.lineStyle(1.5, C.white, 0.8).drawRect(e.x - 6, e.y - 18, e.width + 12, barH + 2).lineStyle(0);
      if (e.windup > 0) {
        bars.lineStyle(2, C.orange, 0.85).drawCircle(e.x + e.width / 2, e.y - 34, 9).moveTo(e.x + e.width / 2, e.y - 39).lineTo(e.x + e.width / 2, e.y - 32).lineStyle(0);
        bars.beginFill(C.orange).drawCircle(e.x + e.width / 2, e.y - 28, 1.5).endFill();
      }
    }
    const blink = p.invulnerable > 0 && Math.floor(s.elapsed * 16) % 2 === 1;
    if (!drawUnit('player', p, dt, p.attackTime > 0, blink)) {
      if (playerPortrait) {
        const size = p.height * 1.5 / playerPortrait.texture.height;
        playerPortrait.visible = true;
        playerPortrait.scale.set(size * p.facing, size);
        playerPortrait.position.set(p.x + p.width / 2, p.y + p.height + 2);
        playerPortrait.tint = blink ? 0xffd5a9 : 0xffffff;
      } else if (operatorName !== '临光' || portraitFailed) token(tokens, p.x, p.y, p.width, p.height, p.facing, C.cyan, blink);
    } else if (playerPortrait) playerPortrait.visible = false;
    fx.clear();
    for (const b of s.projectiles) {
      const tail = 0.05;
      fx.lineStyle(6, C.orange, 0.25).moveTo(b.x + 7 - b.vx * tail, b.y + 3 - b.vy * tail).lineTo(b.x + 7, b.y + 3);
      fx.lineStyle(2.5, 0xffd9b0, 1).moveTo(b.x + 7 - b.vx * tail * 0.6, b.y + 3 - b.vy * tail * 0.6).lineTo(b.x + 7, b.y + 3).lineStyle(0);
    }
    let numbers = 0, perfect: Effect | undefined;
    for (const e of s.effects) {
      if (e.kind === 'damage') {
        const t = label(numbers++);
        const style = e.tone === 'heal' ? styles.heal : e.tone === 'player' ? styles.player : (e.value ?? 0) >= 40 ? styles.heavy : styles.enemy;
        const text = `${e.tone === 'heal' ? '+' : ''}${e.value ?? 0}`;
        if (t.text !== text) t.text = text;
        if (t.style !== style) t.style = style;
        const age = clamp01(1 - e.life / 0.8);
        const rise = reducedMotion ? 0 : 30 * (1 - (1 - age) ** 3);
        t.visible = true; t.alpha = Math.min(1, e.life * 4);
        t.scale.set(reducedMotion ? 1 : 1 + 0.3 * Math.max(0, 1 - age * 7));
        t.position.set(e.x + ((numbers % 3) - 1) * 6, e.y - rise);
        continue;
      }
      if (e.kind === 'perfect') perfect = e;
      drawEffect(e);
    }
    for (let n = numbers; n < pool.length; n++) pool[n].visible = false;
    perfectLabel.visible = !!perfect;
    if (perfect) { perfectLabel.alpha = Math.min(1, perfect.life * 3); perfectLabel.position.set(p.x + p.width / 2, p.y - 22 - (reducedMotion ? 0 : (0.6 - perfect.life) * 30)); }
    foreground.clear(); foreground.scale.set(scale);
    if (!reducedMotion) for (let n = 0; n < 45; n++) {
      const x = ((n * 173 - s.elapsed * 75) % (vw + 100) + vw + 100) % (vw + 100);
      const y = (n * 97 + s.elapsed * 380) % vh;
      foreground.lineStyle(1, 0xb4d5de, 0.13).moveTo(x, y).lineTo(x - 5, y + 17).lineStyle(0);
    }
    // Near-field girders establish depth without covering the playable floor.
    for (let n = 0; n < 5; n++) {
      const x = n * 490 - (camera * 1.15 % 490);
      foreground.beginFill(0x050e17, 0.82).drawPolygon([x, vh, x + 14, vh - 60, x + 27, vh - 44, x + 45, vh]).endFill();
    }
    // Edge vignette: a flash when hurt, and a steady pulse while critically wounded.
    overlay.clear();
    const critical = s.outcome ? 0 : p.hp > 0 && p.hp < operator.maxHp * 0.3 ? 0.35 + (reducedMotion ? 0 : 0.15 * Math.sin(s.elapsed * 5)) : 0;
    const strength = Math.max(critical, s.hurtFlash / 0.45);
    if (strength > 0.01) for (let n = 0; n < 6; n++) {
      const inset = n * 12;
      overlay.lineStyle(12, C.red, strength * 0.22 * (1 - n / 6)).drawRect(inset + 6, inset + 6, width - inset * 2 - 12, height - inset * 2 - 12);
    }
    overlay.lineStyle(0);
    firstFrame = false;
    app.renderer.render(app.stage);
  }
  return { render, destroy() { disposed = true; observer.disconnect(); app.destroy(true, { children: true }); } };
}
