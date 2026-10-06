# 项目工程笔记（notes）

只记**本项目内、可复现、下次会再撞上**的细节：踩过的坑、口径约定、环境差异、已知未修项。
通用的工程经验、跨项目的方法论**不**放这里；需要长期影响 AI 行为的规则走 `AGENTS.md`
或 `.agents/skills/`，设计目标态走对应的 `docs/*.md` 设计文档。

新增条目请写明：现象 → 根因 → 现状口径 → 证据（文件/用例），并在条目首行标注核对日期与相关提交（如有）。

---

## 前端视觉

### 会话删除入口的浅色配色（核对于 2026-10-06）

- **现象/根因**：公共 `.app-danger-button` 固定深红底色，与浅色主题对 `text-red-300` 的文字覆盖叠加，形成深底红字。
- **现状**：单个与批量删除会话入口使用 `.session-delete-button`，去掉冲突的颜色工具类；仅为默认浅色、酒馆手札定义轻底色与清晰红字，深色/PRTS、通用确认提交按钮和战斗按钮不受影响。
- **证据**：`node scripts/test_session_delete_colors.cjs` 覆盖两处接线、普通/悬停纯色配色与文字对比度（最低 5.47:1）、焦点和主题范围。加 `--serve` 可在 `127.0.0.1:5198/__qa__/session-delete-colors.html` 打开真实组件、模拟 API 的验收页，所有 API 写入被拦截。桌面浏览器 1280×720 验证了四主题计算样式、浅色/酒馆视觉、键盘焦点、单个/批量确认取消与禁用状态；控制台无错误。未执行真实删除、Electron 运行验收或全量后端测试。

## 战斗模式插件

### PC 验收与会话创建模式（核对于 2026-10-06）

- **现象/根因**：新建自由会话后仍显示剧情模式；创建回调先更新 store，再通过旧 `sessions` 闭包查找新 ID，因此未设置聊天模式。创建路径应直接使用创建响应的 `session.mode`；恢复/进入已有会话仍使用各自的真实会话对象。
- **现状**：插件会话的列表/详情/主页恢复信息区分内置引擎，不能默认落入纯剧情或战术回合/手牌展示。管理页使用组件内四主题变量；实际插件运行页标注 `.bg-combat-bg`，阻止外壳皮肤穿透战斗。
- **环境口径**：PC 验收使用真实 React/Flask 和完全隔离的目录；模型输出为显式离线替身。网络断开/非 JSON 服务错误、CAS 冲突均停止运行并保留最近成功快照。浏览器下载事件未回传及 Electron 运行未覆盖要单列，不能用构建代替。
- **证据**：`docs/archive/combat-plugin-pc-qa-2026-10-06.md`，`SessionManagerView.handleCreated`、`HomeMenu`、`CombatModesView` 与 `combatModes.css`；全回归 910 passed/4 skipped，示例及协议测试通过，浏览器四主题与双 PC 视口验收。

## 世界书

### 书架首次打开的加载性能（核对于 2026-09-29）

- **根因**：`GET /api/worldbook` 在返回摘要前逐本遍历资源目录，对每个文件反复检查整条祖先路径；校验后又重复解析 `book.json`，最后同步重建全量 Wiki 索引。条目页还请求了一份没有消费方的 scope-preview。
- **现状**：资源校验改为逐层 `scandir`，每项一次不跟随链接的 stat；仍逐次检查整棵目录、大小/数量/路径/重复 JSON 键，并拒绝符号链接和 Windows junction，不以过期缓存跳过外部资源校验。`load()` 复用校验返回的 JSON。书架继续失效内容可见性等缓存，但 Wiki 只标脏，下次实际读取时重建；显式 Wiki 刷新仍立即执行。条目页不再请求未使用的范围预览，Prompt 预览仍在打开对应页签时请求；分组行用索引生成，避免逐条查找序号和逐组扫描所有条目。
- **一致性**：Wiki 索引在锁内构建完成后按快照发布，不清空正在被读取的目录；失败保留旧快照并在下一次读取重试。已持有的 scoped Wiki 也标脏，预取、目录 API 和统计统一读取快照。若另一线程正在建索引，失效调用仍需等待同一把锁；本项不承诺此并发情形无等待，也不改已注入会话的缓存文本。
- **基准**：同机同数据（5 本书、349 条目），独立 Flask test client 进程各测 5 次，书架中位耗时 **1321.46 → 103.32 ms（-92.2%）**；首本详情 **54.38 → 53.66 ms**。这是接口处理耗时，不是浏览器整页加载时间；实际内容规模、磁盘和并发会影响结果。
- **复现**：`python scripts/bench_worldbook_loading.py --project-root <含现有 data/worldbooks/books 的项目目录> --code-root <待测版本工作树> --runs 5`。脚本不启动完整 App、不调用 LLM、不写书籍或会话；比较版本必须分开运行。
- **验证**：全量 `tests/` 加统一入口的两组离线 perf 测试 **813 passed / 4 skipped**（空地图参数集 1、符号链接权限 3）；生产构建及 shelf/scope/library 前端脚本通过。Chrome 隔离 mock 验收覆盖 254 条目、搜索/展开、自动保存后切书回读、首次失败恢复与 390px 浅色布局，无页面横向溢出。核心回归为 `tests/test_worldbook_loading_performance.py`、`tests/test_wiki_lazy_refresh.py`；未重启用户正在运行的后端，生效需重启。

## 会话

### 剧情舞台选项与固定对话区（核对于 2026-10-04）

- **根因**：选项曾放在 `.stage-dialog-wrap` 的普通文档流里，叠加对白结束后才挂载的输入框，导致选项出现时底部对话框上移。
- **现状**：`StageView` 使用独立中央选项区和底部对话区；选项超高仅自身滚动，对话框定高、长对白内部滚动。`ChatPanel` 在播放/等待时保留输入区布局，但隐藏并禁用输入控件，普通舞台和纯舞台均不因选项出现而移动对话框。
- **内容边界**：`StoryChoices` 只显示行动正文和必要的禁选原因，不显示来源、意图分类、条件/效果摘要；分支 ID、禁选判定和发送流程不变。完整规则仍由节点详情的 `BranchRuleSummary` 展示。已删除底部流式选项覆盖样式、选项标题和来源标签样式。
- **快捷键**：舞台或对白获得焦点时，`End` 一次跳过本轮全部对白并显示选项（无选项则显示自由输入），不自动选择或发送；`Ctrl` 仍为逐句/长按快进。输入控件、组合键、输入法合成、长按重复事件、生成/战斗锁定、绘图/CG 与立绘调整时不触发 End。跳过状态随脚本游标保存，让末句全文与选项同时显示，避免游标变化后的打字机 effect 重置；回看上一句、新一轮和新变体恢复正常播放。
- **验证**：`node scripts/test_stage_ui.cjs`、`node scripts/test_story_rules_ui.cjs`；后者的 SSE 夹具须显式设置 `activeSessionId` / `currentView: 'chat'`，匹配当前仅刷新可见会话的契约。`python scripts/test_stage_choices_browser.py` 配合独立 Vite `:5178`（启动方式见脚本）拦截所有 API，覆盖 1440×960、1366×768、1280×720、选项出现前后坐标一致、纯舞台、长选项滚动、焦点、分支 ID、先编辑再发送、自由输入及控制台。截图在 `.impeccable/review/stage-choices/`；不涉及真实存档、LLM 或后端全量回归。
- **End 回归**：同一浏览器脚本另覆盖普通/纯舞台、多句/单句/无选项、末句逐帧不回退、重复按键、回看/新轮/变体重置、组合键/输入法保护、Ctrl 短按/长按、输入框光标、生成/战斗锁定和立绘调整；断言快进不新增叙述请求或轮次。

### 头像失败恢复与异步会话隔离（核对于 2026-10-04）

- **现象与根因**：快速退出加载中的战斗剧情会话再打开另一会话，后台 SSE 会把战前简报写进全局单槽，导致另一会话弹窗、输入锁甚至跳转战斗；打法返回与战后续写也没有完整的来源隔离。头像组件在会话图片失败后改请求不带会话的全书资源，且资源更新不会清除失败状态；角色列表请求迟到也能把旧阵容画到新会话。
- **现状口径**：消息、简报、自动续写按 session ID 保存。后台叙述仍继续，但只能写自己的数据；简报弹窗、最小化入口和输入锁只属于当前会话。检定结果绑定具体简报，延迟开战/恢复请求校验导航代次，切走再切回也不自动抢占页面。替换流、删除会话、SSE close/done/error 后，旧事件不得复活缓存或再次派发。
- **头像边界**：图片地址包含会话与资源版本，失败只对该地址显示首字占位；版本/会话变化后重试，不向未绑定的世界书兜底。服务器负责会话覆盖与绑定书的解析。现场只读检查中，彼岸双生第 2～4 个会话的四名角色头像均返回 200；第 1 个会话未绑定世界书，404 是资源范围结果，未自动修改其存档或添加兼容旁路。
- **验证入口**：`node scripts/test_session_isolation.cjs` 覆盖来源、后台触发、替换流及删除；`node scripts/test_sse_lifecycle.cjs` 覆盖 34 项流终止/分片/延迟读取；`python scripts/test_session_isolation_browser.py` 使用独立 Vite `:5193`（`npm exec vite -- --config vite.config.shot.ts --host 127.0.0.1 --port 5193 --strictPort`），所有 API 为合成响应，不写真实存档或调用 LLM。覆盖头像失败刷新、旧简报/检定/绕行/开战/错误迟到、最小化、返回原会话续写、导航往返、恢复请求、旧阵容与初始加载取消；截图为 1440×960 / 390×844。
- **验收边界**：完整离线 Python 回归 829 passed / 4 skipped；前端构建、现有舞台/主控/剧情树逻辑脚本与上述定向测试单独验收。没有重启正在运行的后端，也没有自动绑定旧存档的世界书。
- **审查补充回归**：手动开战返回的打法列表也校验请求代次、会话清理代次、简报身份与导航代次；头像 A→B→A 重新尝试；隐藏页面回到原会话时补拉后台更新。浏览器脚本覆盖这三条，不能仅凭 SSE 路径通过就认定手动入口也安全。

### 大厅与新建向导的目录加载（核对于 2026-09-28）

- 原先大厅和向导各请求一次剧情、世界书、角色目录，向导的模式页还被三个请求一起阻塞。现在 `useSessionCatalog` 由大厅持有，向导复用数据和进行中的请求；StrictMode effect 重放也不重复请求。离开大厅后不保留全局缓存，重新进入会重新取目录。
- 模式页立即可选；依赖目录的步骤在加载或任一请求失败时不能继续。失败明确指出目录类型，重试不清掉表单；关闭后重开才重置。没有直接移除后端文件夹安全校验、外部文件变化检测或 Wiki 刷新，首次目录读取仍可能耗时。本项不代表「创建并进入」的真实数据初始化耗时已优化。
- 创建客户端已统一发送 `manual_entry_uids_by_book`，不再发送服务端不使用的旧 `manual_entry_uids`。单本书 scope-preview 自身的 `manual_entry_uids` 仍是有效接口，不能混删。
- 证据：`scripts/test_session_loading_browser.py`（:5185、API 全拦截）覆盖目录请求复用、冷加载、三类失败重试、表单重置及创建载荷；每个请求合成延迟 600ms 时，热打开模式页从约 906ms 降为 66ms，非真实内容库性能基准。`scripts/test_session_main_control_ui.cjs` 与主控/多书 pytest 保留契约覆盖。
- 大厅首卡 hover 的上描边裁切由列表自身 `overflow-y-auto` 且无顶部内边距造成；列表增加 `pt-2`，不调整搜索框层级。上述浏览器脚本同时检查 1440/390 宽度、深浅主题及 PRTS/酒馆皮肤下的搜索后首卡边距。

### 会话完整节点图（核对于 2026-10-04）

- **全图与位置**：会话复用世界书 `GraphCanvas`、`importLayoutFromFlow` 的主线横排与分支排序，不再分成路线/会话轨迹两个区块。按会话绑定书查找剧情，跨书引用以 `flow.worldbook_id` 确定归属书并读取其已保存图；保留保存位置、自由节点和作者连线，补齐缺少的结构节点。未来节点置灰。无作者结构的会话使用同一画布显示生成树，战斗专用作者图须保留未来战斗引用。
- **头像口径**：头像代表主控及场景角色共同的位置。`tree.current_id` 验证当前场景存在，`stage?round=N` 的轮次媒体定位实际叙述节拍；不按可能已提前推进的 `ref_beat_id` 或章节数组顺序推断抵达。实际战斗定位战斗引用；无可靠节拍锚点时补当前场景卡，舞台查询失败且当前树节点/轮次未变时保留已加载媒体定位。
- **连线与交互**：共享布局中可选作者分支保留顺序出口，必选分支移除默认出口。会话模式仅允许节点拖动、画布平移/缩放/适应和选择，封锁编辑内容、增删节点、连接/重连菜单。拖动坐标按会话/剧情/来源书隔离存于本地，引用节点用稳定身份匹配，不写回世界书或剧情进度。图下方不显示详情、选项或行动输入；顶部保留定位、对话记录和返回舞台。
- **刷新边界**：`ChatPanel.triggerNarrate` 在请求开始就增加轮次，图须在 `sessionStreaming` / `sessionSending` 结束后读取已提交状态，剧情与轮次舞台结果成对提交；回档、场景与角色变化同样刷新，失效请求不得覆盖新会话。
- **验证入口**：`node scripts/test_session_graph_ui.cjs` 覆盖世界书同布局、已保存图/连线、补齐全图、本地坐标、未来/本轮定位、回档、战斗专用图、必选/可选出口、12,000 节点深链及会话/编辑器 SSR；`node scripts/test_graph_references.cjs` 覆盖共享引用与布局。`node scripts/test_story_rules_ui.cjs --serve` 启动独立 API 模拟页面 `:5191` 用于桌面拖动、缩放、刷新位置和记录模式验收；自动浏览器脚本仅维护，本次不运行。
- **验收边界**：桌面浏览器验收使用模拟会话，覆盖全图、定位、回档、场景加载失败、生成中、剧情加载失败、空状态及记录输入恢复；不验证真实 LLM、真实回档写入或万级节点浏览器性能。为避免触发 `ChatPanel` 的首次自动续写，不要在全新浏览器来源打开用户真实剧情会话做验收。后端新增的 `choice_required` 投影需要后端进程载入新代码，未获保存工作确认前不重启正在运行的服务。

### 新建向导：选中剧情即自动选中世界书与该书全部角色（2026-09-27，`feat/plot-autoselect-roster` / `feat/worldbook-roster-autoselect`）

- **现象**：剧情书与角色卡的来源书不同，向导曾漏掉角色和开场阵容。
  frontmatter 的 `worldbook_id` 可能仍是拆分前的来源书（`arknights`），与剧情绑定书不同。
  按角色卡来源书筛选候选会漏掉该剧情书的角色；只读取 `initial_characters` 也会漏掉书内花名册。
- **现状口径**：
  - **书内角色花名册的唯一来源是条目**：新增 `WorldBook.character_ids()`（启用且非系统条目的
    `character_id`，去重保序），随 `/api/worldbook` 摘要返回 `character_ids`。角色的
    `worldbook_id` 是「角色卡来源书」，拆分剧情书里它与绑定书不同，不能当书内名单用。
  - 剧情 frontmatter 新增可选字段 `player_identity`（默认主控），`worldbook_id` 也由 `/api/plots`
    一并返回。选中剧情即自动绑定这本书（书未安装时保留玩家当前选择）；主控取 `player_identity`，
    缺省回退开场角色首位；**该书的角色花名册 + 剧情开场角色整批入队**并标「自动预选」。
    规则只有一份实现：`utils/characterCatalog.ts` 的 `resolvePlotDefaults` /
    `resolveLineupDefaults`（`scripts/test_session_main_control_ui.cjs` C 段钉住）。
  - **候选 = 已绑定世界书的角色 + 各书花名册 + 剧情自带阵容**（`selectableCatalogItems`）；
    未绑定任何书时仍只有自建角色 + 剧情阵容。
  - **自动选中只吃「剧情声明的那本书」的花名册**（`resolveLineupDefaults` 的 `rosterBookIds`）：
    手动再加一本可能是几百角色的大书时只扩候选，不静默把阵容塞满；要一并选上走队友区的显式按钮
    「按绑定世界书全选角色」（`selectAllBookCharacters`）。
  - **开场角色口径统一**到 `session_overlay.plot_initial_characters`：只读取
    `initial_characters`；显式空数组表示没有开场角色。服务端开场加载与 `/api/plots` 共用这一份口径。
    2026-09-28 起重载只恢复已保存的阵容，不再把空 NPC 列表回填开场人物；物品恢复独立于 NPC。
- **向导边界**：「主控与阵容」这一步只选角色；候选范围按当前 v3 规则解析。创建接口按书提交
  `manual_entry_uids_by_book` / `expected_draft_hashes`，不再接受首本书的单数参数。
- **命名创建只报 token**：该步不再渲染整块 `WorldBookScopePreview`，只列每本书的「估算 token」——
  「候选规模减少 0 token（0%）」这种无信息量的行不再出现；候选条目明细在世界书工作台看。
- **已知边界**：会话大厅的「添加角色 / 换主控」候选仍是**按角色卡来源书**过滤
  （`SessionManagerView.tsx` 的 `candidateItems`），绑定拆分剧情书的会话里同样列不出该剧情的角色；
  本次只改新建向导。要一并统一时，两处都调 `characterCatalog.selectableCatalogItems`。
- **证据**：`src/world_book.py`（`character_ids` / `_summary`）、`src/blueprints/sessions.py`
  （`/api/plots`）、`src/session_overlay.py`（`plot_initial_characters`）、
  `src/session_manager.py::_restore_scene`、
  `frontend/src/utils/characterCatalog.ts`、`frontend/src/components/session/CreateSessionWizard.tsx`、
  `scripts/test_session_main_control_ui.cjs`（C 段）、
  `tests/test_worldbook_system_layer.py`（花名册与摘要）、`tests/test_data_layout.py`。

### 多本世界书绑定口径（核对于 2026-09-28）

- **现状口径**：`worldbook_ids` 按选择顺序保存所有剧情书，`worldbook_scopes` 按书 ID 保存各书会话快照；不再写入或读取单数存储字段。依赖和条目覆盖接口以 `book_id` 选择具体书，省略时操作按顺序派生的首本书。全局默认书不再回落，未绑定书的会话不注入世界书。
- **创建接口**：`manual_entry_uids_by_book` / `expected_draft_hashes` 分别按书提交手动条目与预览指纹。统一角色数值字段仍沿用首本书的 `stat_fields`；跨书字段合并尚未设计。
- **证据**：`src/session_overlay.py`、`src/world_book.py`、`src/blueprints/sessions.py`、`tests/test_session_worldbook_multibind.py`。

### 主控角色与「角色入队」是同一次选择（2026-09-23，`feat/session-main-control`）

- **口径**：会话**阵容 = 主控角色（玩家身份）+ 队友**。`SceneManager.get_roster()` 是服务端口径
  （主控在前、按名去重，`Session.to_dict()["roster"]` 与候选范围的 roster 都用它）；
  `get_scene_characters()` 只有队友 —— 主控由玩家自己扮演，模型不替玩家说话；对应 pytest
  钉住「玩家身份不得出现在场景角色里」。
  同一角色只出现一次：主控经 `identity` 声明、队友经 `roster_character_ids` 入队，两边都不重复。
- **创建契约**：`POST /api/sessions` 的 `identity` **显式传空 = 明确没选主控 → 400**
  （前端向导也先拦一次）；**完全不传**该字段才回落通用称谓「玩家」，只服务不使用新流程的调用方
  （集成脚本 / 老用例）。见 `tests/test_session_main_control.py`。
- **预览与创建必须同口径**：候选范围的 roster 取 `get_roster()`，因此向导的 `scope-preview`
  必须传**含主控的完整阵容**（`useRosterScopePreview(bookId, lineup, …)`），否则创建时的
  `expected_draft_hashes` 校验会判「预览已过期」并 400；自建主控与世界书主控都由独立 pytest 覆盖。
- **换主控要重算范围**：`SessionManager.set_player_identity` → `SceneManager.set_player_identity`
  → 按新阵容 refresh。会话依赖面板（`blueprints/sessions.py` 的 `_get_managed` 与四个 PATCH）
  也一律用 `get_roster()`；用 `get_scene_characters()` 会让面板第一次打开就把主控从快照里刷掉。
- **来源只能看 frontmatter `worldbook_id`**：空/缺字段 = 自建，非空 = 世界书（空白串不归一，
  与 `tests/test_document_worldbook_source.py` 一致）。`/api/characters` 已带 `name` / `summary` /
  `worldbook_id`，前端不再为「玩家身份」另开一个接口（`/api/player-identities` 仍服务于
  角色页的身份管理与标记，但**不再**决定谁能当主控）。
- **已知边界**：战斗编成（`shared/helpers.build_character_metas`）仍只按**场景角色**组队，
  主控不进战斗队伍；本次改动没动战斗侧。

### 历史剧情验收的证据边界（核对于 2026-10-04）

- 旧灰桥候选、验收报告与结果 JSON 已删除，其测试和验收脚本此前已移除；Git 历史可追溯，但历史 xfail、真实模型轮数和战斗模拟不能作为当前回归覆盖。
- 历史问题包括开场上下文混入后续章节、任务未随叙述自动完成、末节缺明确终态、非法任务 ID 被接受、叙述变体保存失败、真实模型节拍停滞。当前没有重新验收整条真实模型路径，不把删除报告当作修复。
- 静态核对仍见两处契约缺口：`blueprints/chat.py` 的 `narrate-update` 读取 `text` 并调用单参数，而前端发送 `round/narrative`、`Session.update_narration` 需要两参数；`blueprints/environment.py` 的任务 PATCH 只检查状态枚举，未检查任务 ID。本次仅保留待办，不修改功能。
- 空阵容重载回填路径已移除；`tests/test_story_rules_http.py::test_restore_scene_without_npcs_keeps_inventory_without_llm_probe` 覆盖空 NPC 不补角色、不探测模型，并保留场景物品。分支回档当前证据见 `tests/test_story_rules_http.py` 与 `tests/test_story_tree_full_flow.py`。
- 已删除体验路线图中的遗物/士气/指挥官、位移/陷阱卡、删卡/强化卡是未承诺实施的备选方向；若重启设计，须按当前书内数据结构重新评估，不沿用旧共享目录定位。

## 对话页

### 说话人归属：证据优先，不跨旁白猜测（核对于 2026-09-28）

- 旧前端回退解析按引号前最近的角色名字归属，会把「临光对瑕光说」错认成瑕光；短旁白后还会继承上一位角色。现在只采纳已知角色的明确署名或受限发言谓语，支持前置/后置署名与 `「」` / `“”`，仅标点相连的台词可连续继承。提及、注视、复杂或否定句不猜测角色。
- 结构化片段中显式 `speaker: null` / 空值保留未知；只有紧邻台词且完全缺失字段时才延续上一位。旁白及非法片段清掉继承链。舞台不再用消息角色覆盖结构化片段的未知说话人，与气泡显示一致。没有修改存档或服务端协议。
- 证据：`frontend/src/utils/dialogueParser.test.mjs`、`scripts/test_stage_ui.cjs`、`scripts/test_dialogue_browser.py`（1440/390 宽度，API 全拦截，气泡/舞台未知说话人与明确署名一致）。这是保守的规则修复，不是通用自然语言理解：复杂倒装、未登记别名、模型明确写错但格式合法的 speaker 仍需内容侧修正；不声称所有对话都能正确归属。

### 角色数值的字段解析：会话绑定书优先，不是角色自己的书（2026-09-23，`feat/session-stage-panels`）

- **口径（2026-09-28 更新）**：会话里某角色用哪套统一字段，取**会话绑定顺序中的首本世界书**（`stat_fields`）。
  首书没有字段或无法加载时不回退另一套 schema；仅未绑定书的会话可以使用角色来源书字段。
  `session_stats.resolve_session_character_stats` 统一面板、提示词和剧情规则的读值；角色页全局数值仍看角色来源书。
  两处不一致时以会话为准——
  `tests/test_character_stats_api.py::test_session_stats_merge_and_bound_book_fields` 钉住。
- **值的三层**：字段默认 → frontmatter `stats` → `overrides.json.character_stats`。显式定义的默认值（含 0 / false）
  同样进入 `<character_stats>`，主控和队友读同一接口。叙事战斗模式的角色详情 `progress` / `combat_stats` 为 null，
  不再展示战术 Lv1 / XP0 / HP 等兜底；战术与横版保留内部派生值。
- **快照完整性**：`character_stats` / `plugin_data`、场景物品及效果凭据随节点回档。目标缺少当前资源快照字段时，
  在剪裁历史之前明确拒绝；不把缺键解释为空库存或保留未来数值，不自动迁移旧节点。

### 舞台模式只演「最新一段」，完整记录靠同一份 DOM 换外观（2026-09-23）

- 舞台（`StageView`）不复制消息流：`ChatPanel` 里那个消息列表在舞台模式下用 `hidden` / `stage-log-overlay` 两个类
  切换外观，「记录」按钮打开的是同一份 DOM。`bottomRef.scrollIntoView` 在 `display:none` 下是空操作，打开抽屉时再滚到底。
- 脚本键 `index:round:variantIndex:s|d` 一变就从第一步重来：切变体、回档、新一轮都会重置游标；流式中键带 `:s`，
  只有实时文本一步，不做逐步推进。
- 截图脚本（`scripts/shot_chat_ui.py`）靠**预置 localStorage `ark_chat_story_<sid>`** 让 `ChatPanel` 走缓存路径、
  不触发首轮叙述，因此不会调用模型；后端会话的 `narration_count` 仍是 0，页头 ROUND 取本地与后端的较大值。

### `plugins/index.ts` 的 `import.meta.glob` 不能被 CJS 断言脚本 require（2026-09-23）

- **现象**：`node scripts/test_stage_ui.cjs` require 到 `components/ChatView.tsx` → `plugins/index.ts` 时报
  `exports is not defined in ES module scope`。
- **根因**：`ts.transpileModule` 转成 CJS 后 `import.meta` 仍在，Node 判定该文件是 ESM 再去当 ES 模块加载。
- **现状口径**：断言脚本在转译钩子里对该文件路径直接 `module.exports = { CUSTOM_PANEL_MODULES: [] }` 顶替，
  内置面板改为显式 `require("plugins/builtin.tsx")` 登记。新写脚本照抄；不要为迁就钩子把 glob 从 `index.ts` 挪走。

## 前端主题

### 自带固定色板的区块必须成对写浅色覆盖（2026-09-27，`361c669`）

- **口径**：`frontend/src/style.css` 里默认（深色）色板写在基类上，浅色覆盖写成 `html.light <选择器>`
  紧跟在基类之后；皮肤 `html.skin-tavern` / `html.skin-prts` 各有自己的色板，三者互斥——
  `App.tsx` 只在 `skin === "default" && theme === "light"` 时挂 `html.light`，皮肤激活时不挂浅色。
- **踩坑**：只写深色色板、漏了 `html.light` 的区块（会话大厅的 `session-hero`、`session-practice-panel`）
  在浅色模式下原样保留深色底，成了浅色页面上的一条黑带。覆盖时注意两点：带
  `background-clip: text` 的渐变字、带 `background-size: cover` 的壁纸槽位要用 `background-image`
  长手覆盖，别用 `background` 简写（简写会把 size / position / clip 一并重置）。
- **验证**：参照 `scripts/shot_roles_ui.py`，用 playwright 逐个切 `<html>` class 后截图，并用
  `getComputedStyle` 取 `.session-hero` 的 background-image / 边框色 / 投影做对照。

## 测试

### 前端 `.bin` 命令入口或包文件缺失（2026-09-28，基线 `f27090e`）

- **现象**：`frontend/node_modules` 存在，`typescript` / `vite` 包也在，但
  `frontend/node_modules/.bin` 不存在，`npm run dev` / `npm run build` 因找不到 `vite` / `tsc` 失败。
  补齐 `.bin` 后，构建又发现 `@alloc/quick-lru` 缺失；随后一次 `npm ci` 虽退出 0，解包时却有大量
  `TAR_ENTRY_ERROR ENOENT`，TypeScript 的 `lib.dom.d.ts` 等文件仍缺失。
- **根因与边界**：`.bin` 中的命令入口由 npm 根据已安装包生成，不能只凭 `node_modules` 目录存在
  或 `npm ls --depth=0` 成功判断入口完整。本次未找到删除 `.bin` 的确切命令；另外，
  `frontend/node_modules` 被 Git 忽略，新 worktree 不会自动带入依赖。测试或其他操作若删除了整棵
  `node_modules`，包文件也已经缺失，单独重建 `.bin` 无法恢复它们。排查中 `npm cache verify`
  曾报缺少缓存文件，但当时有并行校验，不能据此判定缓存损坏；安装结果仍须由文件检查和构建验证。
- **恢复口径（Windows）**：先确认当前 `frontend/node_modules` 是否为目录联接，以及
  `node_modules/typescript/bin/tsc`、`node_modules/vite/bin/vite.js` 是否仍在。若包文件在、仅入口缺失，
  在**实际依赖目录**执行 `npm rebuild --ignore-scripts --bin-links`，然后检查
  `node_modules/.bin/tsc.cmd` 和 `node_modules/.bin/vite.cmd` 并分别运行 `--version`。这一步会重建
  已安装包的命令入口，不必重新下载所有依赖。若整棵目录或包文件缺失，在该 worktree 内按锁文件
  完整安装一次，或复用已经核对版本且 `.bin` 完整的依赖目录；若安装时出现
  `TAR_ENTRY_ERROR` 且包文件仍缺失，可改用新的缓存目录重装（本机验证命令：
  `npm ci --cache "$env:TEMP\ark-tavern-npm-cache-20260928" --maxsockets=1`；后续另选空目录）
  并以构建为准。不要只复制空的 `.bin`，也不要在指向主工作区的目录联接上运行会先清理
  `node_modules` 的 `npm ci`。测试结束后按上述两种情况恢复，并验证命令入口再进行构建验收。
- **证据**：主工作区的 `node_modules` 包目录存在而 `.bin` 缺失；执行上述 `npm rebuild` 后
  `.bin` 恢复，`vite.cmd --version` 输出 `vite/5.4.21`，`tsc.cmd --version` 输出 `5.9.3`；
  但构建继续发现缺包，说明入口检查不能代替完整构建。改用独立新缓存完整安装后，
  `.bin`、`@alloc/quick-lru`、TypeScript 声明文件齐全，`npm run build` 通过。

### 无浏览器 SSR 脚本的转译钩子必须传 `fileName`（2026-09-22，`feat/roles-ui-polish`）

- **现象**：`node scripts/test_role_worldbook_nav_ui.cjs` 自 `d328ce0`（引入 `utils/worldbookGrouping.ts`）起一直
  失败：`ReferenceError: T is not defined`，栈指向 `worldbookGrouping.ts:35`；看起来像分组逻辑坏了。
- **根因**：钩子调用 `ts.transpileModule(source, { compilerOptions: { jsx: ReactJSX, … } })` 没传 `fileName`，
  TypeScript 只能把源码当 `.tsx` 解析；`.ts` 里的泛型箭头函数 `<T>(items) => …` 被读成 JSX 元素 `<T>`，
  产物变成 `exports.groupByWorldbook = (0, jsx_runtime_1.jsxs)(T, …`，运行到这一行就抛未定义。
- **现状口径**：该脚本的钩子已传 `fileName: filename`。`test_worldbook_library_ui.cjs` /
  `test_worldbook_scope_ui.cjs` 的钩子写法相同，只是暂未 require 到含泛型箭头函数的 `.ts` 才没炸；
  新写 SSR 脚本请照抄带 `fileName` 的版本，`.ts` 里也不要为了迁就钩子改写成 `<T,>`。
- **证据**：不传 `fileName` 转译 `worldbookGrouping.ts` 第 35 行即得上述 `jsxs(T, …)` 产物；主工作区在
  `d466817` 上跑原脚本同样失败，与本分支的 UI 改动无关。

### 截图服务与开发服务使用独立 Vite 缓存（核对于 2026-09-28）

- `frontend/vite.config.shot.ts` 使用 `node_modules/.vite-shot`，与主开发服务的依赖预构建缓存分开；两种插件配置共用缓存会导致正在运行的页面重载。
- 多个 worktree 若共用 `frontend/node_modules`，也会共用 `.vite-shot`。并行截图服务应各用独立的 `cacheDir`；若端口被占用，连同端口一并调整。

### 世界书条目工作台持久化口径（2026-09-22，`feat/worldbook-entry-refresh`）

- **顺序**：未显式保存 `entry_order` 时使用既有注入排序；首次拖动后写入完整 UID 排列，新增、摘录、
  lore-binding 首次补条目时同步追加。实际收集仍先分稳定层与动态层，再按显式顺序排列；UI 禁止跨层拖动。
- **自动保存**：条目、简介与排序共用按书串行队列、generation/CAS 和 sessionStorage 待办镜像。
  页面卸载不销毁协调器；旧响应不覆盖新草稿；空正文的新条目可切书后找回；删除在旧创建请求结束后继续执行，
  失败保持墓碑并提供重试。导出前必须排空当前书待办，失败时不导出旧内容冒充最新稿。
- **配置版本**：条目、元信息、排序、删除成功后重取完整详情。节点配置草稿只在普通 revision 推进时保留；
  真正的并发配置变化继续按旧 revision 冲突，撤销后采用最新服务端基线。删除条目会从未保存草稿清掉失效边与起点。
- **隐藏字段**：既有条目更新只提交界面可编辑字段，服务端合并旧值；`secondary_keys` 中含逗号的单项、
  `excerpt_source` 与 `raw` 不因只改正文而变化。
- **token 展示**：中日韩统一表意文字 U+4E00–U+9FFF 每个计 1；其余按 Unicode code point 数除以 4
  向下取整。该数仅供展示，不覆写 `budget_tokens`。
- **证据**：`tests/test_worldbook_entry_refresh.py` 覆盖元信息导出回读、完整排列与实际收集顺序、
  过期 revision 不落盘、隐藏字段部分更新；三个 `scripts/test_worldbook_*_ui.cjs` 覆盖工作台页签与真实组件 SSR。

### 条目文件夹与触发互斥组是两套概念（2026-09-27，`f59b9a8`）

- **现象**：条目原有 `group` / `group_weight` 字段用于酒馆触发互斥；直接把它用作管理界面的文件夹会改变解析规则。
- **现状口径**：书级 `entry_groups` 保存文件夹名称，`entry_group_map` 保存条目 UID 到文件夹 ID 的归属，`entry_layout` 保存文件夹与未分组条目的共同顶层顺序；组内条目再缩进。新建空分组放在列表顶部，文件夹可与未分组条目混排；未显式保存 `entry_layout` 时按“未分组条目在前、文件夹在后”显示。移动条目、移动或删除文件夹时，界面把布局、归属和完整 `entry_order` 一次提交；Prompt 的稳定层与动态层分别依新顺序注入，跨层文件夹不会成为单个连续块。纯元数据客户端可不传布局和排序。删除文件夹只解绑条目，删除条目与系统节点时清理映射。
- **证据**：`tests/test_worldbook_entry_groups.py` 验证持久化、CAS、复制、导入导出、原子排序与分层注入；`tests/test_plot_graphs.py` 和 `tests/test_story_outline.py` 覆盖系统条目删除与清理。

### 条目摘录与角色资源副本（2026-09-27）

- 从资料库多选摘录仍走 `POST /api/worldbook/<id>/excerpt` 的整批原子接口。带有效 `character_id` 的角色条目会把 `index.md` 与默认头像、立绘、卡面快照写入目标书的 `character_profiles` / `character_media`；角色条目改用目标书专属的 `<角色ID>__wb_<书ID>`，同时在角色目录生成可供现有互动与战斗链路读取的独立副本。来源目录不改动，保存书失败会删除本次新建的角色目录。
- 书内资源随酒馆 JSON 扩展导出、导入和整书复制；导入/复制时重新生成目标书专属角色 ID 与角色目录。会话中的形象解析顺序为会话覆盖 → 按绑定顺序查书内快照 → 全局角色目录；没有角色资料或图片时摘录结果会带可见警告。每张图片上限 20 MB，整书图片总量上限 80 MB，单份角色资料上限 2 MB、整书角色资料总量上限 16 MB；只快照当前默认图片，不打包同目录的其它造型变体。
- `tests/test_worldbook_character_media.py` 覆盖资源副本、导出导入、保存失败回滚、绑定顺序和舞台取图。

### 本机跑测试的等价命令（2026-09-19）

本机（Windows + conda python）**没有可用的 bash**：`bash scripts/run_tests.sh` 里的 `bash` 实际落到
WSL，而本机未安装 WSL。等价做法：

```powershell
python -m pytest tests/ perf_tests/test_combat_runtime_v1.py `
  perf_tests/test_settlement_v1.py
```

### CLI 夹具必须自己钉死 UTF-8（2026-09-19，`f6ea4e7`）

- **现象**：`tests/test_combat_growth_balance.py` 里 4 个用例在 `PYTHONIOENCODING=utf-8` 的 shell 下
  报 `_readerthread UnicodeDecodeError: 'gbk' codec`，看起来像工具坏了。
- **根因**：工具 CLI 输出中文；子进程按环境变量写 UTF-8，而父进程 `subprocess.run(text=True)` 按 locale
  （Windows 是 GBK）解码 → 读线程抛错。夹具受**外部环境变量**影响，不在工具本身。
- **现状口径**：`_run()` 统一 `encoding="utf-8", errors="replace"` 并给子进程注入 `PYTHONIOENCODING=utf-8`；
  `balance_audit` 也走同一个 `_run()`，不再自己拼 `subprocess.run`。
- 新增 CLI 用例请复用 `_run()`，不要另写 `text=True` 而不指定 `encoding`。

### 本地已安装书的数据不能作为固定测试基线（核对于 2026-09-28）

- `data/worldbooks/` 被 Git 忽略，安装数量、条目与策略版本会因本机状态变化。相关用例应使用临时夹具，或按实际候选对、保存前状态计算期望值；不要写死某本书的条数、批次数或 v3 开关。

### SSR 断言不能靠修改 Zustand store 驱动画面（核对于 2026-09-28）

- `scripts/test_*_ui.cjs` 通过 `react-dom/server` 渲染时，React 读取 Zustand 的服务端初始快照。即使 `useAppStore.setState()` 后 `getState()` 已变化，SSR markup 仍可能是初始界面。
- 状态迁移可直接断言 `getState()`，静态组件接线可检查源码或与状态无关的 markup；需要验证切页、交互与可见状态时用浏览器。`scripts/test_worldbook_review_ui.cjs` 需可解析的 Playwright 模块（可通过 `PLAYWRIGHT_MODULE` 指定），不能把模块缺失误判为产品回归。

## 世界书前端

### 世界书条目的稳定层、动态层与系统层（核对于 2026-09-28）

- 系统条目由 `src/world_book.py:is_system_entry()` 判定，前端 `frontend/src/utils/worldbookLayer.ts` 保持同口径。先判系统层，再按位置区分稳定层与动态层；`plot_graph`、`lore_bindings`、`story_outline` 属系统层，带关键词的 `combat_node` 仍可注入。
- 系统层不进 Prompt 的 `order` 或 `dropped`，不进会话候选或会话条目列表，也不计入可注入条数与估算 token。`book_entry_stats()` 是后端统计口径，前端 `bookEntryStats()` 与之对齐。
- 条目页按稳定、动态、系统展示；系统条目不可单独拖动，但所在文件夹可移动。持久化的 `entry_order` 仍是全书 UID 排列，实际注入时再按稳定层与动态层分区。
- Python 与 TypeScript 各有 `SYSTEM_ENTRY_TYPES` / `SYSTEM_ENTRY_FENCES`，改动任一侧都要同步另一侧。验证见 `tests/test_worldbook_system_layer.py` 和 `scripts/test_worldbook_layer_ui.cjs`。

### 世界书封面是内嵌 data URL，不是图片地址（2026-09-22，`feat/worldbook-frontend-polish`）

- **口径**：封面一律**从本地文件选**（`CoverPicker` → `<input type="file" accept="image/*">`），
  压缩后以 `data:image/...;base64` 写入书的 `cover_image`。收图片地址的老写法已移除。
- **为什么**：封面要跟着书走。外链在导出 JSON 里只留一个 URL，换机器 / 断网 / 图床挂掉封面就没了；
  内嵌让 `cover_image` 成为书自身的一部分 —— 后端本来就把它写进
  `export_st()` 的项目扩展命名空间（`extensions.arknights_tavern.cover_image`），
  导入时按同名字段读回（`WorldBookManager.import_book`），因此「导出 → 导入」原样还原，
  不需要额外资源目录约定。
- **压缩参数**（`frontend/src/components/worldbook/CoverPicker.tsx`，导出为常量便于断言）：
  长边 ≤ `COVER_MAX_EDGE = 512`，优先 WebP、回退 JPEG（白底铺平，JPEG 没有 alpha），
  质量按 `[0.86, 0.74, 0.62, 0.5, 0.4]` 逐档下调直到 ≤ `COVER_MAX_BYTES = 160 KB`。
  `createImageBitmap` 不可用时回落 `<img>` 解码；解码失败给的是人话文案，不是 `NotSupportedError`。
- **证据**：`scripts/test_worldbook_layer_ui.cjs`（文件选择而非地址输入、压缩参数量级、
  摘要文案）；`tests/test_worldbook_entry_refresh.py` 覆盖 `cover_image` 的导出回读。

## 数据布局

### 历史：世界书内容与运行时书文件分层（2026-09-22，`feat/worldbook-data-layout`）

- **现象**：旧布局把随程序分发的角色、剧情、战斗、音频等内容散放在 `data/` 根目录，
  同时把用户书和设置放在 `data/worldbooks/`，路径职责不清且打包、迁移容易漏项。
- **当时的布局记录**：此处关于共享内容目录和预装包的描述记录 2026-09-22 的旧布局，已不代表当前流程。
  当前 `data/worldbooks/books/` 仅保存用户本地书籍；项目不再分发共享 `content/` 或 `packs/`，
  新检出后需由用户导入书籍或复制完整书文件夹。`categories.yaml` 仍位于 `data/` 根目录。
- **证据**：`tests/test_data_layout.py` 覆盖 Document/Wiki 与内容 API、素材 URL、临时候选剧情、
  战斗节点提示刷新、背景引用和生成器临时输出。

### 资源来源以实际书文件夹为准（核对于 2026-09-29）

- `worldbook_content` 按绑定顺序解析 `books/<book_id>/`；`DocumentInfo.worldbook_id` 来自实际文件夹。卡片 frontmatter 可能保留拆分前的来源标记，不能据此定位运行时资源。
- 战斗单位的 `character_id` 是角色目录 ID，`name` 只是显示名；单位的 `worldbook_id` 必须来自本次解析路径。头像、立绘、卡面、裁剪和 Spine 不能用显示名重新全局搜索。
- 证据：`tests/test_document_worldbook_source.py`、`tests/test_tactical_practice.py`，后者覆盖旧来源标记、目录 ID 与显示名不同、跨书同名与挂起恢复。

### 资产页实体行上传的图片无法直接设为默认形象（核对于 2026-09-28）

- 实体行的“+”把图片上传到实体目录根部（`AssetManager.tsx:handleImageUpload`），而资产页仅对 `avatar/`、`skin/` 子目录的图片提供“设为默认头像/立绘”操作（`AssetManager.tsx`）。需用支持子目录的角色资源入口上传，或把图片放入对应目录后再设默认值。

## 剧情节点生成

### 护栏式剧情使用参考大纲补齐节拍骨架（核对于 2026-09-28）

- 没有 `## 章节 N` / `#### beat_` 骨架的剧情，创建会话时用书内 `story_outline_<plot_id>` 系统条目优先、启发式切幕兜底，生成会话自己的节拍骨架。`<current_node>` 提供当前节拍、`must_keep` 和后续候选；玩家选择有 `target_beat_id` 的分支时，叙述前跳到落点。
- 启发式一幕一节拍默认 `min_rounds=3`，LLM 大纲节拍默认 2，防止模型每轮都标记完成导致过快推进。LLM 大纲解析失败时接口可返回 200 并回落启发式；调用方必须查看 `outline.source` 和 `generation.error`，不能只按 HTTP 状态判断成功。
- 战术模式只接受绑定当前剧情或世界书的现成战斗节点；其它节点引用按 `combat_scene` 现场生成。生成测试须把节点目录指向临时路径。
- 偏离分支只写入会话的 `story_outline` 副本，不回写世界书。通用行为验证见 `tests/test_story_outline.py`。

### 节点图演出图片按剧情引用触发（2026-09-27）

- 在世界书「节点图」选剧情入口、有效章节或节拍节点，再点「演出配置」选择本书图片或上传图片。背景按节拍 → 章节 → 剧情入口继承；CG 只挂有效节拍，进入该节拍的叙述时自动展示，可关闭并从舞台工具栏重看。配置随整张图保存，画布坐标与连线不决定触发时机。
- 图条目的 `scene_media` 只接受本站 `/api/assets/` 图片 URL，服务端按会话绑定书和 `plot_id` 读取图；已有会话也会读到之后保存的新配置。会话资源背景覆盖仍优先于图配置，图配置再优先于地点/default 背景。
- 叙述历史保存生成该轮时的 `beat_id` 与一基章节号。舞台按叙述轮次解析演出，避免 `beat_complete` 已推进到下一节拍造成图片提前；旧历史没有节拍元数据时不自动触发 CG。CG 在同一浏览器标签页中每次进入一个节拍自动弹出一次，回看按钮仍可手动重看。

### 节点图从参考大纲生成布局（核对于 2026-09-28）

- `combat_nodes.plot_flows(book_mgr=...)` 对没有正文节拍骨架的剧情，按书内大纲、启发式大纲的顺序回落；两者都无法切章时保持 `chapters=[]`。返回的 `source` 区分正文骨架与参考大纲，战斗引用合并大纲声明及节点文件中的 `bind`。
- 双击引用节点打开实际节点详情，展示大纲正文、必留内容、叙事指引、推进约束及分支落点；点击「打开剧情原文」才进入文档编辑器。大纲节拍不伪装成原文 `#### beat_id` 段。LLM 分析接口即使返回 200 也可能回落启发式，界面须查看 `outline.source` / `generation.error`。
- 唯一节拍 ID 移动章节后仍能解析详情，并可「更新移动引用」后保存；真正删除或歧义引用需在详情明确重新关联，不按名称猜测。关联修改保留坐标、连线和演出配置，进入同一撤销栈。章节引用仍以序号为锚，大纲重排章节时应核对并重新关联；不能从旧序号推断原章节身份。不同世界书的同名剧情草稿分别缓存，避免串书。
- 新生成布局按大纲 `branches[].target_beat_id` 连接作者分支；连线和节点详情展示声明的选项与意图。手工布局连线只是编辑器结构，不执行物品或数值条件。背景/CG 仍按保存的剧情、章节、节拍引用进入舞台，修复移动引用前不会自动改写运行时资源。
- 验证：`tests/test_graph_node_details.py`、`tests/test_plot_graphs.py`、`tests/test_scene_media.py`、`tests/test_character_stats_api.py`（历史轮次的舞台图片）及 `node scripts/test_graph_references.cjs`。`python scripts/test_graph_details_browser.py` 使用独立 Vite `:5188`（`GRAPH_DETAILS_URL` 可覆盖），全拦截 API，覆盖详情、失效引用、撤销/保存、同名剧情跨书缓存和 1440×960 / 390×844；不是对用户本地书或在线服务的写入验收。

### 剧情数值与物品效果（task.md 6–7，2026-09-28）

- 大纲 `branches[].conditions/effects` 由 `story_rules.py` 校验与结算：条件为 AND，可检查场景物品在场/不在场、已声明角色字段的 eq/ne/gt/gte/lt/lte；效果可获得/消耗物品、set/add 字段。字段外键、非法类型和非有限数拒绝，数值增减按书内范围截断。`actor: player` 指主控，其他角色必须在阵容中。物品是唯一 ID 的共同场景资源，不是堆叠背包；支持绑定书的物品文档和启用的 `category_id=items` 条目 UID。
- 仅当前节拍的作者分支有规则权限；模型不能伪装作者、提供效果或直接跳到受限落点。同名模型复述保留作者规则，传了错误 ID 不回退标签，自由输入同名选项也重验。界面显示条件/效果/不可选原因；历史节点上的资格是记录时状态，不是当前可选承诺。
- 会话角色详情挂载 `CharacterSessionStats`，可见书内默认值和剧情变化；未定义时显示空状态，不造数值。显式保存仅修改会话值；按会话/角色 keyed 挂载，避免草稿串号。原独立 `CharacterStatsPanel` 未重新注册，不把不存在的侧栏页签作为入口。
- 服务端在叙述前以一次 `overrides.json` 原子替换提交效果、落点和执行凭据，失败恢复内存；LLM 生成是下一阶段，不和磁盘事务混为一体。生成失败保留待叙述选择，重试同 ID 不重复扣物品/加数值。已完成旧 ID 返回 409。叙述（含整个 SSE）与 HTTP 数值/物品修改、节点回档互斥。
- 场景物品列表、物品覆盖、数值及执行凭据随树节点和节点历史回档，同步内存场景物品。只剪叙述历史的「轮次回退」不能精确恢复资源：已结算效果时返回 409，明确要求使用节点图回档，避免看似回退但资源未还原。
- 回档在剪历史之前检查目标仍存在、资源快照完整；缺少字段的旧节点明确拒绝，不猜测原库存，也不自动迁移。LLM 失败后直接点「继续」同样接续已结算选择，保留选择前的父节点快照。重载空 NPC 阵容不会跳过物品，也不再回填开场角色。
- `scripts/prepare_beyond_twin_story_rules.py <明确的book.json路径>` 默认 dry-run；`--output <新文件>` 生成候选，`--apply` 才备份、重查 SHA-256 并原子替换。保持原分支与媒体，新增病中日志布尔字段、玩偶获得/安抚、终端调查与回忆路线；基础路线无物品门槛。应用前须保存世界书编辑并停止写入。已有会话保留自己的大纲副本，不自动迁移存档；代码部署需要批准后重启在线服务。
- 本轮未覆盖用户本地书或重启服务。证据：`tests/test_story_rules.py`、`tests/test_story_rules_http.py`（真实 Flask、脚本化模型、SSE/POST/回档）、`tests/test_session_stats.py`、`tests/test_character_stats_api.py`、`tests/test_beyond_twin_story_rules_content.py`；前端与内容候选验证不等于真实 LLM 验收。

## 历史内容记录：灰灯渡口（2026-09-26）

- 旧共享内容与分发包已从项目移除；本机当前书架不含灰灯渡口。若需恢复，应从项目外副本整理为 `data/worldbooks/books/<book_id>/` 下的完整书文件夹。
- 确定性选路需结构化大纲 `branches[].target_beat_id`。本书一章一节拍，分叉 `choice_required=true`；模型完成标记和超时均不能替玩家选择，也不能通过模型生成的其它落点跳过分叉。回档需保留树分支的 `target_beat_id`。
- 固定战斗节拍使用 `min_rounds=1`，声明了节点就不再现场生成第二个节点。合流用三轮，结局只用一个尾声节拍，避免互斥结局顺序串播。
- 模拟器曾忽略内联敌人造成空场假胜；2026-09-29 生产 `CombatSession` 也已统一读取节点 `enemies_def`，优先级为内联定义 → 会话自定义 → 书内敌人文件。战前绕行缺结构化结算，结局事实仍受模型一致性限制。
- 不要把接口脚本化验收、180 场策略模拟、13 轮真实模型绕行线当成同一种验证。
- 旧开发记录已删除；关键节拍完成判据、模型编造主控台词、完整人工战斗及取证路线真实模型验收仍无最终证明，需有内容书后重新验证。

## 网格战斗演练（核对于 2026-09-29）

- **现象与根因**：演练只读取已安装世界书节点，空书架无法开始；角色候选误用叙事 `combat.json` 目录。会话开战只取 NPC，漏主控；单位显示名被当作资源键，且媒体查询丢失书籍范围。
- **现状**：`/api/combat/practice` 默认提供 `data/tactical_practice/` 的显式基础演练（训练员、职业牌组、自包含节点）；不安装世界书，也不向剧情会话注入示例。选择世界书后，节点和角色限定在该书，切书清空旧选择；参战角色不再依赖叙事卡文件。不存在的角色不再静默跳过，同显示名阵容明确拒绝，避免卡牌归属歧义。
- **角色身份**：会话使用 `get_roster()`（有资料的主控 + 队友），文档按绑定书加载；`character_id`、实际来源书与媒体 URL 随单位和恢复快照保存，结算按角色 ID 写回。Spine 的目录、骨架、图集和贴图均携带来源书，缓存键包含来源，不复用其他书的同名形象。
- **验证入口**：`tests/test_tactical_practice.py`、`tests/test_combat_resume.py`；`node --test src/utils/gridCombatResources.test.mjs src/utils/spineVariants.test.mjs`（frontend 下）；`scripts/test_tactical_practice_browser.py`（先用 `npm exec vite -- --config vite.config.shot.ts --host 127.0.0.1 --port 5192 --strictPort` 启动独立前端）。浏览器用临时书籍和真实 Flask 战斗路由，不写用户存档；覆盖 1440/390px 入口、开战与结束回合、切书、空书、失败重试。没有覆盖用户正在运行的旧进程或全部真实 Spine 动画。
- **关卡门禁**：`tools/validate_battle_spec.py` 校验通过；`tools/simulate_battle.py --book-folder data/tactical_practice --node enc_builtin_training --runs 30 --min-win-rate 0.9 --max-median-rounds 5 --max-hp-loss 0.2` 为 100% 胜率、中位 4 回合、首回合清场 0%、血损约 1%，实际威胁 2.0 与预算一致。

## 横版战斗

### 横版关卡与表现层（核对于 2026-09-28）

- 厚度不超过 32 px 的薄平台默认单向（`oneWay` 可覆盖）；巡逻区间只约束闲逛，追击受平台边缘与墙限制。改地形或敌人行为后运行 `simulation.test.mjs` 的通关策略用例。
- Pixi 7 的 `Graphics.arc()` 会从上一段路径末点连线，每段弧线先 `moveTo` 起点。未启用 `preserveDrawingBuffer` 时，不能用 `drawImage` 读回 WebGL 画布判断是否渲染；用截图像素检查。
- Spine 模型在被 Git 忽略的角色资源目录，隔离 worktree 里缺模型时只看到回退表现；真实模型验收需指向具备资源的环境。

## 卡牌战斗事件播放（2026-09-27）

- 四个 action/end-turn 接口统一返回 `{state, events}`。事件的 `data.presentation_id` 在进入 SSE 队列时生成，HTTP 批次共享该 ID。
- 前端先标记整批 ID，再播放事件和投影血量，最后采用权威快照。不要在收到 HTTP 响应时直接替换最终状态，否则死亡角色先消失。旧接口 SSE 分批消费要跨批保存攻击分组。
- 选中角色的可移动范围由服务器计算；切换角色必须请求该角色并核对响应仍属于当前选择。动作开始递增版本，防止更早发出的 GET 覆盖播放投影。
- 护盾 status.value 是新增量；burn.value 是每回合伤害，duration 才是持续时间。净化清理负面状态，最终快照仍是权威来源。
- 定向检查 `node scripts/test_combat_presentation.cjs` 与 `tests/test_combat_presentation.py`。完整验收和未解决的窄屏/专属演出差距见 [第一轮验收](card-combat-presentation-qa.md)。

## 历史：Ark Tavern 通用化与可选内容包（2026-09-27）

以下记录描述 2026-09-27 当时的实现与验证；共享分发源、内容归属清单及内容包已移除，不是当前操作流程。

- 启动时不安装或刷新任何离线世界书包。会话未显式绑定剧情世界书时不注入书内容；新会话主控称谓为「玩家」，环境为空。已有本地安装副本保留给用户管理，不自动删除。
- 历史实现曾以 `content_manifest.json` 标记共享分发资源归属，并支持显式安装内容包；当前没有这套内容分发与安装流程。
- 历史记录中的 Spine 变体映射文件曾随共享内容分发；当前资源按用户的完整世界书文件夹管理。
### 可复制的完整世界书（2026-09-28）

- 已安装书以 `data/worldbooks/books/<id>/book.json` 为元数据，`characters/`、`plots/`、`combat/`、`audio/` 等资源目录直接放在同一本书的文件夹内。复制文件夹即完整分享；放入 `books/` 后刷新书架发现。会话按绑定书顺序解析同名资源，无绑定时不读取书内资源。
- 应用内导入酒馆 JSON/JSONL 或含世界书的角色卡会新建 `books/<id>/book.json`；原文件只有条目时，不会凭空获得独立图片、音乐、剧情和战斗资源。酒馆 JSON 导出仍用于外部互通。
- 旧版散装书 JSON、`inbox/` 和 `.arkwb` 不再参与导入；旧迁移脚本已下线。整理旧文件时先备份并核对完整书文件夹，不覆盖同 ID 的现有书。
- 会话 ZIP 与世界书文件夹是不同的导出物。导入会话 ZIP 时，随档案保存的角色与背景快照会变成一册独立的会话资源世界书，并排在该会话绑定列表首位；不会写回旧共享目录或覆盖现有书籍。
- 历史记录：2026-09-28 本机旧 `arknights.json` 缺 `schema_version=3`；当时临时目录内验证了「备份并修复」后迁移，254 条条目保持一致且留下 `.bak`。当前请以书文件夹为安装单位。

### 顶栏标签脚与滚动边界（2026-10-06）

- `GameTopBar` 的反向圆角以外侧上角为圆心，标签、标签脚和底部衔接带沿用同一 `bg-gray-800` 皮肤映射。圆心放在下角会使弧线方向反转，底部无法平滑舒展。
- 导航两端预留 12px 标签脚空间，使用可伸缩的横向布局和 `overflow: visible`。不要在标签列表上恢复 `overflow-x-auto`：最右侧「设置」的伪元素会被计入滚动范围，并挤出横向滚动条。
- 桌面浏览器验收覆盖 1280px 与 Electron 最小宽度 1000px、全部六个导航入口、默认深浅色及两种皮肤；标签均完整显示，无横向或纵向溢出，键盘焦点可见。

### 固定窗口尺寸与显示模式（2026-10-06）

- 设置提供五组内容区逻辑像素预设，清单见 `frontend/src/shared/windowSettings.ts` 与前端设计规范。窗口模式使用 `setContentSize`，窗口全屏对应原生最大化，全屏对应 `setFullScreen`；选择预设会恢复普通窗口，自由拖动不会吸附到预设。
- Windows 显示缩放下，先 `setContentSize` 再 `setPosition` 会重新舍入客户区（本机 1280×720 曾变成 1282×721）。先在目标工作区定位、最后设置内容区尺寸；首次显示前也归一默认尺寸。恢复最大化/全屏后重新取得目标屏幕工作区；超出空间的预设按原比例适配，并保留所选预设。不得因缩放后的逻辑工作区较小而禁用 1080p/2K 选项。
- `node scripts/test_window_controls.cjs` 覆盖预设、模式、串行切换、IPC 来源/参数、屏幕适配、尺寸事件和清理。`node scripts/test_window_controls_electron.cjs` 使用临时用户目录、真实 preload/IPC 与原生窗口，不启动或修改后端；验证五个预设均可应用、较大尺寸适配后保留选择、内容区与 CSS 视口一致、三种模式和自定义尺寸。
- 设置选择尺寸后立即切换，无额外应用按钮。五组固定视口仍用于开发和布局验收；原生适配后的实际运行尺寸不会改变开发矩阵。未声称其他页面已经补做完整五尺寸验收，也未实测多屏切换。
