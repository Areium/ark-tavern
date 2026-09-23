# 会话场景面板插件与角色数值

> 状态：现状设计（2026-09-23 落地） · 覆盖：对话页场景面板的插件接口、角色数值三层口径、
> 插件数据存储、舞台（视觉小说）视图的数据来源。代码：`src/blueprints/stage.py`、`src/character_stats.py`、
> `frontend/src/plugins/`、`frontend/src/components/scene/`、`frontend/src/components/stage/`。

---

## 1. 目标

1. 对话页左侧「场景面板」对第三方开放：其他开发者可以做自己的数据面板，并通过系统留出的接口记录、读取数值。
2. 「资产」「卡牌」并入角色之下：角色库里点一个角色，就能在它下面管理立绘 / 头像 / 卡面与专属卡牌。
3. 角色多一栏「数值」：字段可以自定义，但**同一本世界书下的角色字段统一**——字段定义在世界书上，角色填值。

## 2. 三层口径

| 层 | 存在哪 | 谁写 | 语义 |
| --- | --- | --- | --- |
| 字段（schema） | 世界书 `stat_fields`（随书保存、导出到 `extensions.arknights_tavern.stat_fields`、导入回读、复制书跟随） | 世界书工作台 hero 上的「数值字段」对话框；`PUT /api/worldbook/<id>` 的 `stat_fields` | 键名、标签、类型（`number` / `text` / `bool` / `select`）、范围、默认值、分组、说明 |
| 角色全局值 | 角色目录 `index.md` frontmatter `stats` | 角色页「数值」页签；`PUT /api/characters/<name>/stats` | 出厂 / 默认数值 |
| 会话运行时值 | 会话覆盖层 `overrides.json` 的 `character_stats[<角色名>]` | 场景面板「数值」页、插件 `ctx.stats.set`；`PUT /api/sessions/<id>/character-stats/<name>` | 只对本会话生效，随剧情树节点快照回档 |

合并顺序：字段默认值 → 角色全局值 → 会话值（`character_stats.merge_character_stats`），每个键同时给出来源
（`default` / `global` / `session`），界面据此标「默认 / 全局 / 会话」。

**字段解析规则**：会话内某角色用哪套字段？会话**绑定的世界书**优先（同一会话统一口径）；会话没绑书或
该书没定义字段时，退回角色自己的来源书（frontmatter `worldbook_id`）。字段外的自定义键允许自由填写
（只接受 JSON 标量，最多 64 个），但不做类型校验。

**校验**：字段内的值按类型转换（数字夹到 `min`/`max`、`select` 必须在 `options` 内、`bool` 接受
是/否/true/false 等），API 写入走严格模式（无法转换 → 400），读取旧数据走宽松模式（静默丢弃）。

## 3. 提示词注入

有任何非默认数值时，叙述提示词的动态层（紧随 `<scene_state>`）多一个 `<character_stats>` 块：

```
<character_stats>
以下是角色当前的数值状态（由系统维护，叙述时应与之相符，不要自行改写数字）：
临光：体力 72/100、士气 8/10、龙门币 120、心情 警惕
博士：龙门币 340
</character_stats>
```

自由模式的角色回复走 `SceneManager._build_scene_context()` 的【角色数值】段，同一份渲染逻辑
（`character_stats.format_stats_block`）。主控角色由玩家扮演、不在 `_agents` 里，所以按身份名单独读一次
frontmatter，它的数值同样进块。全是字段默认值的角色不占上下文。

## 4. 插件数据

面板自己的状态存在 `overrides.json` 的 `plugin_data[<namespace>] = {data, updated_at}`：

- 命名空间 `[a-z][a-z0-9_-]{0,39}`，`data` 必须是 JSON 对象，单个命名空间 ≤ 64 KB；
- `PUT` 默认顶层合并（`null` 删键），`replace=true` 整份替换；
- 与 `character_stats` 一样进剧情树节点快照（`_tree_state_snapshot`）与旧式节点历史（`record_node_snapshot`），
  回档时整体恢复；**老快照没有这两个键时保持现值不清空**（与 `character_states` 同口径）。

## 5. 前端插件接口

`frontend/src/plugins/scenePanels.tsx`：

```ts
registerScenePanel({ id, title, icon, order?, modes?, hint?, component })
```

内置面板在 `plugins/builtin.tsx` 用同一个函数登记：场景页内切换角色、物品、环境，剧情页内切换进度与回忆，
任务、资源和自定义笔记保留各自入口。会话叙事数值移到角色详情的战斗数值区域下方编辑；它仍按上文三层口径
进入叙事提示词，不会自动改动派生战斗数值。已离场但保留会话数值的角色仍列在角色子栏，可打开详情清除记录。
第三方文件放 `plugins/custom/*.tsx`，由 `plugins/index.ts` 的
`import.meta.glob` 自动加载（示例：`custom/sessionNotes.tsx`）。面板拿到 `ScenePanelContext`：

| 字段 | 作用 |
| --- | --- |
| `sessionId` / `session` / `chatMode` / `api` | 会话与完整 REST 客户端 |
| `refresh.{env,memory,chat,character,stats,resource}` | 系统刷新键，任一变化就重新拉取 |
| `stats.list()` / `stats.set(name, values, replace?)` / `stats.reset(name)` | 会话数值；写入自动触发 `refresh.stats` |
| `data.get(ns)` / `data.set(ns, obj, replace?)` / `data.remove(ns)` | 插件数据 |
| `notify(kind)` | 主动通知系统某类数据变了 |

面板在 `ErrorBoundary` 里渲染，抛错只影响自己那一页。图标栏（`components/scene/ScenePanel.tsx`）始终可见；
收起时只剩图标，点任一图标即展开到该页。开发说明：`frontend/src/plugins/README.md`。

## 6. 舞台视图的数据

`GET /api/sessions/<id>/stage` 一次给全：

- `background`：与战斗共用同一条解析链（会话覆盖 > 地点 `combat_bg` > `default`），`source` 说明来自哪一层；
  没有任何图片时 `url` 为 null，前端按时段 / 天气生成渐变（`utils/stageScript.proceduralBackground`）。
- `characters[]`：场景角色（不含主控）的立绘 / 头像地址（会话覆盖优先）、主题色、是否对话中；没有立绘的角色
  前端退回「头像 + 名字」的牌子。
- `player`：主控名与头像。

前端 `utils/stageScript.ts` 把消息流折算成「当前这一段」的逐句脚本：最后一条非选项消息拆成叙述 / 台词步骤
（后端 `dialogueSegments` 优先，否则前端 `parseDialogue`），紧跟的选项消息作为收尾；流式中只有实时文本一步。
玩家点击对话框推进，说话人的立绘高亮并写入 `appStore.highlightedSpeaker`（场景角色列表同步高亮；消息流里
点击台词气泡也走同一个字段）。

## 7. 接口一览

```
GET    /api/sessions/<id>/stage
GET    /api/characters/<name>/stats
PUT    /api/characters/<name>/stats                  {values, replace?}
GET    /api/sessions/<id>/character-stats
PUT    /api/sessions/<id>/character-stats/<name>     {values, replace?}
DELETE /api/sessions/<id>/character-stats/<name>
GET    /api/sessions/<id>/plugin-data
GET    /api/sessions/<id>/plugin-data/<ns>
PUT    /api/sessions/<id>/plugin-data/<ns>           {data, replace?}
DELETE /api/sessions/<id>/plugin-data/<ns>
PUT    /api/worldbook/<id>                           {stat_fields: [...]}（与其它字段同一端点，支持 expected_revision）
```

验证：`tests/test_character_stats_api.py`（纯逻辑 / 序列化与导出回读 / 全部端点 / 快照回档）、
`scripts/test_stage_ui.cjs`（舞台脚本、注册表、字段编辑器折算、SSR 骨架）、`scripts/shot_chat_ui.py`（真实页面截图）。
