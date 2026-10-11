# 战斗规格（Battle Spec）

> 面向：人类设计者、以及**生成战斗内容的 LLM/代理**。
> 权威实现：`src/combat_map.py`（地图）、`src/combat_nodes.py`（校验）、
> `src/combat_balance.py`（威胁模型）；节点存放在完整世界书的 `combat/nodes/`。
> 配套工具：`tools/validate_battle_spec.py`（校验）、`tools/simulate_battle.py`（试跑）、
> `tools/balance_audit.py`（全局数值审计）；流程规范见 skill `combat-designer`。

> 最近核对：2026-10-11（`7344cea` 的节点校验、地图、加载器、威胁模型与 CLI 源码；未执行模拟、内容入库或模型生成）。

一场战斗由 **一个 JSON 节点文件** `data/worldbooks/books/<book_id>/combat/nodes/<node_id>.json` 描述，可由作者或程序生成，也可编码为世界书条目分发（见文末）。节点包含地图编排、敌人引用与数值覆盖；只有通过 `enemies_def`、`map.tile_defs` 内联所有需要的敌人与自定义格子定义时，战场编排才可自包含。仅引用敌人、外置地形或背景资源时，仍依赖完整世界书提供这些内容；节点本身也不携带玩家角色与职业卡组。

---

## 1. 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema_version` | int | 否 | 目前恒为 1 |
| `node_id` | string | ✅ | 唯一 id；允许中英文/数字/`_`/`-`，≤64 字符；**与文件名一致**（作者命名约定；校验器不核对候选文件名） |
| `name` | string | ✅ | 显示名（前端下拉、战前卡片、结算播报用） |
| `summary` | string | 否 | 一句话处境，显示在战前卡片 |
| `description` | string | 否 | 更长的 markdown 背景（设计者/LLM 备注） |
| `worldbook_id` | string | 保存时需要 | 已安装且启用的所属书 ID；加载时由实际路径写入，不能借此越过会话绑定范围 |
| `approaches` | array | 否 | 战前打法；影响检定、奖励倍率和战斗参数，见[战斗集成](combat-design.md#9-遭遇战与战斗触发) |
| `bind` | object | 否 | 剧情节拍绑定：`{plot_id, chapter_id, beat_id}`；剧情文档里用 `[COMBAT:<node_id>]` 引用 |
| `rules` | object | 否 | `{range_metric: "manhattan"\|"chebyshev", allow_corner_cut: bool}`，默认曼哈顿 + 禁止切角 |
| `map` | object | ✅ | 战场（第 2 节） |
| `waves` | array | ✅ | 波次（第 3 节）；至少 1 个敌人，否则开战会被拒绝 |
| `enemies_def` | object | 否 | 内联敌人定义（`{名字: {combat_stats, ai_behavior, ai_skills, attributes...}}`），优先于同名会话自定义敌人及绑定书敌人；可用于自包含战场编排 |
| `conditions` | object | 否 | `{max_rounds: int, escape_enabled: bool}`；开战默认 0（不限回合）和 false（不可撤退） |
| `rewards` | object | 否 | `{xp: int, items: [string], unlock: [string]}` |
| `difficulty` | object | 否 | `{category, encounter_type, band, threat_budget, target_rounds, difficulty, apply_band_scaling}` |
| `background` | string | 否 | 书内背景 ID；实际选择还受会话覆盖与地点影响，缺资源时可回退程序化背景 |
| `balance_version` | int | 否 | 目前为 1 |

`difficulty.band` 取 `T0–T4`；`encounter_type` 取 `teaching | normal | elite | boss`；
`category` 取 `story | test | event`。**这些字段参与数值审计**：审计工具会用它们的参考区间
判断你的编排是否与声称的难度一致。

---

## 2. 地图 `map`

```jsonc
"map": {
  "rows": 9, "cols": 12,                 // 1..40，且 rows*cols ≤ 1200
  "tiles": "ground",                     // 简写：整图同一格类型
  // 或二维数组（每格一个 tile_id）：
  // "tiles": [["ground","wall"],["cover","ground"]],
  "tile_defs": {                         // 内联格子定义（覆盖全局注册表）
    "wall":  { "blocks_movement": true, "blocks_los": true },
    "cover": { "name": "掩体", "glyph": "H", "color": "#a16207",
               "defense_bonus": 2, "evasion_bonus": 1 }
  },
  "deploy": {                            // 缺省按左右三分之一推导
    "player": { "rect": [3, 0, 5, 1] },  // 矩阵对角（含端点）[r0,c0,r1,c1]
    "enemy":  { "cells": [[3, 5], [5, 5]] },  // 或显式坐标
    "enemy_random_shift": false          // true = 敌人落点在部署区内随机
  }
}
```

**格子可用字段**（未知字段只警告、不报错，便于扩展）：

| 字段 | 默认 | 作用 |
|---|---|---|
| `blocks_movement` | false | 不可通行（墙） |
| `blocks_los` | false | 阻挡视线（远程攻击需视线；起点/终点所在格不参与判定） |
| `move_cost` | 1 | 通行代价（斜向步 = ×2） |
| `defense_bonus` / `evasion_bonus` | 0 | 站在此格受到的减伤 / 加闪避 |
| `damage_bonus` | 0 | 站在此格攻击的加伤（高台） |
| `on_enter` / `on_round_start` | `{}` | `{damage, heal, status, stacks}`；`status` 取 shield/slow/bind/weaken/strengthen/silence/burn/taunt/evade/blind |
| `glyph` / `color` / `name` | — | 前端渲染与悬停提示 |
| `deployable_player` / `deployable_enemy` | true | 是否允许部署（预留） |

内置格子：`ground`、`wall`、`cover`、`high_ground`、`hazard_fire`；项目可在
`data/worldbooks/books/<book_id>/combat/tiles/*.json` 追加（字段同上 + `tile_id`）。

**地形设计要点**：墙用来切分战场与挡视线；掩体给防守支点；火场逼走位；高台奖励抢点。
不要用墙把两个部署区完全隔开。校验器给出 `玩家部署区与敌人部署区之间不存在通路` **警告**，不会阻止保存；作者仍须排除软锁。

---

## 3. 波次 `waves`

```jsonc
"waves": [
  { "enemies": [
      { "enemy": "整合运动士兵", "count": 2, "positions": [[3,5],[5,5]] },
      { "enemy": "山雪鬼队长", "count": 1, "positions": [[4,6]],
        "stats": { "hp": 220 } }        // 逐单位数值覆盖（绝对值，覆盖文件数值）
  ] },
  { "enemies": [ { "enemy": "冰原术师", "count": 1 } ] }   // 第 2 波：清空第 1 波后入场
]
```

- 每项 `count` 为 1–12，且每波累计单位数 ≤12；波次 ≤6；敌人总数 ≤48。
- `positions` 个数与 `count` 不一致时只警告（缺的会落到敌方部署区空格）；
  站位必须在地图内且不在阻挡格，否则报错。
- `stats` 可覆盖 `hp/patk/matk/defense/resist/spd/hit/eva/max_ap`
  （外加 `ai_behavior`/`ai_skills`/`action_slots`/`threat_points`）。
- 第 2 波及以后的入场格被占时尝试最近空格，不覆盖已有单位；无可落脚点时不能保证全部单位入场。开战加载也会跳过无法放置或无法加载的敌人；若所有波次均无可出场单位则拒绝开战。

**敌人来源优先级**：`enemies_def` 内联 → 会话自定义敌人 → 当前会话绑定书的 `enemies/*.md`。
绑定书敌人条目只有叙事 `attributes` 而没有 `combat_stats` 时，战斗数值按属性派生。

---

## 4. 威胁与阶段带（生成时的数值锚点）

五类模板（`src/combat_balance.py`）：

| 模板 | 相对生命 | 相对输出 | 威胁点 | 行动槽 |
|---|---:|---:|---:|---:|
| minion | 0.675 | 0.725 | 1.0 | 1 |
| standard | 1.000 | 1.000 | 1.6 | 1 |
| strong | 1.375 | 1.175 | 2.2 | 1 |
| elite | 1.800 | 1.250 | 3.2 | 2 |
| boss | 4.250 | 1.350 | 7.0 | 2 |

相对生命 = `hp / 100`；相对输出 = `(0.5×patk + 7.5) / 20`。分类取最近邻；
敌人条目声明了 `role`/`power_tier` 时以声明为准。

阶段带参考区间（`data/worldbooks/books/<book_id>/combat/rules/difficulty.json`）：

| 阶段带 | 威胁区间 | 敌人数值倍率（开启缩放时） |
|---|---|---|
| T0 | 1–3 | hp ×0.8 / atk ×0.8 |
| T1 | 3–6 | ×1.0 / ×1.0 |
| T2 | 6–10 | ×1.2 / ×1.15 |
| T3 | 10–16 | ×1.45 / ×1.3 |
| T4 | 16–30 | ×1.75 / ×1.5 |

阶段带缩放默认关闭；只有 `apply_band_scaling` 或书内默认开启时，倍率才改变敌人 HP/攻击。分层与威胁是审计估算，不代替实际 AI 技能、地形和队伍模拟。

校验器把"实际威胁 vs `threat_budget`"和"声明阶段带 vs 实际威胁"作为**警告**输出
（容差 25%）；`tools/balance_audit.py --strict` 可把它们升级为退出码。

---

## 5. 校验规则（保存门禁与开战检查）

1. `node_id`/`name` 缺失，或 `node_id` 含非法字符；
2. `map` 缺失、`rows/cols` 非正、超过 40×40 或 1200 格；
3. `tiles` 维度与 `rows/cols` 不符、引用了未定义的 `tile_id`；
4. `waves` 为空、波次 >6、`count` 越界（1–12）、总数 >48、完全没有敌人；
5. 已有非空已知敌人集合时，名称既不在 `enemies_def` 也不在敌人库；空集合时此检查跳过，不能据结构通过认定引用有效；
6. 站位越界 / 落在 `blocks_movement` 格；
7. `conditions.max_rounds`、`rewards.xp` 为非整数或负数；
8. 节点没有任何可出场的敌人时开战被拒（`400 战斗节点「…」没有可出场的敌人`）。

**警告**（不阻断）：站位数与数量不符、同波次站位重复、未被声明部署区（按三分之一推导）、
软锁（部署区之间无通路）、威胁与预算/阶段带明显不符、未知格子字段/未知状态效果。

---

## 6. 生成 → 校验 → 试跑 → 入库

先指定含 `book.json` 的完整世界书文件夹；其 `id` 必须与文件夹名一致。`candidate.json` 必须是严格 JSON，本文 `jsonc` 示例中的注释要移除。CLI 不会自动安装或启用书；保存到运行库仍要求已安装、启用的书籍归属。

```bash
python3 tools/validate_battle_spec.py candidate.json --book-folder PATH  # 结构+数值自洽
python3 tools/simulate_battle.py --book-folder PATH --spec candidate.json --runs 30 \
    --min-win-rate 0.6 --max-median-rounds 8 --max-hp-loss 0.6  # 固定策略下的指标，不等于真人体验
python3 tools/balance_audit.py --book-folder PATH --strict      # 目标书审计（含 XP 单调性）
```

`simulate_battle.py` 输出胜率 / 中位回合 / P90 / 首回合清场率 / 治疗溢出率 / 血损率 /
每轮出牌与移动 AP；相同种子结果可复现，因此可作为**生成循环的判据**：

```
LLM 产出候选 → validate（结构门禁）→ simulate（指标门禁）→ 人工/自动审阅 → 写入 nodes/
```

`validate` 退出码 0 表示无硬错误，警告不影响退出码；1 表示存在错误。试跑的阈值参数不传时不设对应指标门禁，输出 `pass` 也不能证明好玩。固定种子、阵容、内容与代码版本共同决定可复现范围。威胁指标是估算，候选外置地形和书籍数值须确认被实际加载；开战不替代完整规格校验。校验器不是全字段严格 JSON Schema：若干数值用 `int(...)` 转换，未逐项校验全部扩展字段，作者仍应提供表中约定的类型与范围。

调优优先级：**先改编排**（地形、站位、波次、数量），再动 `stats` 覆盖，最后才动
全局敌人条目或带宽倍率。

---

## 7. 随世界书分发

节点可编码为一条酒馆兼容的世界书条目：

````markdown
```json combat-node
{"schema_version":1,"node_id":"enc_xxx", ...整份规格（可压成一行）... }
```
（可选说明文字）
````

并带 `raw.extensions.arknights_tavern = {"entry_type":"combat_node","node_id":"enc_xxx"}`。
导入世界书时程序**自动落地**为节点文件（校验失败会逐条返回错误、不写半成品）；
导出时从注册表回灌最新规格。因此第三方内容包可以自带战斗，肉鸽生成物也能直接入册。
