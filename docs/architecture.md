# 系统架构总览

> 状态：随代码演进 · 用途：本仓库的架构索引（模块职责、数据位置、关键约定）
> 仓库级协作规则（分支 / 并发防护）见根目录 `AGENTS.md`

---

## 1. 系统概述

Ark Tavern 是基于 LLM 提供剧情与游戏交互体验的通用平台。世界观来自用户选择的世界书与角色内容；《明日方舟》是可选导入内容，不是运行前提。新会话默认空白环境、主控称谓为「玩家」；没有会话绑定世界书时，世界书解析为空，启动时不自动安装用户内容。主要能力：

- **剧情模式** — LLM 驱动叙事 + 选项 + 记忆 + 环境
- **自由模式** — 沙盒角色交互
- **战斗** — 自由尺寸等距网格回合制（JSON 战斗节点 + 可扩展地形 + 统一曼哈顿度量；CSS 3D 网格 + PixiJS Spine 骨骼动画覆盖层）
- **世界书** — 酒馆 Lorebook 兼容的关键词触发式设定注入

运行链路：Electron 主进程管理窗口 + Python 子进程生命周期（`frontend/electron/`）→ React 渲染进程（`frontend/src/`，Vite 代理 `/api` → Flask `:5000`）→ Flask API（`src/app.py`，factory 模式组装 Manager + Blueprint）。

---

## 2. 后端（`src/`）

### 2.1 叙事与 LLM

| 模块 | 职责 |
|---|---|
| `app.py` | Flask factory `create_app()`，注册所有 Blueprint + 全局 Manager（含 WorldBookManager），入口 `main()` |
| `SceneManager.py` | 多角色场景编排，**两阶段叙述**：先 LLM 生成叙述文本流式推送，再 LLM 提取**结构化产物**（单个 JSON：`beat_complete` / `combat_trigger` / `combat_scene`（交手处境 + 敌人名 + 阶段带，战术模式下用于现场生成战斗节点）/ `choices` / `branches`（`target_beat_id` 只接受 `<current_node>` 列出的参考节拍 id）/ `node_title` / `summary` / `environment`；早期文档说的 `[BEAT_COMPLETE]` 等字面标记已废弃）。**Call 3 `assess_deviation`**：参考走向 vs 实际轨迹 → `{deviated, confidence, reason, branch}`，偏离时给出新分支线设计。支持结构化对话输出（`parse_structured()`）用于气泡模式 |
| `CharacterAgent.py` | 单角色人设：角色卡 + 6 条行为规则 + Wiki 上下文 + 记忆注入 + function calling（wiki 查询工具，最多 3 轮） |
| `story_outline.py` | **剧情参考大纲**（LLM 生成节点的「参考条目」）：启发式切幕（`## 第N幕：` + `**必须保留的节拍**` → 章节/节拍，续写「路线」成分支章节）与 LLM 生成（书内剧情/世界/角色/地点/阵营/物品条目 → 章节/节拍/`must_keep`/`combat`/分支 JSON，解析失败重试一次后回落启发式且 `generation.error` 标明）；以系统层条目 `story_outline_<plot_id>`（围栏 ```json story-outline`，永不注入）存进世界书；`outline_to_beats` 折算成与 `_parse_narrative_beats` 同构的节拍骨架（含 `[COMBAT:node_id]`、`min_rounds`）；`append_branch_chapter` 给偏离检测追加 kind=branch 章节 |
| `combat_generation.py` | **按剧情场景现场生成战斗节点**：Call 2 的 `combat_scene`（或大纲里 `combat.required` 的节拍）→ 只从注册表已有敌人按阶段带凑编排 → `validate_node` → `perf_tests/simulate_combat` 固定种子试跑（胜率 / 血损阈值，不达标收缩规模重试）→ `save_node` 入库并 `bind` 到剧情/章节/节拍、标 `worldbook_id`；失败返回 None 不落盘。`materialize_outline_combat` 物化大纲战斗节拍 |
| `llm_backend_manager.py` | 多 Provider 编排，主/备自动降级（验证缓存 120s TTL + 真实失败 30s 冷却） |
| `load_llm.py` | Ollama / OpenAI 兼容 HTTP 客户端。**结构化错误（LLMError 系列，错误绝不伪装成模型回复）+ 连接/429/5xx 指数退避重试 + 请求指纹日志（前缀漂移标尺）+ `on_failure` 降级回调** |

### 2.2 会话与内容

| 模块 | 职责 |
|---|---|
| `session_manager.py` | 会话 CRUD、回滚、叙述变体；创建时通过 initializer 在发布前完成阵容与世界书范围初始化。**`combat_mode`（`narrative`、`tactical`、`sideview` 或已安装脚本模式 ID）创建时选定，不可更改**；脚本模式发布前冻结并校验，恢复时不替换为安装目录的新版本。**主控角色（`player_identity`）与场景角色是两个口径**：主控是玩家自己扮演的角色，属于阵容但**不是**场景 NPC（`SceneManager.get_roster()` = 主控 + 队友；`get_scene_characters()` = 队友），模型不会替玩家说话 |
| `combat_mode_packages.py` / `combat_mode_bindings.py` | `data/combat_modes/<id>` 文件夹与 ZIP 安装管理；世界书 `combat/modes/<id>.json` 输入/资源预检与会话冻结。无任意服务端代码加载。见 [插件契约](proposals/combat-mode-plugins.md) |
| `combat_mode_runs.py` / `combat_mode_sessions.py` | 独立演练与正式会话脚本运行态、CAS快照和幂等确认；正式运行态/历史/收据随剧情回档，绑定版本不回档。客户端结果须用户确认且不发数值奖励 |
| `session_overlay.py` | 职责聚合：角色/物品属性覆盖 + 剧情日志（保留最近 15 条）+ 节拍状态 + 任务系统 + 多本世界书绑定（`worldbook_ids`）及各书候选快照（`worldbook_scopes`）+ **角色会话数值 `character_stats` 与插件数据 `plugin_data`**（两者随剧情树节点快照回档）；首本书仅由复数字段按顺序派生，不再单独存储；会话依赖读改写在 overlay 锁内原子保存 |
| `character_stats.py` | 角色数值三层口径：世界书统一字段（`WorldBook.stat_fields`）→ 角色全局值（frontmatter `stats`）→ 会话值；字段规范化 / 值校验 / 合并 / 提示词 `<character_stats>` 块。见 `docs/design/session-scene-plugins.md` |
| `session_stats.py` / `story_rules.py` | 面板、提示词与剧情判定的同源数值读取；作者分支的物品/数值条件与效果、服务端重验、原子结算和重试凭据。叙事角色详情不显示战术兜底，场景物品和效果记录随节点回档。见 `docs/design/narrative/story-rules.md` |
| `session_worldbook_dependencies.py` | 会话世界书继承基线、pair 屏蔽、本地边/起点展开覆盖、有效图、恢复继承与全局版本更新预览；不写全局书 |
| `session_context.py` | 按会话缓存文档摘要 |
| `session_resources.py` / `session_export.py` | 会话级资源（背景/形象覆盖）与会话存档导出 |
| `environment_state.py` | 地点/天气/时间状态机，按会话绑定书籍读取书内 `environment/` |
| `wiki_manager.py` | 文档目录 + 三级深度提取（summary/core/full）+ `imports` 引用解析 |
| `document_manager.py` | 文件 CRUD + 哈希冲突检测 |
| `index_manager.py` | 基于 `imports` 字段的文档关系图，YAML 导出/导入 |
| `avatar_color.py` | 从角色 PNG 头像提取主导色（hex），用于 UI 主题配色 |
| `hooks/` | Hook 管道：`pipeline.py`（执行器）+ `attribute_roll.py` + `wiki_prefetch.py` |

### 2.3 世界书与记忆

- `world_book.py` — 世界书（酒馆 Lorebook 兼容）：4 源解析（v1/v2/卡内嵌/jsonl）+ 关键词触发匹配 + 注入格式化 + 回灌导出 + `WorldBookManager`（已安装书为 `data/worldbooks/books/<id>/book.json`，资源同目录，均 gitignored）。`worldbook_folder_store.py` 校验完整书文件夹；应用内酒馆导入会自动创建书文件夹。
  **注入纪律：常驻 position-0 条目进稳定层，触发型条目一律进动态层（前缀缓存稳定）。**
  **另有第三类「系统层」**：节点图 / 节点绑定这类编辑器与运行时元数据条目（`is_system_entry`）按设计永不注入，不与前两层并列计入 token，也不进 Prompt 预览的 order / dropped；判定必须先系统层再按位置分层。详见 `docs/notes.md`「条目分层是三层，不是两层」。
  `eligible_uids_for` 返回 `EligibleSet`（候选集 + `forced_uids`/`position_overrides` 元数据随集合传递，注入调用点零改动）。
  **书用途 `book_type`**：`story`（剧情世界书，可绑定会话并参与解析）| `reference`（资料库，只供浏览、检索与摘录）。当前内部 schema 要求显式提供该字段；外部 SillyTavern 导入未声明用途时归一化为 `story`。`resolve()` 排除 `reference`，未绑定会话不注入；`excerpt_entries()` 提供整批原子摘录（新 UID、来源不被修改、保留 `excerpt_source` 可追溯来源）。详见 `docs/design/worldbook/worldbook-library.md`。
- `node_lore_scope.py` — 节点级世界书动态载入：书内一条永不注入的 `lore_bindings` 条目（围栏 JSON + extensions 标记）声明「目标 → 条目」绑定；`resolve_scope` 在剧情树节点落盘时把作用域冻结进 `story_tree.nodes[].state.lore_scope`（随回档走），注入时 `eligible_uids_for` 做「会话范围 ∩ 节点作用域」窄化白名单。书内无绑定条目或自由模式时关闭。详见 `docs/design/worldbook/node-scoped-worldbook-loading.md`。
- `worldbook_scope.py` — 当前内部世界书只接受 **schema v3 + selective**：分类与载入规则分离，全书使用一张有向图；起点由 `activation`（always / roster_any / manual）× `expansion`（none / requires_closure）描述，`requires` 参与闭包遍历、`related` 只供浏览，环可终止并回报交叉引用，闭包超限报错而非静默截断。`world_book.py` 提供估算预览和不可变规则版本历史（`policy_revisions`，会话绑定完整规则版本而不只是版本号），两个 prompt 入口均过滤候选。SillyTavern Lorebook v1/v2 与角色卡只作为外部导入格式，导入时直接归一化为当前内部 v3。详见 `docs/design/worldbook/worldbook-on-demand.md`。
- `worldbook_classify.py` — 条目自动分类：只认 uid 生成器前缀 / `group` 字段 / 名称括号后缀三类显式线索（取值为白名单，识别不出就不分类），产出分类树、条目归属与 `characters_<角色目录名>_index` → 角色关联。**不改变载入模式**：`from_dict` 对尚未分类的条目补齐分类信息，其余走用户显式的「自动分类」。详见 `docs/design/worldbook/worldbook-on-demand.md`。
- `memory.py` — `VectorMemory`：最近轮次滑动窗口 + ChromaDB 语义搜索，持久化于 `data/memory/`（gitignored）。

> **2026-09 变更（世界书工作台重构）**：世界书依赖的「AI 自动构建」整条链路已移除——构建内核（原 `worldbook_builder.py` / `worldbook_builder_plan.py` / `worldbook_reading.py`）、`dependency-proposals` 系列接口、前端构建面板与会话侧 AI 微调一并删除，两篇专项设计归档到 `docs/archive/`。见 `docs/proposals/worldbook-workbench-redesign.md` §2.4。
>
> **删的是画布与「让模型替你猜依赖」，不是依赖功能**：依赖数据、分类、载入规则、统一草稿的保存与撤销、范围预览、节点绑定全部保留；依赖配置的编辑 UI 当前未挂载。AI 构建时期的证据、复核与拒绝元数据已经从当前 schema 删除。

### 2.4 战斗后端

| 模块 | 职责 |
|---|---|
| `combat_session.py` | 战斗会话包装器：组装 CombatEngine + CombatDataLoader，管理生命周期、玩家操作、敌人 AI、SSE 推送 |
| `sideview_combat.py` / `blueprints/sideview.py` | 横版关卡数据与快照校验、独立的启动/存档/结算 API；前端模拟见 `frontend/src/features/sideview/`，契约见 `docs/design/combat/sideview-combat.md` |
| `combat_data_loader.py` | 按书籍绑定顺序加载书内 `combat/nodes/*.json`、`enemies/*.md`（叙事 attributes + 战斗 combat_stats，缺 combat_stats 时按 attributes 派生）与 `combat/backgrounds/` |
| `combat_map.py` | 战斗地图 JSON：尺寸/格子类型注册表/部署区解析与校验（行列定位错误、软锁警告、上限 40×40） |
| `combat_nodes.py` | 战斗节点注册表：JSON 读写 + `_hash` 冲突检测 + 校验 + 剧情节拍绑定/进度 + 世界书归属（节点 `worldbook_id`，剧情/资产/卡牌同约定）+ 剧情流程解析 `plot_flows`（章节/节拍/`[COMBAT:]` 引用，只收剧情叙述区；无 `## 章节 N` 骨架的护栏式剧情回落参考大纲 `story_outline`：书内 LLM 大纲 > 启发式切幕，与会话创建口径一致）+ 节点图数据 `node_graph`（`shared/json_hash.py` 与卡牌共用哈希） |
| `combat_balance.py` | 威胁模型（五类模板/威胁点/阶段带推荐/预算对照），校验器、编辑器与生成工具共用 |
| `combat_rules.py` | 按书籍绑定顺序加载 `combat/rules/{growth,difficulty}.json`（升级属性点、阶段带缩放与威胁容差） |

战斗引擎（`src/combat_engine/`）：

- `engine.py` — 回合循环 / AP / 士气 / 地形效果 / 寻路移动
- `entity.py` — `CombatUnit`
- `grid.py` — 自由尺寸网格、Dijkstra 寻路、视线、统一曼哈顿度量与目标形状
- `card.py` / `card_data.py` — 卡牌 / CardPool；职业基础卡牌以 JSON 为单一真相源
- `dice.py` — 命中/伤害，含 `terrain_mods` 地形修正

### 2.5 API 层（`src/blueprints/`，Flask Blueprint）

`chat.py`（对话/叙述/SSE/战斗触发）、`combat.py`（战斗 SSE + 敌人/格子目录）、`combat_nodes.py`（战斗节点 CRUD/校验/按世界书过滤/节点图 graph/节拍进度）、`cards.py`（卡牌 JSON CRUD + 所属世界书标注树）、`documents.py`（文档读写，剧情节点图编辑 plots 用）、`sessions.py`、`scene.py`、`environment.py`、`index.py`、`wiki.py`、`llm.py`、`assets.py`（图片资产 + 实体来源世界书标注）、`memories.py`、`status.py`、`worldbook.py`（书 CRUD/导入/条目/默认书/会话绑定；`PUT` 同时接受 `stat_fields`）、`stage.py`（**对话舞台 + 角色数值 + 插件数据**：`/stage`、`/characters/<name>/stats`、`/sessions/<id>/character-stats`、`/sessions/<id>/plugin-data/<ns>`，是场景面板插件与系统数据交互的正式边界）。

### 2.6 服务 / 共享 / Provider

- 服务层（`src/services/`）：`dice.py`、`attribute_loader.py`
- 共享工具（`src/shared/`）：`helpers.py`（SSE 响应工厂、记忆注入）、`cache.py`
- Provider（`src/providers/`）：`openai.py`、`deepseek.py`

### 2.7 测试

`tests/`（已纳入版本控制，含黄金基线 `tests/golden/`）+ `perf_tests/test_*_v1.py`（无外部依赖的战斗/结算子集）。统一入口 `bash scripts/run_tests.sh`，全部由 pytest 收集。

剧情树（LLM 生成节点）的两层验证：`tests/test_story_tree_full_flow.py`（脚本化 LLM 驱动 narrate-continue 全链路的确定性完整流程用例）与 `scripts/verify_llm_node_generation.py`（真实 LLM 端到端冒烟，需 `config/llm_config.json`，输出可行性报告至 `.tmp/`）。

**剧情树节点种类与参考大纲**（`session_overlay.py`）：树节点带 `kind`（`plot` 入口/章节切换/偏离起点、`beat` 章节内节点、`combat` 战斗节点）和 `ref_chapter_id/ref_beat_id`。无 `## 章节 N` 骨架的剧情在创建会话时以参考大纲代替，副本存 `story_outline`。`<current_node>` 提供当前节拍、必留内容和候选；作者选择经 `chat._apply_branch_landing` → `story_rules.settle_branch` 在叙述前原子提交效果及落点，模型建议没有执行效果权限。`min_rounds` 限制自动推进，`choice_required` 必须等待玩家选择。战术模式现场生成绑定节点见 `chat._resolve_combat_scene`。

**偏离检测**：每 `deviation_check_interval` 轮（默认 4）由 Call 3 检查；置信度达阈值且不在必要选择点时，可追加 `kind=branch` 的会话章节并生成待填充节点。生成/偏离的模型产物会剥离数值与物品规则，不能提升为作者权限。`GET/POST/DELETE /api/worldbooks/<book>/story-outline` 管理参考大纲，`POST /sessions/<id>/deviation-check` 手动检测；验证见 `tests/test_story_outline.py`、`tests/test_story_rules.py`。

---

## 3. 前端（`frontend/src/`）

### 3.1 入口与外壳

`main.tsx`（React 18 createRoot）→ `App.tsx`：GameTopBar（管理页顶栏：返回主菜单 + 管理页导航，返回入口全站唯一）+ StatusBar（状态栏）+ 内容区（HomeMenu / ChatView / CombatView / SessionManagerView / CharacterManager / WorldBookManager / DocsView / SettingsPanel）。轮询后端状态 5s、LLM 状态 10s、会话列表 15s。

### 3.2 聊天

- `components/ChatView.tsx` — 对话页容器：顶栏（左：返回大厅 / 主菜单 / **场景面板开合**；中：会话名 + 剧情/自由；右：**布局切换「记录 / 舞台 / 节点图」**）+ 左侧 `scene/ScenePanel.tsx` + `ChatPanel.tsx`（消息流/流式输出/选项/变体/回滚/对话气泡；舞台模式下挂 `stage/StageView.tsx`，消息流变成覆盖在舞台上的「记录」抽屉）。原右侧独立「会话资源」面板已并入场景面板的「资源」页，顶栏原「会话大厅 🏛 / 会话资源 🗂」两个小按钮撤销
- `components/scene/ScenePanel.tsx` — 场景面板：竖向图标栏 + 当前页。页签来自**插件注册表** `plugins/scenePanels.tsx`（`registerScenePanel`）：内置八个面板（角色 / 物品 / 环境 / 剧情 / 回忆 / 任务 / **数值** / 资源）在 `plugins/builtin.tsx` 登记，第三方面板放 `plugins/custom/*.tsx` 由 `plugins/index.ts` 的 `import.meta.glob` 自动加载（示例 `custom/sessionNotes.tsx`）。面板拿到 `ScenePanelContext`（`stats` 会话数值读写 / `data` 命名空间插件数据 / `refresh` 刷新键 / `api`），在 `ErrorBoundary` 内渲染；收起时只剩图标栏。`scene/CharacterStatsPanel.tsx` 是「数值」页，也是 `ctx.stats` 的参考实现。开发说明 `plugins/README.md`，设计见 `docs/design/session-scene-plugins.md`
- `components/stage/StageView.tsx` + `utils/stageScript.ts` — **舞台（视觉小说）视图**：`GET /api/sessions/<id>/stage` 给冻结演出帧与场景角色立绘。节点背景/事件 CG 持续到下一条明确画面指令，支持裁切与立绘显隐；配置和图片创建会话时冻结，历史/回档使用保存帧。图片就绪后开始首句，失败保留上一背景并可重试。无作者画面时沿用地点/default/渐变兜底，会话背景覆盖仍优先。`stageScript` 将叙述/回复折算成逐句步骤（后端 `dialogueSegments` 优先），走到末尾显示选项。详见 `design/worldbook/node-presentation.md`
- `components/story/SessionStoryGraph.tsx` + `utils/sessionStoryGraph.ts` — 会话剧情节点图：复用世界书 `GraphCanvas` 和排序布局，优先读取绑定书的已保存节点位置；未抵达置灰、头像定位本轮实际节拍，拖动位置仅本地保存。只显示图，剧情操作通过舞台/记录模式进行。
- `components/chat/` — 气泡渲染子组件（DialogueBubble（点击台词高亮说话人）、NarrationText、AvatarPlaceholder 等）；对话页样式集中在 `styles/chat.css`（`--ng-*` 令牌，随皮肤 / 明暗）
- `components/MarkdownRenderer.tsx` — 统一 Markdown 渲染
- `utils/dialogueParser.ts` — 解析 `「」` 对话为 `DialogueSegment[]`，前文叙述匹配场景角色名确定说话人
- `utils/baseUrl.ts` — 后端地址解析（Electron/浏览器）

### 3.3 战斗

- `components/combat/CombatView.tsx` — 战斗主控（50k+ LOC，最大组件）
- `components/combat/PlotGraphPage.tsx` — 剧情节点图页（世界书工作台「节点图」页签挂载，以当前选中的世界书为受控书；原内容中心一级入口与本页签一并归位）：整页画布同屏呈现剧情节点（plot 章节/节拍）与战斗节点（`[COMBAT:]` 引用连线），点开节点走右侧抽屉编辑（`StoryBeatEditor` / `BattleNodeForm`）、支持增删，编辑走快照撤销栈（`Ctrl+Z` 撤销 / `Ctrl+S` 保存）。原 `NodeFlowEditor.tsx` 已被本页取代、不再存在
- `components/combat/BattleNodeForm.tsx` — 单个战斗节点编辑表单（抽屉内挂载：地图绘制 BattleMapCanvas + 敌人编成与血量覆盖 + 服务端校验 + 试打）
- `components/combat/StoryBeatEditor.tsx` — 剧情节拍编辑抽屉（对当前书 `plots/<id>/index.md` 做节拍增删改，配合 `utils/plotBeatEditor.ts` 的 Markdown 手术）
- `components/combat/` 其余 — CSS 网格（CombatGrid：行列自由尺寸 + 地形着色 + 部署区标识）+ PixiJS Spine 覆盖层（PixiCombatScene，runtime-3.8）+ 手牌（CombatHand）+ 卡组查看（DeckViewer）+ 卡牌编辑（CardEditor）+ 状态/事件面板 + Spine 动画规格（`spineAnimSpecs.ts`）
- `audio/audioManager.ts` — 战斗音效管理

### 3.4 管理页

- `components/CharacterManager.tsx` — 「角色」页（模块页签：**角色库 / 玩家身份 / 资产 / 卡牌**；页签状态 `characterTab` 在 store）。**角色详情内再分四个页签：资料 / 数值 / 资产 / 卡牌**（`CHARACTER_DETAIL_TABS`）——「数值」是 `roles/CharacterStatsEditor.tsx`（按所属世界书的统一字段编辑角色全局值，写 frontmatter `stats`），「资产」是 `roles/CharacterAssets.tsx`（只看这个角色的头像 / 立绘 / 卡面，上传直接落到子目录因此可设默认），「卡牌」内嵌 `combat/CardEditor`；详情页头的「编辑战斗卡牌」切到本角色的卡牌页签。共用的数值表单是 `roles/StatValuesForm.tsx`（分组 / 来源标记 / 自定义键）：角色库浏览与角色卡导入、玩家身份维护；**资产（`AssetManager.tsx`）与卡牌（`CardManager.tsx`）由已删除的「内容中心」一级入口并入本页**，节点图并入世界书工作台的「节点图」页签（`components/combat/PlotGraphPage.tsx`，整页画布）；文档管理入口已移除。世界书和资源由用户导入或复制完整书文件夹管理，项目不再内置语料分发流程；后端 `document_manager.py` + `blueprints/documents.py` 仍在
- `components/AssetManager.tsx` — 资产目录：图片上传/裁剪/默认图，实体显示上级目录与来源世界书（frontmatter `worldbook_id`）；分组维度「按类别（默认）/ 按世界书」并列，来源选择由两个维度的控件共用同一份 `bookFilter`（按类别维度下来源下拉只做筛选、仍按类别分组，不再切成按书分组——那与「按世界书」维度是同一件事）；工具栏只有一个「折叠 / 展开」，作用于当前可见的实体
- `components/CardManager.tsx` — 卡牌管理：角色/职业卡牌编辑（CardEditor，embedded 模式下不再重复渲染实体标题），条目显示所属世界书；名称搜索；分组维度「按类型（默认）/ 按世界书」并列；工具栏只有一个「折叠 / 展开」，作用于当前维度的一级分组
- **角色页共用控件与字体语言** — `components/roles/RoleWidgets.tsx`（面板页头 `PanelHeader` / 来源徽章 `SourceBookBadge` / 工具栏图标按钮 / 折叠按钮 / 搜索框 / 操作按钮 / 空状态 / 来源世界书下拉）+ `components/roles/EntityAvatar.tsx`（无头像时按名称取色的首字色块，取色规则与对话页 `chat/AvatarPlaceholder` 一致）+ `styles/roles.css`（衬线标题 + Orbitron 眉标，与世界书工作台同源；色值全部取 `--ng-*` 令牌，随明暗与皮肤切换，Tailwind 颜色工具类照旧由 `scripts/gen_skin_utils.py` 生成皮肤覆盖）
- **来源世界书分组（角色库 / 资产 / 卡牌共用）** — `utils/worldbookGrouping.ts`（纯逻辑：`UNCLASSIFIED_KEY` = `"__none__"`、`worldbookKeyOf` 把缺字段/空白归一为未分类、`groupByWorldbook` 一级按书分组且未分类恒排最后、组间按书名字典序、组内保持传入顺序）+ `hooks/useWorldbookGroups.ts`（折叠状态与派生分组，来源选择 `activeKey` 由调用方持有）+ `components/WorldbookGroupList.tsx`（「全部」行 + 可折叠分组头，条目本体由调用方 `renderItems` 提供；同文件导出 `GroupDimensionToggle`，现只有资产 / 卡牌在用）。`CharacterManager.tsx` 的角色库**只按来源世界书分组**（原并列的「平铺」维度展示的是同一份列表、只差不分组，已撤销），来源来自 `/api/characters` 每个条目的 `worldbook_id`（`document_manager.DocumentInfo` 读实体 index.md frontmatter，空串 = 未分类）
- `components/WorldBookManager.tsx` — 世界书工作台：顶层按用途分「剧情世界书 / 资料库」（带筛选与计数），详情是带页签的工作台——**条目 / Prompt 预览 / 节点图 / 会话条目**；`会话条目` 由 `IndexManager.tsx` 承载，按当前书的分类展示条目，支持 `跟随书内设置 / 启用 / 停用` 三态覆盖。导入（文件/粘贴，支持角色卡 PNG/JSON 连带导入角色 + 内嵌世界书）、条目编辑器、酒馆格式导出、**hero 上的「数值字段」对话框（`worldbook/StatFieldsEditor.tsx`，定义这本书下角色共用的统一数值字段，随书保存 / 导出 / 导入 / 复制）**；资料库以检索/浏览为主，可就地把条目「加入剧情世界书」（提交前可编辑标题/正文/触发词）。全局默认世界书已取消，只有会话明确绑定的剧情书参与解析。纯逻辑在 `utils/worldbookLibrary.ts`
- `components/session/CreateSessionWizard.tsx` — 新建会话向导（模式&战斗模式 → 剧情 → 多选剧情世界书 → **主控与阵容** → 命名创建）。**选中剧情即自动选中**（`utils/characterCatalog.ts` 的 `resolvePlotDefaults` / `resolveLineupDefaults`）：剧情 frontmatter 的 `worldbook_id` 自动绑定（书未安装时保留玩家当前选择）、`player_identity`（缺省回退开场角色首位）自动选为主控、**该书角色花名册（书摘要里的 `character_ids`）+ 剧情开场角色整批入队**并标「自动预选」，玩家随后可随手改。资料库不出现在绑定列表；**角色候选 = 已绑定世界书的角色 + 各书花名册 + 剧情自带阵容**（`selectableCatalogItems`；拆分剧情书的角色卡仍记来源书，只按来源书过滤会让整份阵容消失），未绑书时仅自建角色 + 剧情阵容。自动选中只吃剧情声明那本书的花名册，手动再加的大书只扩候选，要一并选上走队友区的显式按钮「按绑定世界书全选角色」。**「主控与阵容」这一步只选角色**：候选范围和手动追加在世界书工作台按各书当前规则配置，向导不在这里调整。主控步骤（单选）与队友步骤（多选）共用 `components/session/CharacterPicker.tsx`；主控经 `identity` 声明、队友经 `roster_character_ids` 入队，主控不再出现在队友候选里。候选目录与筛选/去重规则在 `utils/characterCatalog.ts`。没选主控不能创建（前端拦截 + 后端拒绝显式空 `identity`）；「命名创建」只列每本书的估算 token
- `components/session/SessionManagerView.tsx` — 会话大厅：会话列表与详情、多本剧情世界书绑定、**角色阵容（`session.roster` = 主控 + 队友，主控标「🎭 主控（你）」且不可移出）**、换主控；「添加角色」仅列出当前已绑定世界书的角色，未绑定时仅列自建角色，并与新建向导共用 `CharacterPicker`
- `components/session/SessionWorldbookDependencies.tsx` — 会话大厅内按书切换的依赖微调：先用自然语言选择「条目出现时同时载入谁」或「出现什么条目时载入它」，再按需展开继承关系、屏蔽/恢复和更新预览；只修改当前会话的对应世界书
- `GET/PATCH /api/sessions/<id>/worldbook-entry-overrides` — 当前会话绑定书的条目三态覆盖；多书会话以 `book_id` 指定书，省略时使用首本书。覆盖数据保存在对应快照的 `local_overrides.entry_enabled`，以 `scope_revision` 做并发校验，`null` 恢复跟随条目默认值，不写全局书或其它会话
- `components/WorldBookManager.tsx`（工作台容器）/ `components/worldbook/tabs/LoadTab.tsx` / `components/WorldBookScopeManager.tsx` — 「世界书」页是带页签的工作台：**统一草稿与页头保存条**（一次 `PUT /configuration` 原子写入，409 保留草稿；页头那条显示「有未保存修改 / 已同步」+ 撤销 + 保存）住在容器 `WorldBookManager.tsx` 里；`分类与载入` 页签由 `LoadTab.tsx` 承载 **配置概览 / 条目与角色 / 分类结构** 三个子视图（子视图是页签本地状态，不进全局 store），分别渲染 `WorldBookConfigOverview` / `WorldBookEntryWorkbench` / `WorldBookScopeManager`——该页签已撤销，这三个文件当前都没有任何引用（死代码）：依赖配置的编辑 UI 未挂载、`patch` 无调用点，`条目` 页上的「节点配置有未保存修改」保存条实际不可达，保留原路径待接线；`WorldBookScopeManager` 已缩减为分类结构子视图（分类树 + 条目归属表 + 批量起点 / 批量依赖 / 批量归属，图谱画布与其交互已删），由统一草稿投影而来并写回同一草稿，条件起点（`roster_any` / `manual` / `requires_closure`）不会被静默清掉。原 `WorldBookDependencyPage.tsx` 已删除——它自带的世界书选择下拉与保存条已分别并进容器与页头。`components/worldbook/` 下是配置概览（基础设定 / 角色设定 / 关联补充 / 待处理 + 试选阵容 + 本次范围预览）、条目与角色（四个常见动作）与共享类型；`hooks/useWorldbookDraft.ts` 提供统一草稿与两个带防抖 / 过时响应保护的预览钩子；`WorldBookScopePreview.tsx` 用在工作台的范围预览里（新建向导的「命名创建」只显示每本书的估算 token，不再整块渲染它）
- 世界书工作台的页签容器与纯逻辑：`components/worldbook/tabs/`（`PromptPreviewTab`）+ `components/worldbook/EntryDependencyTree.tsx` / `utils/worldbookDependencyTree.ts` / `utils/worldbookPromptPreview.ts` / `utils/worldbookBatch.ts` — 世界书工作台的四个页签与纯逻辑：**节点图**页签直接挂 `components/combat/PlotGraphPage.tsx`（整页画布按当前选中的世界书编辑剧情节点图，页面本身见 §3.3；原「节点视图」轨道页连同 `NodeViewTab.tsx` / `utils/worldbookNodeView.ts` 已整组删除，轨道排序键与灰节点那套口径不再存在）；**Prompt 预览**走 `eligible_uids_for` → `collect_matches` → `format_injection` 同一条路径（固定种子），给出 `order[]` / `stable_text` / `dynamic_text` / `sites[]` / `skeleton[]` / `dropped[]` / `totals`；**条目依赖逐层展开**与 `resolve_v3_scope` 的 `display_tree` 同构；批量策略变换（起点批量 / 建边 / 清边 / 移入分类）是纯函数，只改草稿不写盘。全部为纯 SVG + DOM，不引入图形库（旧画布 `WorldBookGraphCanvas.tsx` 与 `utils/worldbookGraph.ts` 已整文件删除）
- `components/SettingsPanel.tsx` — LLM 配置/主题/叙述选项

### 3.5 状态与数据获取

- `stores/appStore.ts`（Zustand 4）
  - **Key 刷新模式** — 多个自增整数 key（`envRefreshKey`、`memoryRefreshKey`、`chatRefreshKey`、`characterRefreshKey`、`sceneSwitchKey`、`statsRefreshKey`），组件比较 key 检测数据过期
  - **按会话存储** — 消息/流式/发送状态按 `sessionId` 隔离，切换会话不丢失
  - 关键状态：`combatContext`（VIEWING/TARGETING + 选中卡牌/单位）、`pendingAutoNarrate`（战后自动叙述）、`dialogueBubbleMode`（气泡/纯文本切换）、`chatLayout`（`log` / `stage`，localStorage 记住）、`scenePanelOpen` / `scenePanelTab`（场景面板开合与页签，localStorage 记住）、`highlightedSpeaker`（点击台词 / 舞台推进时的说话人高亮）
- `hooks/useApi.ts` — REST + SSE 客户端（`connectSSE` 支持 GET/POST 事件流），自动检测 Electron/浏览器环境

### 3.6 UI 皮肤系统

- `appStore.skin: SkinId = "default" | "prts" | "tavern"`，持久化在后端 `config/llm_config.json` 的 `skin` 字段（`src/llm_backend_manager.py` 白名单校验，非法值回落 `default`）。
- `App.tsx` 按 `skin` 在 `<html>` 上切换 `skin-prts` / `skin-tavern` / `light` 三个 class —— 皮肤激活时 `light` 被抑制（仅 `skin === "default" && theme === "light"` 才加），设置页的明暗开关同步置灰。
- 两套皮肤是纯覆盖层 CSS（`src/styles/skin-prts.css`、`src/styles/skin-tavern.css`），沿用 `style.css` 中 `html.light` 的既有模式，**不做 CSS 变量重构**。
- 颜色工具类覆盖块（两个文件里由「工具类覆盖（由 scripts/gen_skin_utils.py 生成，勿手改）」标记界定的区段）由 `scripts/gen_skin_utils.py` 按色板生成 —— 前端实际用到 243 个颜色工具类（含 `hover:` / `placeholder:` 等变体与自定义 `surface-*` 色板），手写必漏，**改配色请改脚本里的色板后重跑**（`python scripts/gen_skin_utils.py`），不要手改该区段。
- 氛围仅静态（PRTS 扫描线、Tavern 烛光渐变），无动画，各带 `prefers-reduced-motion` 兜底。
- 作用域用 `@scope (html.skin-*) to (.bg-combat-bg)` 界定，**战斗页不换肤**（否则它复用的大量 `bg-gray-*` / `text-gray-*` 工具类会被污染）。覆盖范围：外壳 + 会话大厅 + 管理页 + 聊天页；视觉蓝本见 `ui-styles/02-prts-holo-terminal.html`、`ui-styles/03-tavern-journal.html`。

---

## 4. 内容工具与脚本

数据布局见 `data/README.md`：已安装书以 `data/worldbooks/books/<id>/` 为单位，
`book.json` 与角色、剧情、战斗、音频等资源在同一目录。运行时按会话绑定书籍顺序定位资源；
复制完整文件夹到 `books/` 后刷新书架即可导入。项目不分发共享内容目录或预装内容包；
新检出的项目书架为空，`books/` 是忽略的本地数据目录。统一路径由 `src/data_paths.py` 定义。
应用内导入酒馆 JSON/JSONL 时自动创建独立书文件夹。


战斗内容工具（`tools/`）：

| 工具 | 用途 |
|---|---|
| `validate_battle_spec.py` | 候选规格校验，退出码门禁 |
| `simulate_battle.py` | 固定种子试跑 + 阈值判定 |
| `generate_battle_spec.py` | 按阶段带程序化生成合法战斗 |
| `balance_audit.py` | 敌人分层/XP 单调性/节点预算审计 |

生成流程与硬性约束见 skill `combat-designer`，规格说明见 `docs/design/combat/battle-spec.md`。

其他脚本：`scripts/generate_builtin_worldbook.py`（世界书整合包）、`scripts/gen_skin_utils.py`（皮肤颜色工具类生成）、`scripts/run_tests.sh`（统一测试入口）、`scripts/test_worldbook_scope_ui.cjs`（分类树工具 / 批量起点与依赖与归属 / 候选范围预览 / 分类结构 SSR / 工作台页签骨架，以及依赖展开树与 Prompt 预览的纯函数与 SSR 检查）、`scripts/test_worldbook_library_ui.cjs`（资料库体验：用途筛选/分组、摘录载荷折算、工作台页签归一（资料库恒为 `条目` 页签）、SSR 骨架）、`scripts/test_stage_ui.cjs`（舞台脚本纯逻辑 / 场景面板注册表 / 数值字段编辑器折算 / ChatView·ScenePanel·StageView 的 SSR 骨架）、`scripts/shot_chat_ui.py`（对话页 + 角色页数值页签 + 世界书数值字段的真实页面截图，会建临时书与临时会话并预置 localStorage 对话记录，结束后删除）。

---

## 5. 设计文档地图（`docs/`）

按用途分目录；根目录只保留「入口 / 用户 / 流程」类文档。

```
docs/
├── architecture.md          本文件：架构索引 + 本图
├── tutorial.md              用户教程（也是 App 内「📘 文档」页的内容）
├── notes.md                 工程笔记：踩过的坑、口径约定、环境差异、已知未修项
├── system-update-log.md     变更历史（按时间倒序）+ 尚未实现项
├── design/                  【现状设计】机制与实现，可作为现状依据
│   ├── combat/              战斗引擎 / 数值 / UI / 规格
│   ├── worldbook/           按需载入、节点级作用域、资料库与用途分离
│   ├── narrative/           知识召回、两阶段叙述、提示词约定
│   ├── frontend-design-guidelines.md  前端设计避坑清单（硬性禁令 + 桌面验收尺寸）
│   └── content-hub-design.md
├── proposals/               【目标态提案 / 路线图】未落地或部分落地
├── perf/                    性能实测记录
├── archive/                 归档：不再维护，仅供追溯
└── images/                  教程截图
```

### 5.1 `design/` —— 现状设计

前端设计与实现前必读 [前端设计避坑清单](design/frontend-design-guidelines.md)，其中列出必须避免的问题与五组桌面验收尺寸。

| 文档 | 内容 |
|---|---|
| [design/frontend-design-guidelines.md](design/frontend-design-guidelines.md) | 前端设计禁令清单（标题不加副文案、禁 Emoji 冒充图标、不验收窄屏）与桌面端固定验收尺寸 |
| `design/combat/combat-design.md` | 战斗引擎架构与机制设计 |
| `design/combat/combat-numerical-design.md` | 战斗数值公式与平衡参数 |
| `design/combat/combat-ui-design.md` | 战斗界面交互与布局设计 |
| `design/combat/battle-spec.md` | 战斗规格（节点 JSON 全字段/地形效果/威胁与阶段带/校验规则/生成闭环），LLM 与设计者共用 |
| `design/worldbook/worldbook-on-demand.md` | 世界书分类与依赖载入、按需候选范围、当前会话快照与 API |
| `design/worldbook/worldbook-library.md` | 世界书资料库与剧情世界书分离：`book_type` 用途、安全的用途切换、原子摘录与来源追踪、前端资料库体验 |
| `design/worldbook/node-presentation.md` | 节点背景、事件 CG、书内图片引用、会话冻结与存档/回档；BGM/视频扩展位置 |
| `design/worldbook/node-scoped-worldbook-loading.md` | 节点级世界书动态载入：`lore_bindings` 绑定面、`会话范围 ∩ 节点作用域` 窄化白名单、快照与回档 |
| `design/narrative/rag-retrieval.md` | 知识注入的四条召回通道（依赖预加载 / 关键词世界书 / 预取 Hook / `wiki_query` 按需）、分层注入与记忆系统 |
| `design/narrative/two-phase-narration.md` | 两阶段叙述：创作与系统层解耦、结构化产物字段、三级 JSON 兜底与按调用类型思考档位 |
| `design/narrative/prompt.md` | 本项目提示词书写约定（已采用 / 未采用 / 顺序约定） |
| `design/narrative/story-rules.md` | 世界书数值初值、作者分支条件/效果格式、结算/重试与物品回档边界 |
| `design/content-hub-design.md` | 内容中心整合设计（内容中心一级入口已于 2026-09 拆解为「角色 + 世界书」两级，见文首「后续变更」） |
| `design/session-scene-plugins.md` | 会话场景面板插件接口、角色数值三层口径（世界书统一字段 × 角色全局值 × 会话值）、插件数据与快照回档、舞台视图的数据来源与接口一览 |

### 5.2 `proposals/` —— 目标态提案

| 文档 | 内容 |
|---|---|
| `proposals/combat-value-curve-redesign.md` | 数值成长曲线提案：**P0/P1 已落地**（对照表见文首），保留 P2 未落地项（卡牌 R0–R3 分支、Boss 阶段机制等） |

### 5.3 `perf/` —— 性能记录

| 文档 | 内容 |
|---|---|
| `perf/perf-round-latency.md` | 一轮对话耗时实测；§1–§3 为修复前基线，§5 为已落地的优化 |

### 5.4 归档区（`archive/`）

归档 = 不再维护、不作为现状依据，只为可追溯保留。**找现状请回上面的表。**

| 文件 | 归档原因 |
|---|---|
| `combat-background-prompts.md` | 历史战斗背景生成配方；现行资源布局以 `data/README.md` 与生成工具为准 |
| `character-card-rewrite-progress.md` | 本机已安装明日方舟角色卡改写验收记录；内容与基线不随仓库分发 |
| `sideview-handoff-2026-09-28.md` | 横版优化的历史交接；所列加载优化与节点图已合入主线，非当前任务队列 |
| `combat-core-design.md` | 章节战斗化改造方案，已实现；「7×7 网格不改」条款已作废 |
| `redundancy-scan-2026-09-12.md` | 代码冗余扫描报告；其建议已全部落地（死代码删除、导入清理等），结论见当时提交 |
| `2026-08-06-fengxue-guojing-plan.md`、`2026-08-06-fengxue-guojing-design.md` | 「风雪过境」剧情的历史设计稿；旧共享内容已移除，文中的 Markdown 遭遇与 7×7 网格也早已被 JSON 节点和自由尺寸取代 |
| `combat-embedding.html` | 战斗嵌入剧情的讲解图；引用了已删除的 `tests/test_combat_trigger.py` 与作废的 7×7 口径（其「数值权威在引擎、模型零数值授权」原则仍有效，见 `design/combat/combat-design.md`） |
| `architecture.html`、`architecture.architecture.json` | 由外部工具 archify 2.16.0 导出的架构图（与边车源文件，需同去同留）；内容停留在 2026-09-05，且 96% 体积是 vendored viewer 运行时。**重新生成不是本仓库的构建步骤**，架构现状见本文件。**已加入 `.gitignore`、不再入库**（本地/历史提交里仍有），因此新克隆的仓库里看不到这两个文件 |
| `rag-retrieval.html`、`two-phase-narration.html` | 上述两篇讲解图的原 HTML；内容已转为等价的 `design/narrative/rag-retrieval.md` / `design/narrative/two-phase-narration.md` 并补上新机制 |
| `worldbook-builder-performance.md` | 世界书依赖「AI 自动构建」的性能设计（自适应装箱、证据窗口、缓存失效、指标口径）；该功能已随世界书工作台重构移除，见 `proposals/worldbook-workbench-redesign.md` §2.4，归档时点见文首说明 |
| `worldbook-selective-reading.md` | 同一功能的另一篇专项：AI 构建第一遍「自适应选择性阅读」的模式、补读生命周期、缓存隔离与离线基准；随该功能一并移除 |
