import type { SideviewLevel, SimulationLevel, SideviewOperator } from './types';

export const DEMO_OPERATOR: SideviewOperator = { name: '临光', maxHp: 120, attack: 26, skillPower: 65 };
const demo: SimulationLevel = {
  id: 'outskirts-01', name: '废城边界 · 雨幕行动', worldWidth: 3400, worldHeight: 680,
  spawn: { x: 110, y: 490 },
  platforms: [
    { x: 0, y: 550, width: 1180, height: 130 }, { x: 1360, y: 550, width: 2040, height: 130 },
    { x: 530, y: 425, width: 210, height: 24 }, { x: 940, y: 390, width: 210, height: 24 },
    { x: 1180, y: 440, width: 180, height: 24 }, { x: 1710, y: 420, width: 220, height: 24 },
    { x: 2230, y: 395, width: 240, height: 24 },
  ],
  obstacles: [{ x: 390, y: 482, width: 70, height: 68 }, { x: 1570, y: 490, width: 75, height: 60 }, { x: 2040, y: 470, width: 80, height: 80 }],
  hazards: [{ x: 810, y: 534, width: 100, height: 16 }, { x: 1180, y: 650, width: 180, height: 30 }, { x: 2490, y: 534, width: 140, height: 16 }],
  enemies: [
    { id: 'g1', kind: 'guard', x: 660, y: 490, patrolMin: 480, patrolMax: 780, hp: 60 },
    { id: 'g2', kind: 'ranger', x: 1020, y: 330, patrolMin: 960, patrolMax: 1100, hp: 50 },
    { id: 'g3', kind: 'guard', x: 1840, y: 490, patrolMin: 1660, patrolMax: 2010, hp: 75 },
    { id: 'g4', kind: 'ranger', x: 2350, y: 335, patrolMin: 2250, patrolMax: 2420, hp: 55 },
    { id: 'g5', kind: 'elite', x: 2940, y: 478, patrolMin: 2710, patrolMax: 3110, hp: 150 },
  ],
  goal: { x: 3230, y: 426, width: 100, height: 124 },
  victoryCondition: 'clear_and_exit',
};

export const DEMO_LEVEL: SideviewLevel = {
  schemaVersion: 1, id: demo.id, name: demo.name, width: demo.worldWidth, height: demo.worldHeight,
  platforms: demo.platforms, obstacles: demo.obstacles, hazards: demo.hazards.map(h => ({ ...h, damage: 20 })),
  spawn: demo.spawn, exit: demo.goal, victoryCondition: demo.victoryCondition, rewards: { xp: 60, items: [] },
  enemies: demo.enemies.map(e => ({ ...e, name: e.kind === 'elite' ? '重装守卫' : e.kind === 'ranger' ? '弩手' : '巡逻兵', damage: e.kind === 'elite' ? 24 : 15, speed: 105, range: e.kind === 'ranger' ? 500 : 82 })),
};

export function normalizeLevel(level: SideviewLevel): SimulationLevel {
  return { id: level.id, name: level.name, worldWidth: level.width, worldHeight: level.height, platforms: level.platforms, obstacles: level.obstacles, hazards: level.hazards, spawn: level.spawn, goal: level.exit, victoryCondition: level.victoryCondition ?? 'clear_and_exit',
    enemies: level.enemies.map(e => ({ ...e, kind: e.kind ?? 'guard', patrolMin: e.patrolMin ?? Math.max(0, e.x - 120), patrolMax: e.patrolMax ?? Math.min(level.width - 50, e.x + 120) })) };
}
