import type { Rect, SceneProp, SimulationLevel } from './types';

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** Stable, bounded street dressing derived from existing geometry, without changing the level contract. */
export function createSceneProps(level: SimulationLevel): SceneProp[] {
  const props: SceneProp[] = [];
  for (const [index, floor] of level.platforms.entries()) {
    if (floor.width < 140) continue;
    for (let x = floor.x + 170; x < floor.x + floor.width - 48; x += 310) {
      if (props.length >= 32) return props;
      const kind = (index + Math.floor((x - floor.x) / 310)) % 2 === 0 ? 'canister' : 'lamp';
      const width = kind === 'lamp' ? 22 : 28, height = kind === 'lamp' ? 64 : 34;
      const prop: SceneProp = { id: `street-${index}-${x}`, kind, x, y: floor.y - height, width, height, broken: false };
      const clearance = { x: prop.x - 12, y: prop.y, width: width + 24, height: height + 2 };
      if (prop.x < 0 || prop.x + width > level.worldWidth || prop.y < 0 || floor.y > level.worldHeight) continue;
      if (level.obstacles.some(r => intersects(clearance, r)) || level.hazards.some(r => intersects(clearance, r))) continue;
      if (level.platforms.some(r => r !== floor && intersects(prop, r))) continue;
      if (intersects(clearance, level.goal) || intersects(clearance, { ...level.spawn, width: 48, height: 64 })) continue;
      props.push(prop);
    }
  }
  return props;
}
