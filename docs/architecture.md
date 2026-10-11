# 系统架构总览

Ark Tavern 在本机提供 LLM 叙事、角色交互、世界书管理和战斗体验。本文面向开发者，说明各层职责、主要运行流程、数据位置与专题入口，帮助定位需要修改的模块。安装和使用见[使用教程](tutorial.md)；协作规则见[AGENTS.md](../AGENTS.md)。本文描述主线代码，提案与归档资料的用途见第 5 节。

## 目录

- [1. 系统概述](#1-系统概述)
- [2. 后端](#2-后端src)
- [3. 前端](#3-前端frontendsrc)
- [4. 数据位置与内容工具](#4-数据位置与内容工具)
- [5. 设计文档地图](#5-设计文档地图docs)

## 1. 系统概述

用户通过会话选择世界书、剧情、主控与阵容，再由模型叙述和游戏规则共同推进体验。会话的交互模式与战斗模式是两个独立维度：交互模式为剧情或自由交互，战斗模式为叙事处理、网格战术、横版或已安装的脚本玩法。

世界观和角色内容由用户导入。《明日方舟》是可选内容，不是运行前提。新检出的项目书架为空，启动不自动安装世界书；未绑定世界书的会话不注入世界书内容。

### 1.1 运行与通信

Electron 提供桌面窗口并管理 Python 后端；React 负责界面；Flask 提供业务 API。浏览器入口复用同一套 React 界面，需要另行启动后端。

```text
Electron 主进程 ──窗口、后端生命周期、IPC── React 界面
                                               │
浏览器 ────────────────────────────────────────┤
                                               │ REST / SSE
                                               ▼
                                          Flask API
                                               │
                                  会话、内容、叙事与战斗规则
                                               │
                                  本地文件 / 向量记忆 / 模型服务
```

开发时，Vite 默认在 `5173` 端口提供页面，将 `/api` 代理到 Flask 的 `5000` 端口。桌面构建加载本地页面，通过 preload 获取后端地址后直接请求 Flask。IPC 用于窗口和系统能力，业务数据通过 REST 与 SSE 传输。入口见[桌面主进程](../frontend/electron/main.ts)、[后端进程管理](../frontend/electron/processManager.ts)、[API 地址解析](../frontend/src/utils/baseUrl.ts)和[Flask 工厂](../src/app.py)。

### 1.2 关键行为

这些约定影响跨模块修改，细节由对应专题或源码维护。

- **主控与场景角色分开**：阵容包含主控和队友，场景角色不包含主控；模型不能替玩家发言。创建会话时完成阵容、世界书范围和必要资源初始化，再发布会话。
- **战斗模式创建时固定**：恢复会话沿用已绑定模式。脚本玩法使用会话冻结的包与输入，不自动换成安装目录中的新版本。
- **数值与物品效果由服务端处理**：模型建议不能获得作者规则的执行权限。网格战斗由后端引擎计算，前端呈现状态和事件。
- **世界书范围与正文分开**：会话保存完整载入规则及候选范围快照，正文仍从书中读取；不能把范围快照理解为整本书正文冻结。
- **世界书注入分层**：常驻 position-0 条目进入稳定层，触发型条目进入动态层；节点图、绑定等系统条目不参与提示词注入。
- **画面资源与玩法包分别冻结**：舞台画面配置和图片保存到会话，历史与回档读取保存的演出帧；脚本玩法另有精确包、输入与资源的冻结和校验。
- **模型错误独立呈现**：模型连接、限流和服务错误使用结构化错误处理，不能伪装成角色回复。

## 2. 后端（`src/`）

后端采用 Flask app factory。[create_app()](../src/app.py) 创建共享 Manager、装配 Hook 管道并注册按功能分组的 Blueprint。路由接收请求，领域模块管理叙事、会话、内容和战斗；具体参数与算法见专题文档和拥有它们的源码。

### 2.1 叙事与模型调用

叙事将正文创作与系统信息提取分开。第一阶段生成并流式发送正文；第二阶段提取选项、摘要、环境变化和战斗信息，随后更新会话状态。偏离检查用于比较参考走向与实际轨迹，不授予模型数值或物品结算权限。

| 入口 | 职责 |
|---|---|
| [blueprints/chat.py](../src/blueprints/chat.py) | 对话与叙述入口、SSE、分支落点、节点推进和战斗触发 |
| [SceneManager.py](../src/SceneManager.py) | 多角色场景编排、两阶段叙述、结构化信息提取和偏离评估 |
| [CharacterAgent.py](../src/CharacterAgent.py) | 单角色人设、上下文、记忆和按需文档查询 |
| [story_outline.py](../src/story_outline.py) | 参考大纲、章节与节拍骨架、分支章节 |
| [combat_generation.py](../src/combat_generation.py) | 按剧情场景生成战斗编排，校验和固定种子试跑后才保存 |
| [llm_backend_manager.py](../src/llm_backend_manager.py) / [load_llm.py](../src/load_llm.py) | Provider 配置、主备降级、HTTP 调用、重试与结构化错误 |
| [hooks/](../src/hooks/) / [providers/](../src/providers/) | 检定、知识预取和模型 Provider 实现 |

正文完成与整轮后处理完成是不同时间点。前端可在第二阶段处理时阅读正文，但不能仅凭正文完成就认定这一轮已经成功提交。SSE 事件、降级和阅读位置交接见[两阶段叙述](design/narrative/two-phase-narration.md)；知识来源见[知识召回](design/narrative/rag-retrieval.md)。

### 2.2 会话与公共状态

会话同时管理交互历史、角色阵容、世界书范围和游戏状态。剧情树节点记录可恢复的状态；角色数值、物品、插件数据和脚本运行记录按各自约定参与回档。回档不是把所有配置和版本绑定都改回过去。

| 入口 | 职责 |
|---|---|
| [session_manager.py](../src/session_manager.py) | 会话创建、恢复、删除、叙述历史、变体与初始化发布 |
| [session_overlay.py](../src/session_overlay.py) | 会话覆盖、剧情树节点状态、物品、任务、角色数值和插件数据 |
| [character_stats.py](../src/character_stats.py) / [session_stats.py](../src/session_stats.py) | 数值字段与世界书、角色全局值、会话值的读取和合并 |
| [story_rules.py](../src/story_rules.py) | 作者分支条件与效果、服务端重验、原子结算和重试凭据 |
| [session_worldbook_dependencies.py](../src/session_worldbook_dependencies.py) | 当前会话的依赖微调、继承关系和更新预览 |
| [session_context.py](../src/session_context.py) | 会话文档摘要缓存 |
| [session_resources.py](../src/session_resources.py) / [scene_media.py](../src/scene_media.py) | 会话资源覆盖、作者画面配置、资源冻结与演出帧 |
| [session_export.py](../src/session_export.py) | 会话存档导出 |

角色数值与面板接口见[会话场景插件](design/session-scene-plugins.md)，条件和效果见[剧情规则](design/narrative/story-rules.md)，背景与 CG 的保存和回档见[节点演出](design/worldbook/node-presentation.md)。

### 2.3 世界书、文档与记忆

世界书分为剧情世界书与资料库：前者可绑定会话并参与叙事，后者用于浏览、检索和摘录。分类用于组织条目，载入规则用于产生候选，关键词等触发条件再决定本轮实际注入内容。这几个步骤不能互相替代。

| 入口 | 职责 |
|---|---|
| [world_book.py](../src/world_book.py) / [worldbook_folder_store.py](../src/worldbook_folder_store.py) | 书籍管理、外部格式导入导出、文件夹校验、触发匹配与注入 |
| [worldbook_scope.py](../src/worldbook_scope.py) / [worldbook_classify.py](../src/worldbook_classify.py) | 起点与有向依赖闭包、候选范围、显式线索分类 |
| [node_lore_scope.py](../src/node_lore_scope.py) | 节点绑定与会话范围的交集，随剧情节点保存和回档 |
| [wiki_manager.py](../src/wiki_manager.py) / [document_manager.py](../src/document_manager.py) / [index_manager.py](../src/index_manager.py) | 文档提取与引用、文件读写及冲突检测、文档关系图 |
| [memory.py](../src/memory.py) | 最近轮次窗口与 ChromaDB 语义记忆 |
| [environment_state.py](../src/environment_state.py) / [avatar_color.py](../src/avatar_color.py) | 书内环境状态与头像配色提取 |

当前内部世界书采用 schema v3 与 selective 载入，外部 SillyTavern 格式在导入时归一化。必要依赖参与完整闭包，关联边只用于浏览；闭包超限返回错误，不静默截断。会话依赖修改不写回全局书。详细规则见[按需载入](design/worldbook/worldbook-on-demand.md)、[节点级作用域](design/worldbook/node-scoped-worldbook-loading.md)和[资料库](design/worldbook/worldbook-library.md)。

### 2.4 战斗与可安装玩法

网格战斗、横版和脚本玩法有不同运行入口。网格引擎以服务端状态为准；横版使用独立模拟和存档接口；当前脚本玩法在浏览器 iframe 中执行，后端负责包管理、冻结、快照和结果确认。

| 入口 | 职责 |
|---|---|
| [combat_session.py](../src/combat_session.py) / [combat_engine/](../src/combat_engine/) | 网格战斗生命周期、操作、敌方行动、回合、卡牌、地形、寻路和伤害 |
| [combat_data_loader.py](../src/combat_data_loader.py) / [combat_map.py](../src/combat_map.py) | 按绑定书顺序加载战斗内容，解析和校验地图 |
| [combat_nodes.py](../src/combat_nodes.py) / [combat_balance.py](../src/combat_balance.py) / [combat_rules.py](../src/combat_rules.py) | 节点读写、冲突检测、剧情绑定、威胁模型和成长规则 |
| [sideview_combat.py](../src/sideview_combat.py) / [blueprints/sideview.py](../src/blueprints/sideview.py) | 横版关卡与快照校验、启动、存档和结算 |
| [combat_mode_packages.py](../src/combat_mode_packages.py) / [combat_mode_bindings.py](../src/combat_mode_bindings.py) | 脚本模式包验证、安装管理、世界书输入与会话冻结 |
| [combat_mode_runs.py](../src/combat_mode_runs.py) / [combat_mode_sessions.py](../src/combat_mode_sessions.py) | 独立演练与正式会话运行态、版本检查、幂等确认和回档 |

当前脚本玩法不加载任意服务端插件代码。客户端结果需用户确认，不发数值奖励；正式运行态、历史和收据随剧情回档，绑定包版本不随回档改变。细节见[可安装战斗模式](proposals/combat-mode-plugins.md)。[本地单机插件方案](proposals/local-plugin-minimal-plan.md)描述后续原生插件与统一存档目标，不能据此判断主线已具备那些能力。

### 2.5 API 与共享模块

API 按业务域分组，完整注册列表由 [app.py](../src/app.py) 维护。查找路由时进入对应 [blueprints/](../src/blueprints/) 文件，不在本页重复维护逐个端点清单。

- 交互与状态：会话、对话、场景、舞台、环境和轮次回退。
- 内容：世界书、文档、索引、剧情、节点图、资产、卡牌和战斗节点。
- 战斗：网格战斗、横版、模式管理与脚本插件。
- 配置与基础能力：模型服务、Wiki 查询和状态检查。

[services/](../src/services/) 提供检定与属性读取等共享业务；[shared/](../src/shared/) 提供 SSE、缓存和其他公共辅助能力。

## 3. 前端（`frontend/src/`）

React 界面通过 Zustand 保存页面和会话状态，通过 API 客户端获取后端数据。桌面与浏览器共用页面；具体窗口尺寸、主题和布局要求见[前端设计规范](design/frontend-design-guidelines.md)。

### 3.1 页面与模块入口

页面入口负责组织交互，纯逻辑和数据折算放在对应工具模块。此表用于定位组件，字段、按钮和样式细节由源码及专题文档维护。

| 入口 | 职责 |
|---|---|
| [main.tsx](../frontend/src/main.tsx) / [App.tsx](../frontend/src/App.tsx) | React 启动、页面切换、状态查询和战斗视图选择 |
| [HomeMenu.tsx](../frontend/src/components/HomeMenu.tsx) / [GameTopBar.tsx](../frontend/src/components/GameTopBar.tsx) / [StatusBar.tsx](../frontend/src/components/StatusBar.tsx) | 主菜单、管理页导航和运行状态 |
| [ChatView.tsx](../frontend/src/components/ChatView.tsx) / [ChatPanel.tsx](../frontend/src/components/ChatPanel.tsx) | 对话容器、流式正文、选项、变体、回滚与记录展示 |
| [ScenePanel.tsx](../frontend/src/components/scene/ScenePanel.tsx) / [plugins/](../frontend/src/plugins/) | 场景面板注册、角色与游戏状态展示、面板隔离错误处理 |
| [StageView.tsx](../frontend/src/components/stage/StageView.tsx) / [stageScript.ts](../frontend/src/utils/stageScript.ts) | 视觉小说式逐句阅读、说话人、背景、立绘与选项 |
| [SessionStoryGraph.tsx](../frontend/src/components/story/SessionStoryGraph.tsx) / [sessionStoryGraph.ts](../frontend/src/utils/sessionStoryGraph.ts) | 会话剧情树、当前位置、只读节点详情与运行时节点回档 |
| [CombatView.tsx](../frontend/src/components/combat/CombatView.tsx) / [combat/](../frontend/src/components/combat/) | 网格、Spine 演出、手牌、战斗状态和事件播放 |
| [sideview/](../frontend/src/features/sideview/) / [combatModes/](../frontend/src/features/combatModes/) | 横版模拟与当前 iframe 脚本玩法 |
| [CreateSessionWizard.tsx](../frontend/src/components/session/CreateSessionWizard.tsx) / [SessionManagerView.tsx](../frontend/src/components/session/SessionManagerView.tsx) | 会话创建、世界书绑定、主控与阵容、会话管理 |
| [CharacterManager.tsx](../frontend/src/components/CharacterManager.tsx) / [roles/](../frontend/src/components/roles/) | 角色库、玩家身份、角色数值及角色资源 |
| [AssetManager.tsx](../frontend/src/components/AssetManager.tsx) / [CardManager.tsx](../frontend/src/components/CardManager.tsx) | 图片资产与卡牌编辑，嵌入角色管理入口 |
| [WorldBookManager.tsx](../frontend/src/components/WorldBookManager.tsx) / [worldbook/](../frontend/src/components/worldbook/) | 剧情世界书与资料库、条目、预览、节点图和会话条目 |
| [SettingsPanel.tsx](../frontend/src/components/SettingsPanel.tsx) / [DocsView.tsx](../frontend/src/components/DocsView.tsx) | 模型与呈现设置、应用内教程 |
| [MarkdownRenderer.tsx](../frontend/src/components/MarkdownRenderer.tsx) / [dialogueParser.ts](../frontend/src/utils/dialogueParser.ts) | Markdown 展示与对话分段 |
| [audioManager.ts](../frontend/src/audio/audioManager.ts) | 战斗音效管理 |

角色与资产按来源世界书组织。新建会话候选由绑定书、书内角色花名册、剧情阵容及自建角色规则决定；剧情可以提供默认主控与阵容，玩家仍可调整。主控选择与队友选择分开，详细口径见[会话工程笔记](notes.md)和[characterCatalog.ts](../frontend/src/utils/characterCatalog.ts)。

### 3.2 世界书工作台

剧情世界书的工作台提供“条目 / Prompt 预览 / 节点图 / 会话条目”。Prompt 预览复用后端注入路径；节点图挂载 [PlotGraphPage.tsx](../frontend/src/components/combat/PlotGraphPage.tsx)，在抽屉中编辑剧情节拍与战斗节点；会话条目由 [IndexManager.tsx](../frontend/src/components/IndexManager.tsx) 管理当前会话的启用覆盖。资料库保留条目和会话条目入口，不开放 Prompt 预览与节点图。

会话依赖微调通过大厅中的 [SessionWorldbookDependencies.tsx](../frontend/src/components/session/SessionWorldbookDependencies.tsx) 完成，只影响当前会话。工作台中仍保留的 [LoadTab.tsx](../frontend/src/components/worldbook/tabs/LoadTab.tsx) 及其分类与载入子组件未接入当前页签；不能把这些源码文件当作已可使用的界面。配置草稿的相关保存条也不可达，入口状态以容器实际挂载为准。

### 3.3 状态、流式输出与演出

[appStore.ts](../frontend/src/stores/appStore.ts) 将消息、流式接收、发送和回档状态按会话隔离，并通过刷新键通知相关组件重新读取状态。[useApi.ts](../frontend/src/hooks/useApi.ts) 提供 REST 与 GET/POST SSE 客户端。

剧情面板展示当前位置、作者节拍骨架与角色状态。会话节点图通过 [SessionNodeDetails.tsx](../frontend/src/components/story/SessionNodeDetails.tsx) 展示带展开/关闭动画的只读正文和回档操作，不展示创作指引；历史按冻结演出帧关联作者节拍，无可靠身份时保留独立运行节点卡片。[sessionNodeRollback.ts](../frontend/src/utils/sessionNodeRollback.ts) 使用真实运行时节点 ID 和可选 checkpoint ID 恢复精确轮次，并锁定会话写操作，不修改世界书节点。独立回忆摘要已移除，剧情树节点摘要、剧情日志和角色向量记忆仍保留。

舞台读取同一轮权威正文，保留阅读位置，等待场景图片时不阻塞正文。网格战斗从操作响应中的状态与事件驱动演出，SSE 也会传输事件；播放逻辑需要识别重复事件。阅读交接见[两阶段叙述](design/narrative/two-phase-narration.md)，战斗事件与动画见[战斗界面](design/combat/combat-ui-design.md)。

### 3.4 主题与皮肤

默认皮肤支持明暗主题，PRTS 与 Tavern 使用各自色板。应用在 `<html>` 上切换皮肤 class，专用皮肤激活时不叠加默认浅色主题。界面状态由后端配置保存，角色和对话页面使用共享样式令牌。

颜色工具类覆盖由 [gen_skin_utils.py](../scripts/gen_skin_utils.py) 生成，应修改生成源后再更新产物。皮肤覆盖止于 `.bg-combat-bg`，战斗内容不随外壳换肤。样式入口为 [style.css](../frontend/src/style.css) 与 [styles/](../frontend/src/styles/)。

## 4. 数据位置与内容工具

安装内容、会话运行数据与项目配置分别保存。路径定义见 [data_paths.py](../src/data_paths.py)，完整世界书的导入与分享见 [data/README.md](../data/README.md)。

### 4.1 数据位置

同名资源按会话绑定书籍的顺序查找；书内资源与该书一起管理。会话范围快照、舞台资源和脚本包具有不同保存规则，不能据“已冻结”推断所有本地内容都不可变。

| 位置 | 用途 |
|---|---|
| `data/worldbooks/books/<book_id>/` | 本地安装世界书；`book.json` 与角色、剧情、战斗、音频等书内资源 |
| `data/categories.yaml` | 逻辑类别到书内物理目录的映射 |
| `data/memory/sessions/<mode>/<session_id>/` | 会话、覆盖、历史与冻结资源；脚本玩法冻结副本位于该会话的 `combat_plugin/` |
| `data/memory/` | 向量记忆等运行数据；独立战斗恢复位于 `combat_resumes/` |
| `data/combat_modes/` / `data/combat_mode_archive/` | 当前脚本模式安装包与卸载归档 |
| `data/tactical_practice/` / `data/sideview_levels/` | 显式演练示例；不自动安装到书架 |
| `config/llm_config.json` | 模型服务及相关界面配置 |

已安装书、会话与模型配置属于本地数据，不能假设新检出仓库包含当前机器的内容。应用内酒馆导入创建独立书文件夹；分享完整书需要携带该书资源。

### 4.2 内容工具与验证入口

战斗内容工具位于 [tools/](../tools/)，分别负责规格校验、固定种子试跑、候选生成和平衡审计。工具选择与内容流程见 [combat-designer](../.agents/skills/combat-designer/SKILL.md)，格式见[战斗规格](design/combat/battle-spec.md)。

自动化测试入口为 [run_tests.sh](../scripts/run_tests.sh)。确定性用例位于 [tests/](../tests/)，性能与战斗子集位于 [perf_tests/](../perf_tests/)；前端纯逻辑与 SSR 检查由 [scripts/](../scripts/) 中相关脚本承担。环境差异和测试数据要求见[工程笔记](notes.md)，不在架构页重复维护逐项测试清单。

剧情树的确定性流程用例见 [test_story_tree_full_flow.py](../tests/test_story_tree_full_flow.py)。[verify_llm_node_generation.py](../scripts/verify_llm_node_generation.py) 是需要模型配置的真实调用冒烟入口；确定性测试、SSR、真实模型、浏览器和 Electron 实机验证提供不同证据，不能互相代替。

## 5. 设计文档地图（`docs/`）

先按问题选择入口，再进入专题。目录表示资料用途，不保证提案已实现，也不保证某篇较早的设计说明与当前代码完全一致；修改行为时应核对实现与测试。归档保留历史语境，不作为当前运行依据。

### 5.1 使用与工程入口

| 文档 | 阅读目的 |
|---|---|
| [使用教程](tutorial.md) | 安装、模型配置、创建会话与基本玩法；同时用于应用内文档页 |
| [工程笔记](notes.md) | 环境差异、容易误用的约定、已知问题与证据边界 |
| [系统更新记录](system-update-log.md) | 按时间追溯演进；现状回到本文与专题实现 |
| [前端设计规范](design/frontend-design-guidelines.md) | 页面与交互设计约束、PC 内容区尺寸和验收要求 |
| [数据布局](../data/README.md) | 安装书文件夹、资源查找与内容分享 |

### 5.2 机制与专题参考

| 主题 | 文档 |
|---|---|
| 战斗引擎、成长和数值 | [战斗设计](design/combat/combat-design.md)、[数值设计](design/combat/combat-numerical-design.md) |
| 战斗交互、内容格式与横版 | [战斗界面](design/combat/combat-ui-design.md)、[战斗规格](design/combat/battle-spec.md)、[横版战斗](design/combat/sideview-combat.md) |
| 世界书范围与用途 | [按需载入](design/worldbook/worldbook-on-demand.md)、[资料库](design/worldbook/worldbook-library.md)、[节点级作用域](design/worldbook/node-scoped-worldbook-loading.md) |
| 画面、角色数值与面板扩展 | [节点演出](design/worldbook/node-presentation.md)、[会话场景插件](design/session-scene-plugins.md) |
| 叙事与知识来源 | [两阶段叙述](design/narrative/two-phase-narration.md)、[知识召回](design/narrative/rag-retrieval.md)、[提示词约定](design/narrative/prompt.md)、[剧情规则](design/narrative/story-rules.md) |
| 内容管理设计背景 | [内容中心设计](design/content-hub-design.md)；当前页面归属以第 3 节与组件挂载为准 |
| 当前脚本模式基线 | [可安装战斗模式](proposals/combat-mode-plugins.md)；虽然位于提案目录，正文也记录已实现部分 |
| 战斗表现的验证记录 | [卡牌战斗表现 QA](card-combat-presentation-qa.md)；按其记录的范围与条件理解结果 |

### 5.3 提案、测量与历史

[proposals/](proposals/) 保存目标、方案与实施队列。部分提案包含已落地内容，具体状态应核对正文与源码。本地插件后续目标见[精简方案](proposals/local-plugin-minimal-plan.md)，数值成长方向见[成长曲线提案](proposals/combat-value-curve-redesign.md)；它们不替代当前模块说明。

[perf/](perf/) 保存性能实测。阅读[一轮对话耗时](perf/perf-round-latency.md)时保留测量条件、基线与优化阶段的区别，不将历史数值当作当前性能保证。

[archive/](archive/) 保存旧设计、实验、验收与讲解图，只用于追溯。教程图片位于 [images/](images/)。这些目录的内容不自动成为当前任务，也不因保留在仓库中而获得现状权威。
