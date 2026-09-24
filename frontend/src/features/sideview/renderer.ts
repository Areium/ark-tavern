import { Application, Container, Graphics, Texture, TilingSprite, Sprite, Rectangle, SCALE_MODES } from 'pixi.js';
import type { Simulation, SimulationLevel, Body } from './types';
import { loadSideviewSpine, makeSideviewSpine } from './spineActors';
import { exitBarrierX, exitLocked } from './simulation';
import { getBaseUrl } from '../../utils/baseUrl';

const C = { sky: 0x0b1722, stone: 0x243b43, cyan: 0x8ce5e0, orange: 0xf4a66b, red: 0xe77977 };

/** Texture scenery and Spine presentation; simulation remains authoritative. */
export function createRenderer(host: HTMLDivElement, level: SimulationLevel, reducedMotion: boolean, operatorName: string, onAssets: (message: string) => void = () => {}) {
  const app = new Application({ width: host.clientWidth || 1000, height: host.clientHeight || 600, backgroundColor: C.sky, antialias: true, resolution: Math.min(devicePixelRatio || 1, 2), autoDensity: true, autoStart: false });
  const canvas = app.view as HTMLCanvasElement;
  canvas.setAttribute('aria-hidden', 'true'); host.appendChild(canvas);
  const scenery = new Graphics(); const backdrop = new Container(); const surfaces = new Container(); const figures = new Container(); const world = new Container();
  const terrain = new Graphics(); const actors = new Graphics(); const fx = new Graphics(); const foreground = new Graphics();
  app.stage.addChild(scenery, backdrop, world, foreground); world.addChild(surfaces, terrain, actors, figures, fx);
  let disposed = false, lastElapsed = 0;
  let city: Sprite | undefined, playerPortrait: Sprite | undefined, portraitFailed = false;
  const ready = { platforms: false, obstacles: false, hazards: false };
  const units = new Map<string, ReturnType<typeof makeSideviewSpine>>();
  const failures = new Set<string>();
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
    ready.platforms = true;
  });
  void loadScenery('cargo-barrier', '障碍箱', texture => {
    // Alpha > 100 bounds of the supplied image: transparent export padding is
    // excluded so the visible body occupies the simulation's collision box.
    const cropped = new Texture(texture.baseTexture, new Rectangle(54, 133, 1195, 913));
    for (const o of level.obstacles) {
      const box = new Sprite(cropped); box.position.set(o.x, o.y);
      box.width = o.width; box.height = o.height; surfaces.addChild(box);
    }
    ready.obstacles = true;
  });
  void loadScenery('crystal-hazard', '晶体危险带', texture => {
    const cropped = new Texture(texture.baseTexture, new Rectangle(7, 183, 2158, 403));
    for (const h of level.hazards) {
      const crystals = new Sprite(cropped);
      const visualHeight = Math.max(h.height, Math.min(48, h.width * 0.38));
      crystals.position.set(h.x, h.y + h.height - visualHeight);
      crystals.width = h.width; crystals.height = visualHeight; surfaces.addChild(crystals);
    }
    ready.hazards = true;
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
  const names = [{ id: 'player', name: operatorName }, ...level.enemies.map(e => ({ id: e.id, name: e.kind === 'ranger' ? '整合运动狙击手' : e.kind === 'elite' ? '整合运动盾卫' : '整合运动士兵' }))];
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
  function drawUnit(id: string, body: Body, dt: number, attacking: boolean, hurt: boolean, dead = false) {
    const unit = units.get(id);
    if (!unit) return false;
    const { spine, spec } = unit;
    spine.visible = !dead;
    if (dead) return true;
    const size = body.height * 1.35 / 420;
    spine.scale.set(size * body.facing, size);
    spine.position.set(body.x + body.width / 2, body.y + body.height - unit.bottom * size);
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

  let camera = 0;
  const resize = () => app.renderer.resize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight));
  const observer = new ResizeObserver(resize); observer.observe(host);
  function actor(g: Graphics, x: number, y: number, w: number, h: number, facing: number, color: number, hurt = false) {
    // Explicit tactical token when the local model is absent; never an imitation character.
    const cx = x + w / 2;
    g.beginFill(0x071b20, 0.95).lineStyle(2, hurt ? 0xffffff : color).drawRoundedRect(cx - 18, y + 8, 36, h - 8, 5).endFill();
    g.lineStyle(2, color).moveTo(cx - facing * 5, y + 25).lineTo(cx + facing * 8, y + 32).lineTo(cx - facing * 5, y + 39).lineStyle(0);
  }

  function render(s: Simulation) {
    const dt = Math.max(0, Math.min(0.1, s.elapsed - lastElapsed)); lastElapsed = s.elapsed;
    const width = app.screen.width, height = app.screen.height;
    // Keep the play plane at a useful vertical size on portrait devices.
    // Narrow screens see less of the world and track the player horizontally.
    const scale = height / 640;
    const vw = width / scale, vh = height / scale;
    const target = Math.max(0, Math.min(level.worldWidth - vw, s.player.x - vw * 0.36));
    camera += (target - camera) * (reducedMotion ? 1 : 0.12);
    const cy = Math.max(0, Math.min(level.worldHeight - vh + 30, s.player.y - vh * 0.55));
    world.scale.set(scale); world.position.set(-camera * scale, -cy * scale);
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
    terrain.clear();
    for (const p of level.platforms) {
      if (!ready.platforms) terrain.beginFill(C.stone).drawRect(p.x, p.y, p.width, p.height).endFill();
      terrain.beginFill(0x020c11, 0.24).drawRect(p.x, p.y + 4, p.width, Math.max(0, p.height - 4)).endFill();
      terrain.beginFill(0xb4d7d8, 0.85).drawRect(p.x, p.y, p.width, 2).endFill();
      terrain.beginFill(0x07171f, 0.8).drawRect(p.x, p.y + p.height - 2, p.width, 2).endFill();
    }
    for (const o of level.obstacles) {
      if (!ready.obstacles) terrain.beginFill(C.stone).drawRect(o.x, o.y, o.width, o.height).endFill();
      // The thin top rail identifies the full standable width, including the
      // open handles in the illustration, without painting over the artwork.
      terrain.lineStyle(1, C.orange, 0.7).moveTo(o.x, o.y).lineTo(o.x + o.width, o.y).lineStyle(0);
    }
    for (const h of level.hazards) {
      terrain.beginFill(C.red, 0.09).drawRect(h.x, h.y, h.width, h.height).endFill();
      if (!ready.hazards) {
        for (let x = h.x; x < h.x + h.width; x += 16) {
          const right = Math.min(x + 14, h.x + h.width);
          terrain.beginFill(C.red, 0.8).drawPolygon([x, h.y + h.height, (x + right) / 2, h.y, right, h.y + h.height]).endFill();
        }
      }
      // End ticks and a red baseline expose the exact dangerous interval.
      terrain.lineStyle(1.5, C.red, 0.9).moveTo(h.x, h.y).lineTo(h.x, h.y + h.height)
        .lineTo(h.x + h.width, h.y + h.height).lineTo(h.x + h.width, h.y).lineStyle(0);
    }
    const goal = level.goal, unlocked = !exitLocked(s, level);
    if (!unlocked) {
      const gateX = exitBarrierX(level);
      terrain.beginFill(C.cyan, 0.15).drawRect(gateX, 0, 24, level.worldHeight).endFill();
      terrain.lineStyle(2, C.cyan, 0.8).moveTo(gateX, 0).lineTo(gateX, level.worldHeight)
        .moveTo(gateX + 24, 0).lineTo(gateX + 24, level.worldHeight).lineStyle(0);
      for (let y = 16; y < level.worldHeight; y += 42) {
        terrain.lineStyle(2, C.cyan, 0.45).moveTo(gateX + 3, y).lineTo(gateX + 21, y + 18).lineStyle(0);
      }
    }
    terrain.lineStyle(4, unlocked ? C.cyan : 0x71858b).drawRect(goal.x, goal.y, goal.width, goal.height).lineStyle(0);
    terrain.beginFill(unlocked ? C.cyan : 0x40545e, unlocked ? 0.17 : 0.12).drawRect(goal.x + 5, goal.y + 5, goal.width - 10, goal.height - 5).endFill();
    terrain.lineStyle(3, unlocked ? C.cyan : 0x71858b).moveTo(goal.x + 30, goal.y + 45).lineTo(goal.x + 62, goal.y + 62).lineTo(goal.x + 30, goal.y + 80).lineStyle(0);
    actors.clear();
    for (const e of s.enemies) {
      if (e.hp <= 0) { drawUnit(e.id, e, dt, false, false, true); continue; }
      const spec = level.enemies.find(v => v.id === e.id)!;
      if (!drawUnit(e.id, e, dt, e.windup > 0, e.hurt > 0)) actor(actors, e.x, e.y, e.width, e.height, e.facing, C.orange, e.hurt > 0);
      actors.beginFill(0x0a141c).drawRect(e.x - 5, e.y - 17, e.width + 10, 4).endFill();
      actors.beginFill(C.orange).drawRect(e.x - 5, e.y - 17, (e.width + 10) * e.hp / spec.hp, 4).endFill();
      if (e.windup > 0) {
        actors.lineStyle(2, C.orange, 0.85).drawCircle(e.x + e.width / 2, e.y - 34, 9).moveTo(e.x + e.width / 2, e.y - 39).lineTo(e.x + e.width / 2, e.y - 32).lineStyle(0);
        actors.beginFill(C.orange).drawCircle(e.x + e.width / 2, e.y - 28, 1.5).endFill();
      }
    }
    const p = s.player;
    if (!drawUnit('player', p, dt, p.attackTime > 0, p.invulnerable > 0 && Math.floor(s.elapsed * 16) % 2 === 1)) {
      if (playerPortrait) {
        const size = p.height * 1.5 / playerPortrait.texture.height;
        playerPortrait.visible = true;
        playerPortrait.scale.set(size * p.facing, size);
        playerPortrait.position.set(p.x + p.width / 2, p.y + p.height + 2);
        playerPortrait.tint = p.invulnerable > 0 && Math.floor(s.elapsed * 16) % 2 === 1 ? 0xffd5a9 : 0xffffff;
      } else if (operatorName !== '临光' || portraitFailed) actor(actors, p.x, p.y, p.width, p.height, p.facing, C.cyan, p.invulnerable > 0 && Math.floor(s.elapsed * 16) % 2 === 1);
    } else if (playerPortrait) playerPortrait.visible = false;
    fx.clear();
    for (const b of s.projectiles) fx.beginFill(C.orange).drawRect(b.x, b.y, b.width, b.height).endFill();
    for (const e of s.effects) {
      const alpha = Math.min(1, e.life * 3);
      if (e.kind === 'slash') {
        fx.lineStyle(5, 0xe1ffff, alpha).arc(e.x, e.y, 71, e.facing > 0 ? -1.2 : 1.9, e.facing > 0 ? 1.2 : 4.3).lineStyle(0);
      } else if (e.kind === 'skill' || e.kind === 'support') {
        const r = e.kind === 'skill' ? (1 - e.life / 0.65) * 230 : (1 - e.life) * 390;
        fx.lineStyle(e.kind === 'skill' ? 5 : 2, e.kind === 'skill' ? C.cyan : 0xbde6a0, alpha).drawEllipse(e.x, e.y, r, r * 0.6).lineStyle(0);
        fx.beginFill(C.cyan, alpha * 0.05).drawCircle(e.x, e.y, r).endFill();
      } else if (e.kind === 'dash') fx.beginFill(C.cyan, alpha * 0.25).drawRect(e.x, e.y + 10, 30, 45).endFill();
      else for (let n = 0; n < 6; n++) { const a = n * Math.PI / 3; const r = (0.3 - e.life) * 150; fx.lineStyle(2, C.orange, alpha).moveTo(e.x + Math.cos(a) * r, e.y + Math.sin(a) * r).lineTo(e.x + Math.cos(a) * (r + 10), e.y + Math.sin(a) * (r + 10)).lineStyle(0); }
    }
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
    app.renderer.render(app.stage);
  }
  return { render, destroy() { disposed = true; observer.disconnect(); app.destroy(true, { children: true }); } };
}
