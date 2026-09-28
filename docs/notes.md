# 项目工程笔记（notes）

只记**本项目内、可复现、下次会再撞上**的细节：踩过的坑、口径约定、环境差异、已知未修项。
通用的工程经验、跨项目的方法论**不**放这里；需要长期影响 AI 行为的规则走 `AGENTS.md`
或 `.agents/skills/`，设计目标态走对应的 `docs/*.md` 设计文档。

新增条目请写明：现象 → 根因 → 现状口径 → 证据（文件/用例），并在条目首行标注核对日期与相关提交（如有）。

---

## 会话

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
    `initial_characters`；显式空数组表示没有开场角色。服务端开场加载、`session_manager` 的重载
    回退与 `/api/plots` 共用这一份口径，不再各读各的。
- **向导边界**：「主控与阵容」这一步只选角色；候选范围按当前 v3 规则解析。创建接口按书提交
  `manual_entry_uids_by_book` / `expected_draft_hashes`，不再接受首本书的单数参数。
- **命名创建只报 token**：该步不再渲染整块 `WorldBookScopePreview`，只列每本书的「估算 token」——
  「候选规模减少 0 token（0%）」这种无信息量的行不再出现；候选条目明细在世界书工作台看。
- **已知边界**：会话大厅的「添加角色 / 换主控」候选仍是**按角色卡来源书**过滤
  （`SessionManagerView.tsx` 的 `candidateItems`），绑定拆分剧情书的会话里同样列不出该剧情的角色；
  本次只改新建向导。要一并统一时，两处都调 `characterCatalog.selectableCatalogItems`。
- **证据**：`src/world_book.py`（`character_ids` / `_summary`）、`src/blueprints/sessions.py`
  （`/api/plots`）、`src/session_overlay.py`（`plot_initial_characters`）、
  `src/session_manager.py::_plot_initial_characters`、
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

### 剧情验收中仍未修的缺口（核对于 2026-09-28）

- `tests/test_greybridge_acceptance.py` 的严格 `xfail` 仍覆盖 QA-01 开场上下文泄露后续章节、QA-02 叙述不会自动提交任务状态、QA-03 最后一节拍缺终态、QA-05 显式空阵容重载后被开场角色填回、QA-06 未知任务 ID 可被状态接口接受、QA-08 变体保存的前后端参数不一致。`xfail` 是已复现的缺口，不能当作通过。
- QA-04 分支目的地回档、QA-07 平铺物品读取已有普通通过用例；旧报告中的“未修”表述仅代表当时基线。详情与原始复现见 [2026-09-20 剧情验收报告](qa/2026-09-20-story-audit.md)。

## 对话页

### 角色数值的字段解析：会话绑定书优先，不是角色自己的书（2026-09-23，`feat/session-stage-panels`）

- **口径**：会话里某角色用哪套统一字段，先看**会话绑定顺序中的首本世界书**（由 `worldbook_ids` 派生 → `stat_fields`），
  同一会话内所有角色因此口径一致；会话没绑书或该书没定义字段，才退回角色自己的来源书（frontmatter
  `worldbook_id`）。角色页「数值」页签（全局值）只看角色自己的来源书。两处不一致时以会话为准——
  `tests/test_character_stats_api.py::test_session_stats_merge_and_bound_book_fields` 钉住。
- **值的三层**：字段默认 → frontmatter `stats` → `overrides.json.character_stats`。全是默认值的角色不进提示词，
  `<character_stats>` 块只列有非默认值的键；主控角色不在 `_agents` 里，由 `SceneManager._stats_snapshot` 按身份名
  单独读 frontmatter。
- **快照兼容**：`character_stats` / `plugin_data` 随剧情树节点快照与 `node_history.json` 回档；**老快照没有这两个键
  时保持现值、不清空**（与 `character_states` 同口径，见 `rollback_to_tree_node`）。

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
python -m pytest tests/ perf_tests/test_combat_runtime_v1.py perf_tests/test_combat_data_v1.py `
  perf_tests/test_settlement_v1.py perf_tests/test_card_json_roundtrip.py perf_tests/test_cv_budget.py
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

### 世界书内容与运行时书文件分层（2026-09-22，`feat/worldbook-data-layout`）

- **现象**：旧布局把随程序分发的角色、剧情、战斗、音频等内容散放在 `data/` 根目录，
  同时把用户书和设置放在 `data/worldbooks/`，路径职责不清且打包、迁移容易漏项。
- **现状口径**：分发内容目录位于 `data/worldbooks/content/`；预装包位于
  `data/worldbooks/packs/`；`categories.yaml` 留在 `data/` 根目录；用户书 JSON、
  `settings.json`、备份和会话数据保持原位。环境内容只有 `Location/` 与 `weather/`，
  时段预设仍是代码内置列表，不存在 `environment/time/` 目录。
- **证据**：`tests/test_data_layout.py` 覆盖 Document/Wiki 与内容 API、素材 URL、临时候选剧情、
  战斗节点提示刷新、背景引用和生成器临时输出。

### 「来源世界书」只有一个字段：实体 index.md 的 `worldbook_id`（2026-09-22）

- **口径**：角色 / 职业 / 其它实体目录的**唯一**来源标注是 `index.md` frontmatter 的
  `worldbook_id`。写入端只有两处：导入角色卡时 `character_card._stamp_worldbook_id`（把随卡
  自带的内嵌世界书记到角色目录上），以及资产/卡牌界面里的「标注来源世界书」
  （`PUT /api/assets/<category>/<entity>/worldbook`）。没有单独的 `source` / `worldBookName` 字段——
  展示名一律由前端拿 `listWorldbooks()` 现查，查不到（书被删/停用/还没加载）回落显示 id 本身。
- **未分类的判定**：`worldbook_id` 缺失、`null`、空白串都算「未分类」。后端原样透传（`null` → 空串），
  归一化只在前端 `utils/worldbookGrouping.ts` 的 `worldbookKeyOf` 做一次；该函数产出的
  `UNCLASSIFIED_KEY = "__none__"` 是资产/卡牌来源下拉与分组选择共用的哨兵值，三个界面都引用这个
  常量（不要再用 `"__none__"` 字面量），改哨兵只需改这一处。
- **两种数据都要能读**：`list_documents` 的实体文件夹分支现在**无条件**解析 frontmatter（此前只在
  `include_content=True` 时解析），因此 `DocumentInfo.worldbook_id` 与 `include_content` 无关；
  传统 `.md` 文档与实体子文档两个分支仍受 `include_content` 门控，其 `worldbook_id` 恒为空串。
  这是纯追加字段，`_docs_to_tree` 与 `blueprints/documents.py` 的全文检索**按固定键重建**结果，
  会静默丢掉它——那两条链路目前没有前端消费者，将来接线时要一并补上。
- **证据**：`tests/test_document_worldbook_source.py` 覆盖有标注 / 缺字段 / `null` / 空白四种取值，
  以及「不请求内容摘要时也能拿到来源」「原有键值不变」，外加 `/api/characters` 端点层的字段断言。

### 资产页实体行上传的图片无法直接设为默认形象（核对于 2026-09-28）

- 实体行的“+”把图片上传到实体目录根部（`AssetManager.tsx:handleImageUpload`），而资产页仅对 `avatar/`、`skin/` 子目录的图片提供“设为默认头像/立绘”操作（`AssetManager.tsx`）。需用支持子目录的角色资源入口上传，或把图片放入对应目录后再设默认值。

## 剧情节点生成

### 护栏式剧情使用参考大纲补齐节拍骨架（核对于 2026-09-28）

- 没有 `## 章节 N` / `#### beat_` 骨架的剧情，创建会话时用书内 `story_outline_<plot_id>` 系统条目优先、启发式切幕兜底，生成会话自己的节拍骨架。`<current_node>` 提供当前节拍、`must_keep` 和后续候选；玩家选择有 `target_beat_id` 的分支时，叙述前跳到落点。
- 启发式一幕一节拍默认 `min_rounds=3`，LLM 大纲节拍默认 2，防止模型每轮都标记完成导致过快推进。LLM 大纲解析失败时接口可返回 200 并回落启发式；调用方必须查看 `outline.source` 和 `generation.error`，不能只按 HTTP 状态判断成功。
- 战术模式只接受绑定当前剧情或世界书的现成战斗节点；其它节点引用按 `combat_scene` 现场生成。生成测试须把节点目录指向临时路径。
- 偏离分支只写入会话的 `story_outline` 副本，不回写世界书。验证见 `tests/test_story_outline.py`、`tests/test_story_generation_beyond_twin.py`；真实模型检查脚本为 `scripts/verify_beyond_twin_generation.py`。

### 节点图演出图片按剧情引用触发（2026-09-27）

- 在世界书「节点图」选剧情入口、有效章节或节拍节点，再点「演出配置」选择本书图片或上传图片。背景按节拍 → 章节 → 剧情入口继承；CG 只挂有效节拍，进入该节拍的叙述时自动展示，可关闭并从舞台工具栏重看。配置随整张图保存，画布坐标与连线不决定触发时机。
- 图条目的 `scene_media` 只接受本站 `/api/assets/` 图片 URL，服务端按会话绑定书和 `plot_id` 读取图；已有会话也会读到之后保存的新配置。会话资源背景覆盖仍优先于图配置，图配置再优先于地点/default 背景。
- 叙述历史保存生成该轮时的 `beat_id` 与一基章节号。舞台按叙述轮次解析演出，避免 `beat_complete` 已推进到下一节拍造成图片提前；旧历史没有节拍元数据时不自动触发 CG。CG 在同一浏览器标签页中每次进入一个节拍自动弹出一次，回看按钮仍可手动重看。

### 节点图从参考大纲生成布局（核对于 2026-09-28）

- `combat_nodes.plot_flows(book_mgr=...)` 对没有正文节拍骨架的剧情，按书内大纲、启发式大纲的顺序回落；两者都无法切章时保持 `chapters=[]`。返回的 `source` 区分正文骨架与参考大纲，战斗引用合并大纲声明及节点文件中的 `bind`。
- 大纲生成的节拍不在剧情正文里，双击节点只打开剧情文档，不能让 `StoryBeatEditor` 按 `#### beat_id` 定位。LLM 分析接口即使返回 200 也可能回落启发式，界面须查看 `outline.source` / `generation.error`。
- 大纲重新生成后章节 ID 或顺序可能变化，已保存的画布节点可能成为“缺失”；需重建布局。验证见 `tests/test_node_graph_worldbook.py`。

## 卡牌剧情内容：灰灯渡口（2026-09-26）

- 内容源在 `data/worldbooks/content/plots/grey_lantern/index.md`、`world/灰灯渡口.md` 和三个 `enc_grey_*` 节点，专属敌人是 `enemies/灰灯*.md`；定向重建用 `python scripts/generate_grey_lantern.py`。分发包需与这些源文件同步。
- 确定性选路需结构化大纲 `branches[].target_beat_id`。本书一章一节拍，分叉 `choice_required=true`；模型完成标记和超时均不能替玩家选择，也不能通过模型生成的其它落点跳过分叉。回档需保留树分支的 `target_beat_id`。
- 固定战斗节拍使用 `min_rounds=1`，声明了节点就不再现场生成第二个节点。合流用三轮，结局只用一个尾声节拍，避免互斥结局顺序串播。
- 模拟器曾忽略内联敌人造成空场假胜，本次补齐；生产会话仍依赖注册敌人文件，本书已提供。战前绕行缺结构化结算，结局事实仍受模型一致性限制。
- 设计、问题复现、已修项、未修体验及验证边界见 [灰灯渡口开发记录](grey-lantern-development.md)；不要把接口脚本化验收、180 场策略模拟、13 轮真实模型绕行线当成同一种验证。

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

## Ark Tavern 通用化与可选内容包（2026-09-27）

- 启动时不安装或刷新任何离线世界书包。会话未显式绑定剧情世界书时不注入书内容；新会话主控称谓为「玩家」，环境为空。已有本地安装副本保留给用户管理，不自动删除。
- 分发源仍存于 `data/worldbooks/packs/` 和 `data/worldbooks/content/`。`content_manifest.json` 标记仓库资源的归属；仅当至少一本归属书已安装且启用时，其角色、剧情、战斗节点和素材才可见。停用或删除已安装书使其独占内容退出运行时目录及直达 URL，分发源仍可供再次安装。改动离线资源后运行 `python scripts/generate_content_manifest.py` 并检查 `tests/test_distributed_content_manifest.py`。
- 战斗 Spine 变体映射作为 `content/spine_variants.json` 分发，经 `/api/assets/spine-variants` 只返回当前可见角色；无模型的角色使用通用几何标记。导入的世界书角色私有副本在卸载时清理，被其他书引用则拒绝卸载。
### 可复制的完整世界书（2026-09-28）

- 已安装书以 `data/worldbooks/books/<id>/book.json` 为元数据，`characters/`、`plots/`、`combat/`、`audio/` 等资源目录直接放在同一本书的文件夹内。复制文件夹即完整分享；放入 `books/` 或 `inbox/` 后刷新书架发现。会话按绑定书顺序解析同名资源，无绑定时不读取书内资源。
- `scripts/migrate_worldbook_layout.py` 默认预览，`--apply` 把旧 JSON 和归属共享资源**复制**到新文件夹，原文件保留，便于核对；不兼容旧 schema 仍需先备份并修复。迁移后，旧共享目录只为尚未迁移的书提供兼容读取，不能让旧副本绕过停用状态。
- `.arkwb` 保留为可选兼容格式；导入后展开为普通书文件夹。酒馆 JSON/JSONL 只携带条目时仍可导入，但不会凭空获得图片、音乐、剧情和战斗文件。`inbox/` 的导入记录留在 `.imported.json`，同 ID 安装不覆盖。
- 2026-09-28 本机旧 `arknights.json` 缺 `schema_version=3`，迁移预览会跳过；其与当前分发包的共同内容字段完全相同。临时目录内验证了「备份并修复」后迁移，254 条条目保持一致且留下 `.bak`。操作真实数据前仍需停止应用并确认保存。
