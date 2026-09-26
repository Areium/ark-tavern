import { Graphics } from 'pixi.js';
import type { Effect, Simulation, SimulationLevel } from './types';

/** Bounded geometry only: no particle objects, textures or per-frame allocations. */
export function drawStreetStructure(g: Graphics, level: SimulationLevel) {
  for (const p of level.platforms) {
    if (p.width < 180 || p.oneWay) continue;
    for (let x = p.x + 95; x < p.x + p.width - 40; x += 510) {
      const y = p.y;
      g.lineStyle(6, 0x142b34).moveTo(x, y).lineTo(x, y - 166).lineTo(x + 38, y - 174);
      g.lineStyle(1, 0x638089, 0.5).moveTo(x - 2, y - 8).lineTo(x - 2, y - 164);
      g.lineStyle(0).beginFill(0xd9c394, 0.85).drawRect(x + 27, y - 176, 24, 4).endFill();
      g.beginFill(0xe9c58c, 0.035).drawPolygon([x + 26, y - 170, x + 52, y - 170, x + 109, y, x - 33, y]).endFill();
      g.lineStyle(1.5, 0x08171f, 0.85).moveTo(x, y - 158).quadraticCurveTo(x + 180, y - 107, x + 390, y - 184).lineStyle(0);
      // A broken concrete footing, low enough to leave the collision plane legible.
      g.beginFill(0x142830).drawPolygon([x - 18, y, x - 12, y - 14, x + 7, y - 19, x + 18, y]).endFill();
    }
  }
}

export function drawStreetSurface(g: Graphics, s: Simulation, level: SimulationLevel, reduced: boolean) {
  g.clear();
  const time = reduced ? 0 : s.elapsed;
  for (const p of level.platforms) {
    if (p.width < 130) continue;
    // Broken horizontal light reflections read as wet stone without obscuring its top rail.
    for (let n = 0; n < Math.min(12, Math.floor(p.width / 54)); n++) {
      const x = p.x + 18 + n * 51;
      const w = Math.min(24 + (n * 17 % 29), p.x + p.width - x - 4);
      const a = 0.07 + 0.025 * Math.sin(time * 1.8 + n * 2);
      g.beginFill(n % 3 ? 0x9cc6cd : 0xe5c192, a).drawEllipse(x + w / 2, p.y + 5 + n % 3 * 3, w / 2, 1.2).endFill();
    }
  }
  for (let i = -1; i < s.enemies.length; i++) {
    const b = i < 0 ? s.player : s.enemies[i];
    if (b.hp <= 0) continue;
    let floorY = Infinity;
    for (let j = 0; j < level.platforms.length + level.obstacles.length; j++) {
      const p = j < level.platforms.length ? level.platforms[j] : level.obstacles[j - level.platforms.length];
      if (b.x + b.width > p.x && b.x < p.x + p.width && p.y >= b.y + b.height - 3) floorY = Math.min(floorY, p.y);
    }
    const distance = Math.max(0, floorY - b.y - b.height);
    if (distance > 230) continue;
    g.beginFill(0x030e15, 0.25 * (1 - distance / 230)).drawEllipse(b.x + b.width / 2, floorY + 3, Math.max(8, b.width * 0.7 - distance / 18), 3).endFill();
  }
}

export function drawStreetProps(g: Graphics, s: Simulation) {
  g.clear();
  for (const p of s.props) {
    const cx = p.x + p.width / 2, bottom = p.y + p.height;
    if (p.broken) {
      g.beginFill(0x273b42).drawPolygon([p.x - 3, bottom, p.x + 3, bottom - 7, cx, bottom - 3, cx + 7, bottom - 9, p.x + p.width + 4, bottom]).endFill();
      g.lineStyle(1, p.kind === 'lamp' ? 0x79979e : 0xa77d57, 0.7).moveTo(p.x + 2, bottom - 4).lineTo(cx - 3, bottom - 7).lineStyle(0);
      continue;
    }
    if (p.kind === 'canister') {
      g.lineStyle(1, 0x789091, 0.8).beginFill(0x344c50).drawRoundedRect(p.x, p.y, p.width, p.height, 3).endFill().lineStyle(0);
      g.beginFill(0xca995a, 0.9).drawRect(p.x + 1, p.y + p.height * 0.3, p.width - 2, 5).endFill();
      g.beginFill(0x0c232b).drawRect(cx - 3, p.y - 3, 6, 4).endFill();
      g.lineStyle(1, 0xaec6c5, 0.45).moveTo(p.x + 4, p.y + 4).lineTo(p.x + 4, bottom - 5).lineStyle(0);
    } else {
      g.lineStyle(3, 0x527078).moveTo(cx, bottom).lineTo(cx, p.y + 5).lineStyle(0);
      g.beginFill(0xe0d4a3, 0.07).drawCircle(cx, p.y + 7, 24).endFill();
      g.lineStyle(1, 0x8b9e98).beginFill(0xf0d89d).drawRect(p.x, p.y, p.width, Math.min(12, p.height)).endFill().lineStyle(0);
      g.beginFill(0xf0d89d, 0.14).drawEllipse(cx, bottom + 3, 23, 2).endFill();
    }
  }
}

export function drawContactEffect(g: Graphics, e: Effect, reduced: boolean): boolean {
  const contact = e.kind === 'step' || e.kind === 'land' || e.kind === 'jump';
  const fragments = e.kind === 'debris' || e.kind === 'spark';
  if (!contact && !fragments) return false;
  const duration = e.kind === 'step' ? 0.28 : e.kind === 'land' ? 0.4 : e.kind === 'jump' ? 0.3 : e.kind === 'debris' ? 0.65 : 0.5;
  const t = Math.max(0, Math.min(1, 1 - e.life / duration));
  const alpha = (1 - t) * (1 - t);
  const power = e.kind === 'land' ? 0.6 + (e.value ?? 0) : 0.6;
  if (contact) {
    const spread = reduced ? 12 : 9 + t * 35 * power;
    g.lineStyle(1.2, 0xbadce0, alpha * 0.65).drawEllipse(e.x, e.y + 2, spread, Math.max(1, spread * 0.13)).lineStyle(0);
    if (!reduced) for (let n = 0; n < (e.kind === 'land' ? 8 : 4); n++) {
      const side = n % 2 ? 1 : -1;
      const x = e.x + side * (6 + t * (19 + n * 5) * power);
      const y = e.y - Math.sin(t * Math.PI) * (8 + n * 2) * power;
      g.lineStyle(1.3, 0xbadce0, alpha * 0.8).moveTo(x, y).lineTo(x - side * 2, y + 3).lineStyle(0);
    }
  } else {
    const lamp = e.kind === 'spark' || e.value === 1;
    const count = reduced ? 3 : 9;
    for (let n = 0; n < count; n++) {
      const a = n * 2.4, travel = reduced ? 8 : t * (24 + n * 5);
      const x = e.x + Math.cos(a) * travel, y = e.y + Math.sin(a) * travel + (reduced ? 0 : t * t * 42);
      g.beginFill(lamp ? 0xffdb91 : n % 2 ? 0x90abad : 0xbe976d, alpha).drawRect(x, y, lamp ? 2 : 4, lamp ? 3 : 3).endFill();
    }
  }
  return true;
}
