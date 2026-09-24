import { Application, Container, Graphics, Texture, TilingSprite, Sprite, Rectangle, SCALE_MODES } from 'pixi.js';
import type { Simulation, SimulationLevel, Body } from './types';
import { loadSideviewSpine, makeSideviewSpine } from './spineActors';

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
  const layers: TilingSprite[] = [];
  const units = new Map<string, ReturnType<typeof makeSideviewSpine>>();
  const failures = new Set<string>();
  const report = () => onAssets(failures.size ? `简化显示：${[...failures].join('、')}；操作不受影响。` : '');
  const sceneryFiles = ['industrial-bg', 'industrial-far', 'industrial-mid', 'industrial-near'];
  backdrop.sortableChildren = true;
  // Keep the original layer indices even if one asset fails or finishes late.
  Promise.allSettled(sceneryFiles.map(async (name, i) => {
    const texture = await Texture.fromURL(`./assets/sideview/${name}.png`);
    if (disposed) return;
    texture.baseTexture.scaleMode = SCALE_MODES.NEAREST;
    const layer = new TilingSprite(texture, 1, 1);
    layer.alpha = [0.85, 0.55, 0.72, 0.95][i];
    layer.zIndex = i;
    backdrop.addChild(layer); layers[i] = layer;
  })).then(results => {
    if (!disposed && results.some(result => result.status === 'rejected')) {
      failures.add('部分厂区背景'); report();
    }
  });
  Texture.fromURL('./assets/sideview/metal-tiles.png').then(texture => {
    if (disposed) return;
    texture.baseTexture.scaleMode = SCALE_MODES.NEAREST;
    const plate = new Texture(texture.baseTexture, new Rectangle(0, 0, 18, 18));
    const rail = new Texture(texture.baseTexture, new Rectangle(0, 96, 18, 18));
    const crate = new Texture(texture.baseTexture, new Rectangle(0, 191, 18, 18));
    for (const p of level.platforms) {
      const body = new TilingSprite(rail, p.width, p.height); body.position.set(p.x, p.y); body.tileScale.set(2); body.tint = 0x6a8783; surfaces.addChild(body);
      const rim = new TilingSprite(plate, p.width, Math.min(p.height, 12)); rim.position.set(p.x, p.y); rim.tileScale.set(1.3); rim.tint = 0xa3b2a2; surfaces.addChild(rim);
    }
    for (const o of level.obstacles) { const box = new Sprite(crate); box.position.set(o.x, o.y); box.width = o.width; box.height = o.height; box.tint = 0xb9b2a0; surfaces.addChild(box); }
  }).catch(() => { if (!disposed) { failures.add('金属纹理'); report(); } });
  const names = [{ id: 'player', name: operatorName }, ...level.enemies.map(e => ({ id: e.id, name: e.kind === 'ranger' ? '整合运动狙击手' : e.kind === 'elite' ? '整合运动盾卫' : '整合运动士兵' }))];
  const cache = new Map<string, ReturnType<typeof loadSideviewSpine>>();
  onAssets('正在装载战斗模型…');
  Promise.all(names.map(async ({ id, name }) => {
    try {
      if (!cache.has(name)) cache.set(name, loadSideviewSpine(name));
      const data = await cache.get(name)!;
      if (disposed) return;
      const unit = makeSideviewSpine(data); units.set(id, unit); figures.addChild(unit.spine);
    } catch { if (!disposed) failures.add(name); }
  })).then(() => { if (!disposed) report(); });
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
    layers.forEach((layer, i) => {
      const textureScale = height / 160;
      layer.width = width; layer.height = layer.texture.height * textureScale;
      layer.y = height - layer.height;
      layer.tileScale.set(textureScale);
      layer.tilePosition.set(-camera * scale * [0.06, 0.13, 0.27, 0.46][i], 0);
    });
    terrain.clear();
    for (const p of level.platforms) {
      if (!surfaces.children.length) terrain.beginFill(C.stone).drawRect(p.x, p.y, p.width, p.height).endFill();
      terrain.beginFill(0xc3d9c5, 0.75).drawRect(p.x, p.y, p.width, 2).endFill();
      terrain.beginFill(0x020c11, 0.5).drawRect(p.x, p.y + 13, p.width, Math.max(0, p.height - 13)).endFill();
      for (let x = p.x + 12; x < p.x + p.width - 8; x += 96) terrain.beginFill(C.cyan, 0.8).drawRect(x, p.y + 5, 14, 2).endFill();
    }
    for (const o of level.obstacles) {
      if (!surfaces.children.length) terrain.beginFill(C.stone).drawRect(o.x, o.y, o.width, o.height).endFill();
      terrain.beginFill(C.orange, 0.85).drawRect(o.x + 8, o.y + 6, 22, 3).endFill();
    }
    for (const h of level.hazards) {
      terrain.beginFill(C.red, 0.22).drawRect(h.x, h.y, h.width, h.height).endFill();
      for (let x = h.x; x < h.x + h.width; x += 16) terrain.beginFill(C.red, 0.8).drawPolygon([x, h.y + h.height, x + 7, h.y - 4, x + 14, h.y + h.height]).endFill();
    }
    const goal = level.goal, unlocked = s.enemies.every(e => e.hp <= 0);
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
    if (!drawUnit('player', p, dt, p.attackTime > 0, p.invulnerable > 0 && Math.floor(s.elapsed * 16) % 2 === 1)) actor(actors, p.x, p.y, p.width, p.height, p.facing, C.cyan, p.invulnerable > 0 && Math.floor(s.elapsed * 16) % 2 === 1);
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
