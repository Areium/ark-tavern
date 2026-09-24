import { Application, Container, Graphics } from 'pixi.js';
import type { Simulation, SimulationLevel } from './types';

const C = { sky: 0x0b1722, far: 0x142735, mid: 0x1c3541, stone: 0x243b43, edge: 0x718b8e, cyan: 0x8ce5e0, orange: 0xf4a66b, red: 0xe77977 };

/** Original vector scenery. No external textures or asset requests. */
export function createRenderer(host: HTMLDivElement, level: SimulationLevel, reducedMotion: boolean) {
  const app = new Application({ width: host.clientWidth || 1000, height: host.clientHeight || 600, backgroundColor: C.sky, antialias: true, resolution: Math.min(devicePixelRatio || 1, 2), autoDensity: true, autoStart: false });
  const canvas = app.view as HTMLCanvasElement;
  canvas.setAttribute('aria-hidden', 'true'); host.appendChild(canvas);
  const scenery = new Graphics(); const world = new Container();
  const terrain = new Graphics(); const actors = new Graphics(); const fx = new Graphics(); const foreground = new Graphics();
  app.stage.addChild(scenery, world, foreground); world.addChild(terrain, actors, fx);
  let camera = 0;
  const resize = () => app.renderer.resize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight));
  const observer = new ResizeObserver(resize); observer.observe(host);
  function actor(g: Graphics, x: number, y: number, w: number, h: number, facing: number, color: number, phase: number, enemy = false, hurt = false) {
    const cx = x + w / 2; const headY = y + h * 0.16;
    const stride = Math.sin(phase) * 7;
    g.beginFill(0x02080d, 0.3).drawEllipse(cx, y + h + 2, w * 0.85, 5).endFill();
    g.lineStyle(7, hurt ? 0xffffff : 0x0a1821).moveTo(cx - 6, y + h * 0.68).lineTo(cx - 8 + stride, y + h - 1).moveTo(cx + 6, y + h * 0.68).lineTo(cx + 8 - stride, y + h - 1);
    g.lineStyle(0).beginFill(hurt ? 0xffffff : enemy ? 0x36424a : 0xcedee0);
    g.drawPolygon([cx - 10, y + h * 0.31, cx + 10, y + h * 0.31, cx + 17 - facing * 4, y + h * 0.82, cx - 17 - facing * 7, y + h * 0.82]).endFill();
    g.beginFill(enemy ? 0x19262e : 0x253d49).drawRect(cx - 9, y + h * 0.36, 18, h * 0.24).endFill();
    g.beginFill(hurt ? 0xffffff : 0xa1b6b9).drawRoundedRect(cx - 10, headY - 6, 20, 18, 4).endFill();
    g.beginFill(0x101f2a).drawRect(cx - 10, headY, 20, 8).endFill();
    g.beginFill(color).drawRect(cx + (facing > 0 ? 1 : -9), headY + 1, 8, 3).drawRect(cx - 9, y + h * 0.57, 18, 3).endFill();
    g.lineStyle(3, color, 0.9).moveTo(cx + facing * 10, y + h * 0.43).lineTo(cx + facing * 29, y + h * 0.79);
    if (!enemy) {
      g.lineStyle(0).beginFill(C.cyan, 0.85).drawPolygon([cx - facing * 8, y + h * 0.28, cx - facing * 37, y + h * 0.37 + Math.sin(phase) * 3, cx - facing * 21, y + h * 0.46]).endFill();
      g.beginFill(0xcedee0).drawPolygon([cx - 9, headY - 3, cx - 8, headY - 16, cx - 2, headY - 4]).endFill();
    }
    g.lineStyle(0);
  }
  function render(s: Simulation) {
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
    // Distant break in the cloud deck, behind a layered industrial skyline.
    scenery.beginFill(0x40606a, 0.16).drawEllipse(vw * 0.69, 160, 270, 95).endFill();
    scenery.beginFill(0x87b2b7, 0.1).drawEllipse(vw * 0.69, 145, 115, 65).endFill();
    for (let layer = 0; layer < 3; layer++) {
      const spacing = layer === 0 ? 155 : 225;
      const parallax = [0.12, 0.26, 0.48][layer];
      for (let i = -2; i < Math.ceil(vw / spacing) + 3; i++) {
        const index = i + Math.floor(camera * parallax / spacing);
        const x = i * spacing - (camera * parallax % spacing);
        const top = 160 + ((index * 73 + 711) % 170) + layer * 38;
        const bw = 70 + ((index * 31 + 201) % 75);
        scenery.beginFill([C.far, C.mid, 0x122934][layer]).drawRect(x, top, bw, vh - top).endFill();
        scenery.lineStyle(2, 0x547780, layer === 2 ? 0.22 : 0.1).moveTo(x + 8, top).lineTo(x + 8, vh).moveTo(x + bw - 8, top).lineTo(x + bw - 8, vh).lineStyle(0);
        if (layer < 2) for (let row = 0; row < 4; row++) scenery.beginFill(0xb2d9d5, 0.12).drawRect(x + 18, top + 22 + row * 35, 4, 10).endFill();
        if (layer === 1) scenery.lineStyle(3, 0x36505a).moveTo(x + 20, top).lineTo(x + 20, top - 45).lineTo(x + 110, top - 45).lineStyle(0);
      }
    }
    terrain.clear();
    for (const p of level.platforms) {
      terrain.beginFill(C.stone).drawRect(p.x, p.y, p.width, p.height).endFill();
      terrain.beginFill(C.edge).drawRect(p.x, p.y, p.width, 3).endFill();
      terrain.beginFill(0x0a1a24).drawRect(p.x, p.y + 13, p.width, Math.max(3, p.height - 13)).endFill();
      for (let x = p.x + 16; x < p.x + p.width; x += 85) terrain.lineStyle(1, 0x35505b).moveTo(x, p.y + 18).lineTo(x + 28, p.y + p.height).lineStyle(0);
    }
    for (const o of level.obstacles) {
      terrain.beginFill(0x344951).drawRect(o.x, o.y, o.width, o.height).endFill();
      terrain.lineStyle(2, 0x617477).drawRect(o.x + 5, o.y + 5, o.width - 10, o.height - 10).moveTo(o.x + 5, o.y + 5).lineTo(o.x + o.width - 5, o.y + o.height - 5).lineStyle(0);
      terrain.beginFill(C.orange, 0.8).drawRect(o.x + 9, o.y + 8, 18, 4).endFill();
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
      if (e.hp <= 0) continue;
      const spec = level.enemies.find(v => v.id === e.id)!;
      actor(actors, e.x, e.y, e.width, e.height, e.facing, C.orange, s.elapsed * (Math.abs(e.vx) > 1 ? 9 : 0), true, e.hurt > 0);
      actors.beginFill(0x0a141c).drawRect(e.x - 5, e.y - 17, e.width + 10, 4).endFill();
      actors.beginFill(C.orange).drawRect(e.x - 5, e.y - 17, (e.width + 10) * e.hp / spec.hp, 4).endFill();
      if (e.windup > 0) {
        actors.lineStyle(2, C.orange, 0.85).drawCircle(e.x + e.width / 2, e.y - 34, 9).moveTo(e.x + e.width / 2, e.y - 39).lineTo(e.x + e.width / 2, e.y - 32).lineStyle(0);
        actors.beginFill(C.orange).drawCircle(e.x + e.width / 2, e.y - 28, 1.5).endFill();
      }
    }
    const p = s.player;
    actor(actors, p.x, p.y, p.width, p.height, p.facing, C.cyan, s.elapsed * (Math.abs(p.vx) > 20 ? 14 : 0), false, p.invulnerable > 0 && Math.floor(s.elapsed * 16) % 2 === 1);
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
  return { render, destroy() { observer.disconnect(); app.destroy(true, { children: true }); } };
}
