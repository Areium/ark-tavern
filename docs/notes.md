# 项目工程笔记

本文记录 Ark Tavern 中容易误用的行为、环境差异和已知缺口，供开发与排查时查询。整体模块入口见[架构总览](architecture.md)，操作步骤见[使用教程](tutorial.md)；专题文档维护完整机制，本页保留诊断所需的重点与证据入口。

本页主体按 2026-10-11 的主线 `7344cea` 做源码与用例核对；节点详情与精确轮次回档已同步至 `0abfee7`。每条笔记记录最近核对日期和方式；日期表示事实复核时间，不是最后编辑时间，静态核对也不等于重新运行验收。历史测试、测速和界面验收保留原始记录日期与条件。新增或复核条目时写清现象、当前行为或限制、依据与验证范围；只改措辞时不刷新核对日期，已经解决且没有复用价值的过程日志留在 Git 历史中。

## 目录

- [一、已知问题与实施边界](#一已知问题与实施边界)
- [二、会话、叙事与回档](#二会话叙事与回档)
- [三、世界书、资源与持久化](#三世界书资源与持久化)
- [四、前端呈现与窗口](#四前端呈现与窗口)
- [五、测试与本机环境](#五测试与本机环境)
- [六、战斗与演出](#六战斗与演出)
- [七、历史证据的使用范围](#七历史证据的使用范围)

## 一、已知问题与实施边界

以下问题仍能从当前源码定位。它们是排查线索，不能因早期测试通过、报告移除或教程更新就视为已经修复。

### 1.1 当前缺口

> 最近核对：2026-10-11（源码与现有用例的静态核对）。

| 问题 | 当前表现与定位 |
|---|---|
| 玩家身份“个人资料”保存位置不可用 | 前端提供空世界书选项，后端保存身份要求非空且启用的所属书。使用路径是先建剧情书、身份存入该书、创建时绑定该书。见 [CharacterManager](../frontend/src/components/CharacterManager.tsx)、[身份 API](../src/blueprints/sessions.py)和[隔离用例](../tests/test_worldbook_folder_identity.py)。 |
| 大厅与向导的角色候选规则未完全统一 | 向导合并绑定书角色、花名册与剧情阵容；大厅添加角色仍按来源书筛选，拆分剧情书可能缺候选。见 [SessionManagerView](../frontend/src/components/session/SessionManagerView.tsx) 与 [characterCatalog](../frontend/src/utils/characterCatalog.ts)。 |
| 叙述变体更新接口不一致 | 前端提交 `round/narrative`，`narrate-update` 路由仍读取 `text` 并以单参数调用；`Session.update_narration` 需要轮次与正文。见 [useApi](../frontend/src/hooks/useApi.ts)、[chat 路由](../src/blueprints/chat.py)与[会话方法](../src/session_manager.py)。 |
| 任务更新缺少任务 ID 校验 | 任务 PATCH 检查状态枚举，未验证目标任务 ID 是否有效。见 [environment 路由](../src/blueprints/environment.py)。 |
| 全局依赖配置编辑入口未接入工作台 | `LoadTab` 及其子组件仍有源码引用，但未挂载到当前页签；配置草稿保存条不可达。大厅的会话依赖微调仍可用。见 [WorldBookManager](../frontend/src/components/WorldBookManager.tsx)、[LoadTab](../frontend/src/components/worldbook/tabs/LoadTab.tsx)。 |
| 资产实体行上传不能直接设为默认图片 | 该入口上传到实体目录根部；默认头像、立绘和卡面分别从 `avatar/`、`skin/`、`card_face/` 选择。使用角色资源入口或对应子目录。见 [AssetManager](../frontend/src/components/AssetManager.tsx)。 |

### 1.2 当前能力与目标分开

> 最近核对：2026-10-11（主线源码、提案与 Git 忽略规则）。

主线的可安装战斗模式仍是隔离 iframe 脚本玩法：后端管理包、冻结输入与资源、保存快照并确认结果，不执行任意插件服务端代码。用户确认的“受信任 Python 原生插件 + 隔离界面 + 宿主管理存档”是[本地插件方案](proposals/local-plugin-minimal-plan.md)的后续目标，不能用隔离分支的测试证明主线已经接入。

该目标信任安装者选择的原生代码，允许独立子进程执行，保留路径校验、接口鉴权与数据一致性要求；子进程和 SDK 不构成 OS 沙箱，也不承诺阻止原生代码访问当前用户有权访问的文件、网络或凭据。游戏数值由插件决定不等于可以丢弃保存、回档或幂等要求。

`task.md` 是被忽略的本地队列，不是版本库文档。继续实施前应核对约定的权威副本、分支和源码；更新它不能当作 Git 提交。原统一插件阶段计划留在[历史记录](archive/unified-plugin-plan-before-local-2026-10-08.md)，其中“现行”“下一步”仅代表当时状态。

## 二、会话、叙事与回档

会话中的角色、候选范围、正文、数值和媒体有不同的权威来源。排查时先确定正在处理的是哪份状态，再判断请求或快照是否属于当前会话。

### 2.1 主控、阵容与目录

> 最近核对：2026-10-11（源码与现有用例的静态核对）。

- **阵容包含主控与队友，场景 NPC 只有队友。** `get_roster()` 主控在前并去重；`get_scene_characters()` 不包含主控，模型不能替玩家发言。网格战斗编成也使用阵容，已有资料的主控可以单独参战。
- 创建 API 的 `identity` 显式为空时返回 400；省略时才使用中性称谓“玩家”。GUI 必须选择主控，不能据 API 的省略行为推断空书架能直接完成向导。
- 角色 API 的 `worldbook_id` 来自实际所属的启用书目录。旧 frontmatter 来源标记可能过时，不能据此定位运行资源；显示名也不能代替角色目录 ID。
- 剧情默认阵容由剧情声明书的花名册与开场角色产生。手动再绑定一本书只扩候选，不自动将该书全部角色入队；需要批量入队时使用显式全选操作。
- `initial_characters` 显式为空表示没有开场 NPC。重载恢复已保存阵容，不重新补入开场人物；空 NPC 阵容仍须恢复物品。
- 使用候选预览或创建指纹时，两者须采用包含主控的同一完整阵容。换主控与修改依赖后也按阵容重算范围，不能用 NPC 列表替代。

目录请求由大厅持有的 `useSessionCatalog` 与向导复用。模式页不必等待全部目录；依赖目录的步骤在加载失败时不能继续，重试保留表单，关闭重开才重置。离开大厅后不保留全局目录缓存。

依据：[SceneManager](../src/SceneManager.py)、[角色目录规则](../frontend/src/utils/characterCatalog.ts)、[目录加载](../frontend/src/hooks/useSessionCatalog.ts)。验证入口：[主控用例](../tests/test_session_main_control.py)、[空 NPC 恢复](../tests/test_story_rules_http.py)、[主控战斗恢复](../tests/test_combat_resume.py)、[目录浏览器夹具](../scripts/test_session_loading_browser.py)。

### 2.2 会话隔离与迟到请求

> 最近核对：2026-10-11（源码与现有用例的静态核对）。

消息、流式状态、战前简报和战后续写按会话保存。后台叙述可以继续，但只能写所属会话；弹窗、最小化入口、输入锁和导航只影响当前会话。

替换流、删除会话或收到 close/done/error 后，旧事件不能复活缓存或再次派发。打法、检定、手动开战与恢复请求需要校验会话、简报和导航身份；切走再切回不能让迟到结果自动抢占页面。编辑回滚按会话编辑 token 与消息快照接收结果，旧回滚不能取消新请求或释放新的编辑锁。

头像失败只对当前会话与资源版本的图片地址显示占位。版本、角色或会话变化后重新尝试，不改请求到未绑定的全书资源；资源来源由服务端解析。后台更新在重新进入会话时补读。

依据：[ChatPanel](../frontend/src/components/ChatPanel.tsx)、[appStore](../frontend/src/stores/appStore.ts)、[头像占位](../frontend/src/components/chat/AvatarPlaceholder.tsx)。验证入口：[会话隔离](../scripts/test_session_isolation.cjs)、[SSE 生命周期](../scripts/test_sse_lifecycle.cjs)、[模拟 API 浏览器检查](../scripts/test_session_isolation_browser.py)。

### 2.3 流式正文与舞台阅读

> 最近核对：2026-10-11（源码与现有用例的静态核对）。

正文接收、二阶段处理、正式脚本和图片下载不是同一个完成状态。

- `text_complete` 返回归一化和 hook 处理后的权威正文；成功 `done` 返回实际轮次及二阶段状态。错误终态或没有完成事件的 EOF 不能当作成功。
- 流式预览按最多 140 个 Unicode grapheme 分页，已形成的页边界固定，末页可增长；新页只增加页数，不抢当前阅读位置。
- 预览转正式脚本时，以当前页首字的原文偏移映射正式页，并接续正文、头像与已展示文字。无法确定映射时保留纯文本，不猜测跳页。场景或图片加载失败不隐藏正文。
- 用户输入与叙述绑定同一请求身份，成功后采用服务端轮次。失败输入不作为正式历史编辑，失败稿不占正式轮次；旧失败稿不能解锁新回复。刷新后的中断稿可恢复输入。
- 舞台记录抽屉复用消息流 DOM；`display:none` 下滚动到底无效，打开抽屉后再滚动。不要用“换键一律回第一页”或“流式只有一步”描述现有阅读机制。

正文与失败交接的完整约定见[两阶段叙述](design/narrative/two-phase-narration.md)。验证入口：[流式 Flask 用例](../tests/test_stage_stream_contract.py)、[阅读位置用例](../frontend/src/utils/stageReading.test.mjs)、[舞台脚本](../scripts/test_stage_ui.cjs)。

### 2.4 说话人归属与快捷键

> 最近核对：2026-10-11（源码与现有用例的静态核对）。

回退解析只采纳已知角色的明确署名或受限发言谓语，不按最近出现的角色名猜测。结构化片段显式 `speaker: null` 或空值保留未知；仅在紧邻台词且完全缺字段时允许继承。实质旁白、非法片段、复杂或否定句中断继承链，舞台不能用消息角色覆盖未知说话人。

舞台的中央选项区与底部对话区分开，选项过高只滚动选项，对话区保持布局。行动列表保留正文与必要的禁选原因；完整条件和效果在节点详情展示，不放进每个选项。

`End` 在接收或整理期间跳到当前已收到的末页，正式完成后可跳到选项或输入；它不自动选择、发送或增加轮次。`Ctrl` 用于逐句或长按快进。输入控件、输入法合成、组合键、重复 End、绘图与立绘调整等场景有独立保护，不能用全局键盘监听绕过它们。

依据：[dialogueParser](../frontend/src/utils/dialogueParser.ts)、[StageView](../frontend/src/components/stage/StageView.tsx)、[StoryChoices](../frontend/src/components/story/StoryChoices.tsx)。验证入口：[解析用例](../frontend/src/utils/dialogueParser.test.mjs)、[选项浏览器夹具](../scripts/test_stage_choices_browser.py)、[台词浏览器夹具](../scripts/test_dialogue_browser.py)。这些规则不等于通用自然语言理解，未登记别名或模型明确写错的 speaker 仍需内容侧处理。

### 2.5 数值、作者规则与回档

> 最近核对：2026-10-11（源码与现有用例的静态核对）。

会话数值字段采用绑定顺序中的首本世界书。首书没有字段或加载失败时，不改用另一套书的 schema；只有未绑定书的会话才可用角色来源书字段。值按字段默认、角色 frontmatter `stats`、会话覆盖合并，显式 0 与 false 也参与提示词。

面板、提示词与剧情规则通过 `session_stats` 读取同一结果。全局角色页仍使用角色所属书字段；与会话不同不能据此覆盖会话定义。字段定义并未随大纲或演出冻结，中途改首书字段会影响面板和下一次条件重验。纯叙事角色详情不生成战术 Lv1、XP0 或 HP 兜底。

作者分支的条件和效果由服务端校验，模型建议不能提升为作者权限。条件、物品 ID、角色字段与落点的完整格式见[剧情规则](design/narrative/story-rules.md)；手工图连线不执行数值或物品规则。

服务端先在一次 `overrides.json` 原子替换中提交效果、落点与凭据，再生成叙述。生成失败保留待叙述选择，同 ID 重试不重复消耗或奖励；已完成旧 ID 返回冲突。叙述、HTTP 数值或物品修改及节点回档互斥。这个单文件提交不代表正文、记忆和所有媒体形成跨文件断电事务。

资源随剧情节点与历史快照回档。回档先验证目标和快照完整性，再剪历史；缺键不能被解释为空库存或保留未来数值，不自动迁移旧节点。已结算效果后，只剪正文的轮次回退不能恢复资源，接口会要求使用节点回档。

数值入口在场景角色详情的 `CharacterSessionStats`，需要显式“保存数值”；旧独立 `CharacterStatsPanel` 未注册为内置页签。依据：[数值读取](../src/session_stats.py)、[规则结算](../src/story_rules.py)、[快照](../src/session_overlay.py)、[角色详情数值](../frontend/src/components/scene/CharacterSessionStats.tsx)。验证入口：[数值 API](../tests/test_character_stats_api.py)、[规则 HTTP 流程](../tests/test_story_rules_http.py)、[会话数值](../tests/test_session_stats.py)。

### 2.6 参考大纲与节点图

> 最近核对：2026-10-11（源码与现有用例的静态核对）。

没有正文节拍骨架的剧情，优先使用书内参考大纲，再回落启发式切幕，生成会话自己的节拍骨架。启发式一幕一节拍默认 `min_rounds=3`，LLM 大纲节拍默认 2；生成接口即使 HTTP 200 也可能回落，调用方必须查看 `outline.source` 与 `generation.error`。偏离分支只写会话副本，不回写世界书。

确定性分叉需要作者 `target_beat_id` 与 `choice_required`，完成标记或超时不能替玩家做必要选择。固定战斗节点不应因同一节拍又生成第二个遭遇。

节点引用按所属书、剧情、章节与节拍识别，不能按显示名猜测。唯一节拍移动章节后可重新关联；删除或歧义引用需要明确处理。章节序号不是稳定身份，重排后需重新核对。关联修复保留图坐标、连线和演出配置，进入同一撤销栈；大纲节拍不伪装成原文段落。

会话节点图复用作者布局，并补齐生成轨迹。头像定位本轮实际叙述节拍，不能仅看可能提前推进的 `ref_beat_id`。会话图允许查看、拖动和缩放，不开放作者编辑；坐标只保存在按会话、剧情与来源书隔离的本地布局中，不写回世界书或剧情进度。生成结束后再读取已提交树与轮次媒体，并成对提交结果，迟到请求不能覆盖新会话。

“只读详情”限制的是作者内容编辑，节点回档仍会修改会话进度。详情只展示节点正文与回档操作，不展示 `must_keep`、`guidance`、创作意图或重复摘要；展开和关闭带动画，并遵循减少动态效果设置。历史作者卡按冻结演出帧的 `beat_id/chapter_idx` 定位，要求帧的轮次匹配 `round_end`；不能用推进后的 `ref_beat_id` 推断历史归属。无可靠身份时保留 `scene:<runtime_id>` 卡片，按真实 `parent_id` 连线。

同一场景连续推进或复访覆盖最新状态前，`story_tree.checkpoints` 冻结节点与状态，按独立 checkpoint ID 回档。历史与最新状态按 `snapshot_id` 去重；同场景同轮次重走得到的新冻结状态替换旧回档点，旧 checkpoint ID 失效。更新前已覆盖的状态无法追补，继续原会话可积累新回档点，不迁移旧存档。回档只恢复当前轮次及之前的完整快照，未来节点保留为只读；历史和日志按原截断语义处理，不重建已剪去的剧情。缺完整资源快照仍可查看记录，但不能回档。

回档提交真实运行时节点 ID 和可选 checkpoint ID，恢复对应正文、分支、树位置、演出与资源；指定 checkpoint 时不静默改用最新状态。请求期间按会话锁定续写、轮次回退、删消息与变体操作。返回结果校验所有权、消息版本、epoch 和轮次，迟到结果不写入新会话。资源刷新不触发会中止 SSE 的 `chatRefresh`。

剧情面板只保留当前位置、作者骨架和角色状态。独立回忆摘要的生成、重生成、提示词注入、设置间隔和 SSE 刷新链已退休；`memories.json` 仍保存叙述历史、轮次与累计用量，历史摘要字段保留但不再读取或注入。剧情树节点摘要、剧情日志和角色向量记忆继续使用。叙述变体方法的直接用例不证明 HTTP 路由已修正，第一节的参数缺口仍存在。

新增依据：[节点详情](../frontend/src/components/story/SessionNodeDetails.tsx)、[回档协调](../frontend/src/utils/sessionNodeRollback.ts)。验证入口：[回档锁脚本](../scripts/test_session_node_rollback.cjs)、[无独立摘要的确定性流程](../tests/test_story_tree_full_flow.py)；原提交中的浏览器与完整套件结果保留为当时记录，不等于本轮复跑。

`0abfee7` 的精确轮次依据见[checkpoint 用例](../tests/test_story_tree_checkpoint_rounds.py)。本次同步核对提交与源码，并执行相关定向用例和前端脚本；范围与结果见[本轮核对记录](README.md#本轮核对记录)，不沿用原提交的浏览器或完整套件结果。

依据：[参考大纲](../src/story_outline.py)、[剧情流程](../src/combat_nodes.py)、[会话图](../frontend/src/components/story/SessionStoryGraph.tsx)。验证入口：[大纲用例](../tests/test_story_outline.py)、[引用详情](../tests/test_graph_node_details.py)、[共享图引用](../scripts/test_graph_references.cjs)、[会话图脚本](../scripts/test_session_graph_ui.cjs)。

## 三、世界书、资源与持久化

书籍正文、载入规则、会话范围和媒体快照是不同数据。共享目录、全局默认书与旧安装包的历史描述不能用来推断当前读取路径。

### 3.1 安装与资源来源

> 最近核对：2026-10-11（源码与用例）；本次另执行资源来源测试，4 项通过。

当前以 `data/worldbooks/books/<book_id>/` 为安装和分享单位，`book.json` 与该书角色、剧情、战斗、音频资源放在同一文件夹。新检出仓库不附带用户安装书；放入完整文件夹后刷新发现，不覆盖已有同 ID 书。酒馆 JSON/JSONL 或角色卡导入创建独立书文件夹，原文件没有独立资源时不会自动补出图片或关卡。

运行时按会话绑定书顺序解析同名资源。角色目录 ID、实际来源书和资源 URL 随解析与恢复快照传递，头像、卡面、Spine 图集与贴图都不能用显示名重新全局查找。形象解析为会话覆盖、绑定书快照、绑定书内角色文件，不向旧共享全局目录回落。

世界书文件夹与会话 ZIP 是不同导出物。导入会话 ZIP 时，随档资源形成独立会话资源世界书并放在该会话绑定列表首位，不覆盖原书或写回旧共享目录。`.arkwb`、旧内部散装书 JSON、`inbox/` 和旧迁移脚本不属于当前导入流程。

完整规则见 [data/README](../data/README.md)。依据：[路径定义](../src/data_paths.py)、[资源解析](../src/worldbook_content.py)、[会话导入导出](../src/session_export.py)。验证入口：[文档来源](../tests/test_document_worldbook_source.py)、[演练资源](../tests/test_tactical_practice.py)、[会话文件夹存档](../tests/test_session_export_folders.py)。

### 3.2 多书范围与条目分层

> 最近核对：2026-10-11（源码与现有用例的静态核对）。

内部世界书采用 schema v3 与 selective 载入；SillyTavern 格式是外部互通输入，导入后归一化。会话用 `worldbook_ids` 保存书顺序，用 `worldbook_scopes` 保存各书快照。首书按顺序派生，相关接口的 `book_id` 省略时操作首书；没有全局默认书回落。

会话创建参数中的 `manual_entry_uids_by_book` 与 `expected_draft_hashes` 按书提交。单书 scope-preview 的 `manual_entry_uids` 仍有效，不能因名字相近一起删掉。载入规则与候选快照不等于书正文冻结，正文仍实时读取。

系统层先于稳定与动态分层判定：`plot_graph`、`lore_bindings`、`story_outline` 不进入候选、Prompt 顺序或 dropped 列表，不计注入条数和 token；带触发词的战斗条目可以注入。Python 与前端的系统类型和围栏集合须同步。全书持久化顺序仍保存所有 UID，实际注入再分稳定、动态两层排序。

分类与文件夹只组织条目。文件夹使用 `entry_groups`、`entry_group_map` 和 `entry_layout`，不能复用酒馆触发互斥的 `group/group_weight`。删除文件夹只解绑条目；移动布局、归属和顺序一次提交。跨层文件夹不会让其条目成为连续注入块。

完整规则见[按需载入](design/worldbook/worldbook-on-demand.md)与[节点作用域](design/worldbook/node-scoped-worldbook-loading.md)。验证入口：[多书会话](../tests/test_session_worldbook_multibind.py)、[系统层](../tests/test_worldbook_system_layer.py)、[文件夹与排序](../tests/test_worldbook_entry_groups.py)。

### 3.3 草稿、自动保存与导出

> 最近核对：2026-10-11（源码与现有用例的静态核对）。

条目、简介和排序使用按书串行队列、generation/CAS 与 sessionStorage 待办镜像。离开页面不销毁协调器，旧响应不能覆盖新草稿；空正文的新条目可切书后找回，失败删除保留墓碑与重试入口。导出前必须排空当前书待办，失败时不能导出旧内容冒充最新稿。

节点配置草稿遇普通 revision 推进时可以保留；真正的并发配置变更仍按旧 revision 冲突，撤销后采用最新服务端基线。删除条目时清除草稿中的失效边与起点。更新既有条目只提交可编辑字段，服务端合并隐藏字段，不能因改正文丢掉 `raw`、`excerpt_source` 或含逗号的单个 secondary key。

token 数是展示估算：U+4E00–U+9FFF 中日韩统一表意文字按每字 1，其余按 Unicode code point 数除以 4 向下取整，不覆写 `budget_tokens`。Prompt 预览也不是当前对话或下一次请求，不能当作模型实际收到条目的证据。

机制归属：[条目工作台方案中的实现记录](proposals/worldbook-entry-refresh.md)、[工作台中的保存协调器](../frontend/src/components/WorldBookManager.tsx)。验证入口：[条目刷新](../tests/test_worldbook_entry_refresh.py)、[工作台脚本](../scripts/test_worldbook_shelf_ui.cjs)。

### 3.4 摘录、封面与资源副本

> 最近核对：2026-10-11（源码与现有用例的静态核对）。

资料库摘录走整批校验与保存。可复制角色 profile 时生成目标书专属角色 ID，并在目标书 `characters/` 中保存独立副本；没有 profile 时保留原角色引用并给出警告。来源目录不改动，保存失败删除本次新建目录，不能留下半批副本。

角色快照只复制当前默认头像、立绘和卡面，不打包所有造型。资源校验上限为单图 20 MB、整书图片 80 MB、单份角色资料 2 MB、整书角色资料 16 MB。导入与整书复制会重新生成目标书专属身份，资源与正文一起维护。

封面从本地选择后压缩为 `data:image/...;base64` 存入 `cover_image`，不是外链。当前压缩长边最多 512，目标最多 160 KB，优先 WebP，回退白底 JPEG；参数与解码回退由 `CoverPicker` 维护，不在别处复制另一套默认值。

完整用途与摘录规则见[资料库](design/worldbook/worldbook-library.md)。依据：[角色资源校验](../src/worldbook_media.py)、[CoverPicker](../frontend/src/components/worldbook/CoverPicker.tsx)。验证入口：[角色媒体](../tests/test_worldbook_character_media.py)、[封面与分层脚本](../scripts/test_worldbook_layer_ui.cjs)。

### 3.5 演出冻结与采样时机

> 最近核对：2026-10-11（源码与现有用例的静态核对）。

图配置使用书内相对资源引用，列表与上传限制在当前书。新会话冻结画面配置，并将图片复制到 `presentation-assets`；历史和回档读取保存的演出帧，而不是之后编辑的世界书节点图。节点未配置新画面时沿用上一背景，CG 是持续画面，不是每个标签页弹窗一次。

图坐标与手工连线不决定触发时机。运行时以剧情引用与本轮实际节拍确定演出，避免节拍提前推进导致画面抢先。条件在创建、作者选择结算与叙述结算时采样，不捕获轮间瞬时变化。

BGM/video 仅保留扩展位置，当前未实现的动作明确拒绝。缺完整媒体或资源快照的旧会话、节点不自动补建；回档先验证再恢复。记忆文件与演出 overlay 不构成跨文件断电事务。

完整规则见[节点演出](design/worldbook/node-presentation.md)。验证入口：[演出用例](../tests/test_scene_media.py)、[引用详情](../tests/test_graph_node_details.py)、[图详情浏览器夹具](../scripts/test_graph_details_browser.py)。

### 3.6 书架扫描与 Wiki 失效

> 最近核对：2026-10-11（源码与现有用例的静态核对）。

书架校验逐层扫描资源，每项不跟随链接地读取属性；仍检查整棵目录的路径、数量、大小、重复 JSON 键，并拒绝符号链接和 Windows junction。性能优化不以过期缓存跳过外部资源验证，加载复用校验得到的 JSON。

书架变化将 Wiki 标脏，实际读取时重建，显式刷新仍立即执行。索引在锁内建成后按快照发布，失败保留旧快照并允许下次重试；已持有的 scoped Wiki 也失效。另一线程正在重建时，失效调用可能等待同一把锁，本机制不承诺无等待，也不重写已注入会话的缓存文本。

依据：[文件夹校验](../src/worldbook_folder_store.py)、[Wiki 缓存](../src/wiki_manager.py)。验证入口：[加载用例](../tests/test_worldbook_loading_performance.py)、[Wiki 延迟刷新](../tests/test_wiki_lazy_refresh.py)。接口历史测速的条件见第七节，不是浏览器整页加载保证。

## 四、前端呈现与窗口

前端细节在固定 PC 内容区和现有主题体系中维护。设计要求见[前端规范](design/frontend-design-guidelines.md)，本节保留容易在实现或验证时误判的行为。

### 4.1 主题、颜色与导航

> 最近核对：2026-10-11（源码与现有用例的静态核对）。

默认皮肤的浅色样式使用 `html.light`；PRTS、Tavern 与默认明暗互斥。固定色板区块需要对应浅色覆盖。覆盖渐变字或壁纸时，优先改 `background-image` 等具体属性，`background` 简写会重置 size、position、clip。

会话删除入口用独立 `.session-delete-button` 处理默认浅色与酒馆配色，不能据这一修复扩大修改通用危险按钮或战斗按钮。颜色工具类覆盖从生成源更新，规则见根 [AGENTS](../AGENTS.md)。

顶栏标签脚沿用标签与底部衔接带的颜色映射；反向圆角圆心位于外侧上角。导航两端预留 12px 标签脚空间，保持可伸缩布局与 `overflow: visible`，不能恢复会把伪元素纳入滚动范围的 `overflow-x-auto`。

依据：[App](../frontend/src/App.tsx)、[全局样式](../frontend/src/style.css)、[GameTopBar](../frontend/src/components/GameTopBar.tsx)。验证入口：[删除配色脚本](../scripts/test_session_delete_colors.cjs)。对比度和历史浏览器结果只适用于记录的控件与主题，不是全站无障碍验收。

### 4.2 节点编辑器视口与输入

> 最近核对：2026-10-11（源码与现有用例的静态核对）。

扩大查看收起书简介，切书或切页签复位。视口尺寸由 ResizeObserver 同步，fit 与裁剪计算包含 CG 预览边界，不能只在平移或缩放变化时重算。图片预览限定当前书、去重，预览和短连线随节点移动。

节点详情中的演出配置使用同一份图草稿、撤销与保存。抽屉输入 Delete/Backspace 不能删除图形，左右键切页签不能抢输入焦点。CG 预览不是背景预览，编辑器显示也不证明会话冻结资源已经更新。

依据：[PlotGraphPage](../frontend/src/components/combat/PlotGraphPage.tsx)。验证入口：[共享引用检查](../scripts/test_graph_references.cjs)、[图详情浏览器夹具](../scripts/test_graph_details_browser.py)。

### 4.3 内容区尺寸与原生窗口

> 最近核对：2026-10-11（源码与控制器模拟检查）；本次未做原生窗口验收。

五组预设表示逻辑像素的内容区，清单由 [windowSettings](../frontend/src/shared/windowSettings.ts) 维护。普通窗口使用 `setContentSize`，窗口全屏为原生最大化，全屏使用 `setFullScreen`；选择预设回到普通窗口，自由拖动不吸附。

设置页将预设与显示模式放在同一个下拉框，选择后立即应用，自定义尺寸显示“自定义”。普通窗口应用预设后，即使按比例适配，`presetId` 仍保留该预设；最大化、全屏或非预设自定义尺寸时为 null。`width/height` 是实际内容尺寸，`fitted` 与状态文案必须反映适配结果，不能仅显示所选预设数字。

Windows 缩放下，定位和内容区设置的先后会影响舍入。应先定位目标工作区，再设置内容尺寸，首次显示也归一尺寸；退出最大化或全屏后重取目标屏幕工作区。适配不等于修改开发视口矩阵，也不能因当前屏幕较小就禁用大尺寸选项。

依据：[窗口控制器](../frontend/electron/windowControls.ts)、[WindowSettings](../frontend/src/components/WindowSettings.tsx)。验证入口：[控制器用例](../scripts/test_window_controls.cjs)、[原生窗口夹具](../scripts/test_window_controls_electron.cjs)。旧记录未证明多屏切换或所有页面已完成五尺寸验收。

## 五、测试与本机环境

测试入口、依赖完整性、SSR 和浏览器提供不同证据。排查环境失败时不要把缺包、转译钩子或资源缺失写成产品行为回归。

### 5.1 Python 入口与 CLI 编码

> 最近核对：2026-10-11（源码与现有用例的静态核对）。

统一入口为 [run_tests.sh](../scripts/run_tests.sh)，分别执行 `tests/` 与两组无外部依赖的 perf 用例。本机没有可用 bash 时，可在仓库根目录分两次执行：

```powershell
python -X utf8 -m pytest tests/
python -X utf8 -m pytest perf_tests/test_combat_runtime_v1.py perf_tests/test_settlement_v1.py
```

这两次测试都通过才能等同于该脚本的成功结果；不包含额外真实模型、浏览器或 Electron 验收。

CLI 输出与父进程解码必须约定一致。`tests/test_combat_growth_balance.py` 的 `_run()` 为子进程设置 `PYTHONIOENCODING=utf-8`，父进程显式指定 `encoding="utf-8"`；仅设置 shell 环境变量不能改变父进程按 locale 解码的默认行为。新增相同 CLI 用例复用该助手，不能把读线程解码错误当作战斗工具失败。

### 5.2 前端命令入口与缺包

> 最近核对：2026-09-28（依赖恢复记录）；2026-10-11 整理，未重新执行安装与恢复。

新 worktree 不包含被忽略的 `frontend/node_modules`。发现 `vite` 或 `tsc` 不可用时，先区分“包文件在、仅缺 .bin”和“包文件也缺失”。

仅入口缺失时，在实际依赖目录执行：

```powershell
npm rebuild --ignore-scripts --bin-links
```

随后检查 `node_modules/.bin/tsc.cmd`、`vite.cmd` 及各自版本。若包文件缺失，按锁文件完整安装，再检查 TypeScript 声明、Vite 与相关包文件，最后构建。出现 `TAR_ENTRY_ERROR` 即使 npm 退出 0，也不能据此认定依赖完整；需要换缓存重装时选择新的任务缓存目录。

先确认目录是否为联接，不在指向主工作区的 `node_modules` 上运行会先清理目录的 `npm ci`。测试若删除依赖，结束前按实际缺失程度恢复入口与包文件。不要只复制空 .bin，也不要把 `npm ls` 成功等同于构建成功。

### 5.3 SSR 转译、状态与自定义面板

> 最近核对：2026-10-11（源码与现有用例的静态核对）。

TypeScript 转译钩子需要传 `fileName: filename`。否则 `.ts` 泛型箭头可能被当作 TSX，运行产物出现 `T is not defined`，并不说明分组函数有错。参考 [test_role_worldbook_nav_ui](../scripts/test_role_worldbook_nav_ui.cjs) 与 [test_stage_ui](../scripts/test_stage_ui.cjs) 的实际钩子；其他脚本需逐个核对，不能声称全部已补齐。

CJS 钩子不能直接 require 含 `import.meta.glob` 的插件入口。当前舞台脚本为该入口提供空自定义模块集合，再显式加载内置注册；它只能证明所加载面板，不覆盖 Vite 的自动发现。不要为迁就测试改动产品的模块发现机制。

SSR 使用 Zustand 的服务端初始快照，`setState()` 后 `getState()` 变化不保证 markup 随之变化。状态迁移可断言 store，静态结构可检查 SSR；页面切换、可见状态和交互要用浏览器。

### 5.4 浏览器夹具、缓存与本地资源

> 最近核对：2026-10-11（源码与现有用例的静态核对）。

截图配置使用独立 Vite 缓存；共用依赖目录的 worktree 仍可能共用 `.vite-shot`。并行服务应显式区分 `cacheDir` 和端口，不以启动另一个服务扰动正在运行的页面。

依赖 Playwright 的脚本可以按其入口使用 `PLAYWRIGHT_MODULE`；模块不可解析是环境缺失，不是产品失败。选择 API 全拦截夹具或临时书籍与会话，真实剧情首次载入可能自动调用模型，不能随手打开用户存档当作无写入预览。

截图脚本会预置 `ark_chat_story_<sid>` 消息缓存以避开首次叙述；这只证明合成内容的呈现。被忽略的书架、Spine 和背景不会自动出现在隔离检出，缺资源时的回退表现不能当作真实模型图片验收。用例应使用临时夹具，不写死本机书数量、条目数或策略版本。

依据：[截图配置](../frontend/vite.config.shot.ts)、[对话截图入口](../scripts/shot_chat_ui.py)、[世界书浏览器夹具](../scripts/test_worldbook_review_ui.cjs)。测试、SSR、合成 API 浏览器、真实 Flask、真实模型与原生 Electron 分别报告；历史窄屏截图不是当前 PC 验收要求。

## 六、战斗与演出

网格、横版与脚本玩法各有状态和演出来源，不能把某一模式的测试结果当作所有玩法的恢复或结算保证。

### 6.1 网格演练与身份

> 最近核对：2026-10-11（源码与现有用例的静态核对）。

空书架的网格演练使用 `data/tactical_practice/` 显式训练内容，不自动安装世界书或向剧情会话注入示例。选择一本书后，节点和角色限定在该书，切书清掉旧选择；缺角色与同显示名歧义明确报错。

会话编成用包含主控的阵容。单位保存角色目录 ID 与实际来源书，结算按 ID 写回；Spine 目录、骨架、图集、贴图与缓存键携带来源，恢复时不能跨书复用同名形象。内联敌人优先于会话自定义与书内敌人文件，模拟器和生产加载不能采用不同来源顺序。

依据：[演练与网格 API](../src/blueprints/combat.py)、[战斗内容加载](../src/combat_data_loader.py)。验证入口：[演练用例](../tests/test_tactical_practice.py)、[恢复用例](../tests/test_combat_resume.py)、[资源纯逻辑](../frontend/src/utils/gridCombatResources.test.mjs)、[演练浏览器夹具](../scripts/test_tactical_practice_browser.py)。

### 6.2 状态、事件与播放顺序

> 最近核对：2026-10-11（源码与现有用例的静态核对）。

动作和结束回合返回 `{state, events}`，HTTP 批次与 SSE 共享事件 `presentation_id`。命令响应负责播放，SSE 是重复传输渠道，不是第二套时钟。先登记批次 ID，逐事件演出和投影血量，最后采用权威快照；提前替换最终状态会使死亡单位在演出前消失。

动作开始递增状态版本，避免先发 GET 覆盖播放投影。移动范围由服务端计算，切角色后需验证响应仍属于当前选择。响应不确定时不能盲目重发动作；同步状态与恢复不等于再次执行结算。护盾事件值是新增量，灼烧值是每回合伤害，持续时间另有字段，最终状态仍是权威来源。

依据：[CombatView](../frontend/src/components/combat/CombatView.tsx)、[演出逻辑](../frontend/src/components/combat/combatPresentation.ts)、[战斗会话](../src/combat_session.py)。验证入口：[表现脚本](../scripts/test_combat_presentation.cjs)、[事件 API 用例](../tests/test_combat_presentation.py)。历史差距见[卡牌表现 QA](card-combat-presentation-qa.md)，不能据此宣称当前所有卡牌已有专属演出。

### 6.3 横版与脚本玩法

> 最近核对：2026-10-11（源码与现有用例的静态核对）。

横版薄平台默认单向，阈值与作者 `oneWay` 覆盖由 `level.ts` 维护；巡逻区间只限制闲逛，追击仍受墙和平台边缘约束。改地形或敌人行为时检查模拟通关策略。

Pixi 7 的 `Graphics.arc()` 会连接上一段末点，每段弧线先 `moveTo` 起点。未启用 `preserveDrawingBuffer` 时，不能仅用 `drawImage` 回读 WebGL 判断是否渲染，需检查实际截图像素。

脚本会话恢复使用冻结版本，不换成安装目录里的新包。网络断开、非 JSON 错误或版本冲突时停止运行并保留最近成功快照；客户端结果需用户确认，不发数值奖励。创建后界面模式直接采用创建响应的 `session.mode`，不能通过旧 sessions 闭包查新 ID。

专题：[横版设计](design/combat/sideview-combat.md)、[当前脚本模式](proposals/combat-mode-plugins.md)。验证入口：[横版模拟](../frontend/src/features/sideview/simulation.test.mjs)、[脚本 PC 历史验收](archive/combat-plugin-pc-qa-2026-10-06.md)。合成模型的 PC 验收不证明 Electron 专有运行、浏览器下载回传或真实模型。

## 七、历史证据的使用范围

> 最近整理：2026-10-11；下表保留原始记录日期，本次未重新执行历史验收。

本节只保留仍有比较或排查价值的历史条件，避免把累计通过数量、旧机器状态和路线实验写成当前保证。

| 历史记录 | 原始记录日期 | 条件与可用范围 |
|---|---|---|
| 书架加载测速 | 2026-09-29 | 同机 5 本书、349 条目，独立 Flask test client 各测 5 次；书架中位耗时从 1321.46 降到 103.32 ms，详情从 54.38 到 53.66 ms。仅为当时接口处理耗时，不是浏览器整页、磁盘或并发性能保证。复现入口为 [bench_worldbook_loading](../scripts/bench_worldbook_loading.py)，比较版本分进程运行。 |
| 舞台流与窗口验收 | 2026-10-06～2026-10-07 | 合成模型/API 浏览器覆盖固定逻辑视口；独立 Electron 夹具使用生产 preload 和窗口控制器，但没有启动生产 Python，也不证明发行包的 file:// 链路。结果目录位于被忽略的 `.tmp/`，不是仓库长期交付物。入口见 [流式浏览器](../scripts/test_stage_stream_browser.py)、[舞台窗口](../scripts/test_stage_window_modes.cjs)。 |
| 灰灯渡口与旧剧情路线 | 2026-09-26（内容记录）；2026-10-04（边界复核） | 本文不附带内容书，恢复需要完整外部副本。脚本化路径、策略模拟、真实模型单条路线与完整人工战斗不是同一种证据；必要选择、主控台词、末节终态及不同路线的真实模型体验没有统一最终证明。删除旧报告不等于解决历史问题。 |
| 演出图片与脚本玩法 | 2026-10-06～2026-10-07 | 真实 React/Flask 搭配离线模型证明对应入口与状态流程；不证明任意模型一致性、用户真实图片、Electron 发行包或完整第三方生态。对应专题与历史报告保留原验收范围。 |

旧共享内容、预装包、散装书迁移成功数字和具体本机存档状态不再是操作依据。设计原因、完整历史方案与目标队列各回到所属文档；需要重新验收时按当前书文件夹、接口和临时数据重新建立条件。
