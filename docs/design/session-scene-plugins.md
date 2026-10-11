# 会话场景面板插件与角色数值

本页供开发者扩展对话页场景面板、读写会话数值及排查舞台数据来源使用。这里的“插件”是前端代码内的面板扩展：构建时加载 TSX，与宿主共用 REST 客户端，不是可安装的原生游戏插件，也不提供不可信代码隔离。

> 原机制落地：2026-09-23。
> 最近核对：2026-10-11（`character_stats.py`、`session_stats.py`、`blueprints/stage.py`、`scene_media.py`、前端注册表、舞台脚本与现有用例的静态核对；未运行页面、真实模型或修改会话数据）。

## 1. 从任务选择接口

| 要做什么 | 本页入口 | 写入范围 |
|---|---|---|
| 定义一本书共用的数值字段 | 三层口径 | 世界书 schema；角色全局初值单独保存。 |
| 在当前会话修改数值 | 三层口径与提示词注入 | 会话覆盖层，不自动改变派生战斗数值。 |
| 保存面板自己的笔记或状态 | 插件数据 | 当前会话的命名空间，进入节点快照。 |
| 新增左侧页签 | 前端插件接口 | `plugins/custom/*.tsx`；构建期加载，新增后须重新构建。 |
| 读取正文对应的演出 | 舞台视图的数据 | 服务端演出帧与当前场景角色资料，二者的历史范围不同。 |

角色页保留角色库、玩家身份、资产与卡牌入口；单个角色详情提供数值、资产与专属卡牌。当前挂载与历史迁移见[内容中心整合记录](content-hub-design.md)。

## 2. 三层口径

| 层 | 存在哪 | 谁写 | 语义 |
| --- | --- | --- | --- |
| 字段（schema） | 世界书 `stat_fields`（随书保存、导出到 `extensions.arknights_tavern.stat_fields`、导入回读、复制书跟随） | 世界书工作台的「数值字段」对话框；`PUT /api/worldbook/<id>` 的 `stat_fields` | 键名、标签、类型（`number` / `text` / `bool` / `select`）、范围、默认值、分组、说明 |
| 角色全局值 | 角色目录 `index.md` frontmatter `stats` | 角色页「数值」页签；`PUT /api/characters/<name>/stats` | 出厂 / 默认数值 |
| 会话运行时值 | 会话覆盖层 `overrides.json` 的 `character_stats[<角色名>]` | 场景角色详情的叙事数值区域、面板扩展 `ctx.stats.set`；`PUT /api/sessions/<id>/character-stats/<name>` | 只对本会话生效，随剧情树节点快照回档 |

合并顺序：字段默认值 → 角色全局值 → 会话值（`character_stats.merge_character_stats`），每个键同时给出来源
（`default` / `global` / `session`），界面据此标「默认 / 全局 / 会话」。

**字段解析规则**：`session_stats.resolve_session_character_stats` 统一读取会话绑定首书的字段；即使首书
没有定义字段也不回退其它书，只有未绑定世界书时才使用角色自己的来源书。字段外的自定义键允许自由填写
（只接受 JSON 标量，最多 64 个），但不做类型校验。

**校验**：字段内的值按类型转换（数字夹到 `min`/`max`、`select` 必须在 `options` 内、`bool` 接受
是/否/true/false 等），API 写入走严格模式（无法转换 → 400），读取旧数据走宽松模式（静默丢弃）。

## 3. 提示词注入

有已定义的数值时（含默认 0 / false），叙述提示词的动态层（紧随 `<scene_state>`）多一个 `<character_stats>` 块：

```
<character_stats>
以下是角色当前的数值状态（由系统维护，叙述时应与之相符，不要自行改写数字）：
临光：体力 72/100、士气 8/10、龙门币 120、心情 警惕
博士：龙门币 340
</character_stats>
```

自由模式的角色回复走 `SceneManager._build_scene_context()` 的【角色数值】段，同一份渲染逻辑
（`character_stats.format_stats_block`）。主控角色由玩家扮演、不在 `_agents` 里，所以按身份名单独读一次
frontmatter，它的数值同样进块。默认值、面板与分支判定保持一致；剧情效果及回档见 [剧情规则](narrative/story-rules.md)。

## 4. 插件数据

面板自己的状态存在 `overrides.json` 的 `plugin_data[<namespace>] = {data, updated_at}`：

- 命名空间 `[a-z][a-z0-9_-]{0,39}`，`data` 必须是 JSON 对象，单个命名空间 ≤ 64 KB；
- `PUT` 默认顶层合并（`null` 删键），`replace=true` 整份替换；
- 与 `character_stats` 一样进剧情树节点快照（`_tree_state_snapshot`）与旧式节点历史（`record_node_snapshot`），
  回档时整体恢复；缺少当前资源快照字段时明确拒绝，不以保留现值伪装成成功回档。

## 5. 前端插件接口

`frontend/src/plugins/scenePanels.tsx`：

```ts
registerScenePanel({ id, title, icon, order?, modes?, hint?, component })
```

内置面板在 `plugins/builtin.tsx` 用同一个函数登记：场景页内切换角色、物品、环境，剧情页查看节点图，
任务、资源和自定义笔记保留各自入口。会话叙事数值移到角色详情的战斗数值区域下方编辑；它仍按上文三层口径
进入叙事提示词，不会自动改动派生战斗数值。已离场但保留会话数值的角色仍列在角色子栏，可打开详情清除记录。
自定义文件放 `plugins/custom/*.tsx`，由 `plugins/index.ts` 的 eager `import.meta.glob` 在构建期加载（示例：`custom/sessionNotes.tsx`）；新增或删除模块后重新构建，开发服务器可热更新。注册返回注销函数，同 ID 再次注册覆盖原定义；ID 为小写字母开头的 1–40 位 `[a-z0-9-]`，默认 order=100，modes 缺省时两种模式均可见。面板拿到 `ScenePanelContext`：

| 字段 | 作用 |
| --- | --- |
| `sessionId` / `session` / `chatMode` / `api` | 会话与完整 REST 客户端 |
| `refresh.{env,chat,character,stats,resource}` | 系统刷新键，任一变化就重新拉取 |
| `stats.list()` / `stats.set(name, values, replace?)` / `stats.reset(name)` | 会话数值；写入自动触发 `refresh.stats` |
| `data.get(ns)` / `data.set(ns, obj, replace?)` / `data.remove(ns)` | 插件数据 |
| `notify(kind)` | 主动通知系统某类数据变了 |

面板在 `ErrorBoundary` 里渲染，抛错只影响自己那一页。图标栏（`components/scene/ScenePanel.tsx`）始终可见；
收起时只剩图标，点任一图标即展开到该页。开发说明见[面板扩展 README](../../frontend/src/plugins/README.md)。ErrorBoundary 只隔离渲染错误；构建期模块加载与扩展代码使用宿主权限，不据此承诺安全沙箱。

## 6. 舞台视图的数据

`GET /api/sessions/<id>/stage` 返回背景、环境、`scene_media`、剧情 artwork、场景角色与主控资料；可用 `?round=<轮次>` 读取保存的演出帧。会话不存在返回 404，指定轮次缺少完整演出快照返回 409，不能静默使用当前帧冒充历史帧。

- `background`：由 `scene_media.presentation_frame` 决定：会话背景覆盖优先；没有会话覆盖时可用节点图 visual 替代背景，否则按地点 `combat_bg` 与 default 回退。`source` 指示来源。无图片时 `url=null`，前端按时段/天气生成渐变。
- `scene_media`：节拍、章节、轮次、事件和 visual 等演出信息；保存帧使用当前会话的资源 URL，对导入副本也如此。
- `characters[]`：当前场景角色，不含主控；提供会话覆盖优先的立绘/头像、主题色与对话状态。无立绘时前端显示头像与名字。指定历史 round 选择历史背景和环境帧，角色列表仍从当前场景读取，不能称作完整历史角色重放。
- `player`：主控名、头像与可用立绘。主控由玩家扮演，不作为场景 NPC 返回。

`stageScript.ts` 将最后一条非选项消息折算成旁白/台词，优先采用后端 `dialogueSegments`，否则使用前端 `parseDialogue`；紧随其后的选项作为收尾。流式预览按最多 140 个 Unicode grapheme 分页，已有页边界固定，最终正文按原文偏移接续阅读位置；无法可靠映射时保留纯文本。完整完成与失败约定见[两阶段叙述](narrative/two-phase-narration.md#舞台阅读与完成交接)。

玩家推进对话时，说话人立绘高亮写入 `appStore.highlightedSpeaker`；场景角色列表与消息流台词气泡复用该字段。正文、生成状态与图片加载相互独立，不能因资源失败隐藏正文。

## 7. 接口一览

```
GET    /api/sessions/<id>/stage                       ?round=<轮次>（可选）
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

实现入口：[数值逻辑](../../src/character_stats.py)、[会话字段解析](../../src/session_stats.py)、[stage 路由](../../src/blueprints/stage.py)、[演出帧](../../src/scene_media.py)、[面板注册表](../../frontend/src/plugins/scenePanels.tsx)。

现有验证入口：[数值 API 用例](../../tests/test_character_stats_api.py)（逻辑、导出回读、端点与快照回档）、[舞台脚本](../../scripts/test_stage_ui.cjs)（脚本、注册表、字段编辑器与 SSR 骨架）、[页面截图脚本](../../scripts/shot_chat_ui.py)。它们的存在不代表本次已执行；运行结果须另记日期、环境与范围。
