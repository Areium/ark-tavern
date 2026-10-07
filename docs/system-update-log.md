# 系统更新设计与维护文档

> 本文件是**变更历史**：按时间倒序记录架构演进与关键修改。
> 旧条目提到的方舟包自动安装、全局默认书与预装回退已于 2026-09-27 移除；现状以 `architecture.md` 为准。
> 现状与目标态不在本文件维护——架构见 `architecture.md`、战斗机制见 `docs/design/combat/combat-design.md`、
> 数值见 `docs/design/combat/combat-numerical-design.md`、节点字段见 `docs/design/combat/battle-spec.md`、工程细节见 `notes.md`。

---

## 目录

[更新记录](#更新记录)

## 更新记录
### 2026-10-07 — 世界书演出配置：节点背景与事件 CG 持久化、图谱交互改造

> 在世界书节点图上直接为每个节点配置会话背景与事件 CG（CG 同时作为背景），
> 配置随书持久化并已在「彼岸双生」原书落地验收；节点图本身也做了一轮交互改造。

- **演出配置持久化**（设计 `docs/design/worldbook/node-presentation.md`，提交 `c916817`）：节点可声明
  背景与事件 CG，持续时间口径为「持续到下一个背景触发」，数据结构预留插入 BGM 与视频的扩展位；
  新增 `SceneMediaEditor.tsx`（节点演出编辑）、`utils/sceneMedia.ts`、`styles/graph-scene-media.css`，
  舞台视图 `StageView.tsx` 按节点配置切换背景 / CG。
- **应用到「彼岸双生」**：`scripts/prepare_beyond_twin_presentation.py` 共配置 28 个节点、9 个 CG 事件，
  15 张使用中的图片全部通过校验；原书文件完整备份，仅替换节点图条目，其他条目与已有会话不动
  （旧会话不迁移，新建彼岸双生会话才使用新演出配置）。
- **节点图交互改造**（`07204e4`、`7ac6689`）：新增「扩大查看」——收起世界书简介让节点图占整页；
  演出配置改为双击节点在详情面板（`GraphNodeDetails.tsx`）进行，取消独立配置按钮；配好的 CG 以
  缩略图挂在对应节点上方、短直线连接（`graphCG.ts`）；移除选中两节点连线时的描述方框，保留连线
  高亮、重连与删除。
- **验证**：`scripts/test_graph_details_browser.py`、`scripts/test_graph_references.cjs`、
  `scripts/test_stage_ui.cjs` 更新通过；重启后端后背景与 CG 图片接口均 200；构建与五组桌面尺寸
  浏览器检查通过。

### 2026-10-07 — 舞台流式接收：分页读文与锚定交接

> 流式生成期间先给可读的纯文本分页，整轮完成后再二阶段渲染头像，并把阅读位置锚定回用户
> 正在读的那一页；输入与恢复都绑定到各自发起的请求。

- **流式读文与锚定交接**（`423c675`、`f5ae3ca`、`37a1d6d`）：流式期间先展示纯文本（固定字数分页，
  内容增加时页数自然增加）；整轮完成后二阶段渲染头像，并定位回用户正在阅读页的起始处；后端区分
  「正文已完成」与「整轮生成完成」两阶段状态。舞台输入与中断恢复改为绑定其发起的请求，避免切换
  会话或重发时把上一轮输入接到新的流上；挂载态的舞台预览交接补测试覆盖。
- **验证**：真实 HTTP 流式连接浏览器验收通过——阅读位置保持、新增内容不抢页、断线 / 取消后正文
  仍可读；前端构建与相关舞台用例通过。

### 2026-10-07 — 前端设计指南重写为「避坑清单」

- **重写 `docs/design/frontend-design-guidelines.md`**：由整体风格指南收敛为硬性禁令清单——标题下
  不加副标题与描述性文字（最高优先级）、禁 Emoji 与符号冒充图标（功能图标统一 SVG）、桌面端验收
  不必考虑窄屏；原「五组固定窗口尺寸验收基准」并入附录，其余通用设计规范不再重复。`AGENTS.md` 与
  `docs/architecture.md` 的指引与文档地图同步改名与口径。

### 2026-10-07 — 许可改为 AGPL-3.0-or-later，应用内补许可入口

> 项目由 MIT 改为 AGPL-3.0-or-later，并界定授权范围：仓库内本项目原创的代码与内容（含示例包与
> 示例世界书）都在许可内，第三方素材与他人二创的插件包 / 世界书不在；应用内提供许可与源码入口。

- **换证**：`LICENSE` 替换为 GNU AGPL-3.0 官方全文（含第 13 条网络条款），`README.md` 许可节与
  `frontend/package.json` 的 `license` 字段同步为 `AGPL-3.0-or-later`；顶层依赖全部相容
  （pixi.js / React / react-dom / zustand / react-markdown 为 MIT，lucide-react 为 ISC）。
- **授权范围**：README 新增「授权范围」小节——覆盖本仓库内本项目原创的代码与内容（后端 / 前端源码、
  插件接口与内置面板、`examples/` 示例战斗模式包与示例世界书适配器、`data/` 示例内容、脚本与文档）；
  第三方素材以及他人制作或二创的插件包、世界书、角色内容不在覆盖范围，各自适用其作者的许可。
- **应用内许可入口（AGPL §5(d)）**：`components/SettingsPanel.tsx` 的「关于」新增许可标识、许可全文
  与源码链接、无担保说明和范围提示；主页页脚加同源许可标识（`components/HomeMenu.tsx`）；元信息集中在
  `shared/projectInfo.ts`，版本号不再两处各写一份。
- **外链处理**：`electron/main.ts` 新增 `setWindowOpenHandler` + `open-external` IPC——http(s) 交给
  系统浏览器，其他协议拒绝；此前 `<a target="_blank">`（教程、许可全文）会开出新的 Electron 窗口。
- **验证**：`scripts/test_external_links_electron.cjs`（真实 Electron 42，10 项断言）与
  `scripts/test_license_ui_browser.py`（设置页「关于」与主页页脚，五组桌面尺寸）通过；
  `npm run build`（tsc + vite）通过。

### 2026-10-07 — 进行中（未合并 main）：战斗系统统一插件化

- **战斗系统统一插件化**：方案已写入本地 `task.md`（安装入口：应用内 ZIP 安装 / `data/plugins/inbox`
  扫描导入 / 官方插件首次启动默认安装；宿主与插件职责划分；前端扩展协议；结构化结果提交契约）。
  实现工作在隔离仓库 `D:\Code\arknights-tavern-unified-plugins`（分支 `feat/unified-combat-plugins`）
  进行：插件宿主（`packages.py` / `store.py` / SDK harness / `blueprints/plugins.py` / 生命周期管理）、
  草稿隔离与叙事提交协调器、第四个示例模式包；联合回归后端 693 项通过、叙事协调器 31 项通过，
  已用真实后端 + 真实浏览器跑通「开始—保存—重载—结束—确认—回剧情」闭环，工作分支上另有窗口预设
  与冻结场景演出的整合提交。外部 LLM、完整 App 导航与 Electron 原生验收待做，完成合并后再转为
  正式条目。

### 2026-10-06 — 窗口尺寸预设与显示模式

> 设置页可以一键把窗口切到五组固定内容区尺寸或窗口全屏 / 全屏；这组尺寸同时成为前端开发与
> 验收的基准（自由拖动的尺寸不作基准）。

- **固定尺寸预设与显示模式**（`ce8004c`）：新增 `frontend/electron/windowControls.ts`、
  `shared/windowSettings.ts`、`WindowSettings.tsx`——五组预设（1280×720 / 1400×900 / 1600×900 /
  1920×1080 / 2560×1440）+ 窗口全屏 + 全屏，点击即切换、无「应用」按钮；AGENTS.md 与前端设计指南
  同步确立「按五组固定尺寸验收」口径。
- **超出屏幕自动适配并如实显示**（`a6df678`、`32d2bfe`）：2K 物理屏 + 125% 系统缩放下逻辑工作区仅
  2048×1104，选 1080p / 2K 预设会被等比压缩，但下拉框此前仍显示所选预设、选中值与实际尺寸静默
  分叉。`WindowState` 新增 `fitted` 标记：适配时显示系统实际内容区尺寸并注明「超出屏幕可用空间，
  已按比例适配」，`presetId` 只在完全一致时成立；窗口全屏 / 全屏并入同一下拉（撤掉独立按钮行），
  实时反映原生最大化 / 全屏广播。
- **验证**：`scripts/test_window_controls.cjs` 与 `test_window_controls_electron.cjs`（真实 Electron
  窗口）补 `fitted` 断言通过；`npm run build`（tsc + vite）通过。

### 2026-10-06 — 管理页顶栏改 Chrome 标签式导航

- **标签页式导航**（`526946b`）：`GameTopBar` 激活页签改圆角顶边标签，底色上浮一层（gray-800）、
  下沿覆盖顶栏分隔线与下方内容视觉连通；非激活页签无边框退后，hover 仅轻底色；补 `aria-current`。
  角色页模块页签条底色与激活标签同色，作为连通下来的工具条。
- **标签脚圆角融合**（`a3ff616`）：激活标签底边两角加 Chrome 式标签脚——`style.css` 的
  `.topbar-tab-active` 伪元素 `background-color: inherit` 继承标签底色（三皮肤自动适配，无需改皮肤
  脚本），径向 mask 裁出四分之一圆，顶栏分隔线沿弧线收进标签脚；「主菜单」返回按钮与页签文字同一
  水平线对齐（`self-end` + `-mb-px`）。
- **溢出修复**（`78cb901`）：设置页标签不再横向扩展出滚动条。
- **验证**：默认 / 酒馆 / PRTS 三皮肤无头截图通过，`tsc --noEmit` 与 `vite build` 通过。

### 2026-10-06 — 前端设计规范文档落地

- **新增 `docs/design/frontend-design-guidelines.md`**（`ff674f3`，后聚焦视觉风格 `0d6bbfc`）：
  主标题下不生成描述性副文案、界面禁用 Emoji（功能图标统一 SVG）、按钮不用渐变色、浅色界面避免
  过深色块；`AGENTS.md` 指明前端实现前必读。此前 09-29 / 09-30 曾用生成概念图探索主页与会话大厅的
  布局方向（暖白墨绿、深色暖金两版主页 + 深色酒馆大厅，未改代码），本规范是这轮探索沉淀的约束。
- **顺手修正**（`362bf5c`）：浅色主题下单个 / 批量删除会话按钮由浓红改为淡红底红字。
- 另：本文件尾部「当前状态与后续计划」节于当日移除（未提交的工作区修改，本次更新予以保留）；
  设计指南 10-07 又被重写为「避坑清单」版，见上方 2026-10-07 条目。

### 2026-10-06 — 战斗模式包：可携带战斗模式落地并通过 PC 验收

> 战斗模式从内置代码变成可安装、可运行的「模式包」：包管理基础 → 冻结演练存档运行 →
> 会话生命周期集成 → 作者工作流，附示例包 stance-duel；`feat/combat-mode-plugins` 合并 main 并推送远程。

- **包管理基础**（`28287ce`）：`src/combat_mode_packages.py` + `blueprints/combat_modes.py` +
  `tools/combat_mode.py` CLI + 前端 `CombatModeManager.tsx`（管理页入口进主菜单与顶栏）；
  方案文档 `docs/proposals/combat-mode-plugins.md`。
- **冻结演练存档运行**（`bd7f278`）：模式包自带冻结存档直接开练；示例包
  `examples/combat-modes/stance-duel/`（manifest / main.js / practice.json + 包内测试）；前端
  `features/combatModes/`（`RuntimeFrame.tsx`、`runtimeDocument.ts`）与 `CombatModesView.tsx`。
- **会话生命周期集成**（`53c6ad8`）：`combat_mode_sessions.py`、`combat_mode_bindings.py`、
  `blueprints/combat_plugins.py`；创建向导可选模式，`PluginCombatView.tsx` 承载插件战斗，
  `ChatPanel` 入口与 `useCombatResume` 恢复接入。
- **作者工作流与目录契约**（`2b8d866`）：世界书适配器示例
  `examples/worldbook-adapters/stance-duel.json`、README 与集成测试补齐。
- **PC 验收**（`4aafd3a`、`c75ae13`）：修复模式标识、创建模式、断线提示与主题问题；910 项测试
  通过 / 4 项跳过；验收报告归档 `docs/archive/combat-plugin-pc-qa-2026-10-06.md`（Electron 运行与
  下载落盘未覆盖，已如实记录）。

### 2026-10-04 — 剧情会话体验：选项居中、End 快进、完整剧情地图

- **选项居中、对话框不动**（`1d1a125`）：对话框固定在底部不再被选项顶起；选项在画面中央独立显示、
  过多时单独滚动；选项去掉「情报」「作者预设分支」等标签，只留剧情正文与必要的禁选原因
  （`StoryChoices.tsx`、`StageView.tsx`、`chat.css`）。
- **End 快进**（`290a365`）：焦点在舞台 / 对话框时按 End 直接跳过本轮对白显示选项（无选项则显示
  输入框），不自动选择或发送；原 Ctrl 快进保留。
- **完整剧情地图**（`5413cf3`、`8a2c6f1`）：会话剧情图谱展示完整故事地图并标记当前阵容；
  复用世界书图谱的布局与可拖拽画布（`SessionStoryGraph.tsx` 重写、`utils/sessionStoryGraph.ts`）。
- **会话隔离修复**（`bc91a99`、`14238c3`）：异步战斗事件按会话隔离、scoped 头像恢复；手动战斗响应
  守卫与返回视图刷新；新增 `scripts/test_session_isolation.cjs` / `test_session_isolation_browser.py` /
  `test_sse_lifecycle.cjs`。
- **吉祥物 logo 定稿**（`6cf7de6`）。
- **验证**：构建与三种桌面尺寸浏览器验收通过；提交均合并 main。

### 2026-09-30 — 战斗网格演练恢复与角色身份口径

- **网格演练恢复**（`d55462b`）：补回 `data/tactical_practice/`（近卫 / 狙击 / 医疗 / 重装四职业卡牌、
  训练节点 `enc_builtin_training.json`、`party.json`）；战斗视图角色形象口径修正
  （`CharacterIllustration`、`CombatView`、`PixiCombatScene`、`fallbackToken`，PixiJS 场景随 Spine
  覆盖层逻辑大幅调整）。

### 2026-09-29 — 世界书书架加载性能

- **书架提速**（`bf0387f`）：书架加载路径优化、wiki 刷新延后（`wiki_manager.py`、
  `worldbook_folder_store.py`、`hooks/wiki_prefetch.py`、`blueprints/wiki.py`）；新增基准脚本
  `scripts/bench_worldbook_loading.py`。
- **书架自动加载**（`0816149`）：进入世界书页自动加载书架，文件夹操作简化。

### 2026-09-28 — 世界书自包含文件夹存储与旧格式退役

> 安装后的世界书改为「一书一文件夹、资源自包含」，项目内部旧 schema / 旧运行时读取全部退役；
> 同日定下内部版本政策：不为自身旧格式保留兼容分支（外部 SillyTavern 格式例外）。

- **自包含文件夹**（`8249743`、`3e64753`、`d273cf3`）：安装的书存为独立文件夹，内容收进书文件夹；
  资产与身份按书隔离（`17d2460`），编辑器资源限定在书文件夹内（`2af0b44`），本地卡牌保持可见、
  combat goldens 按作用域隔离（`37c776b`）；导入的会话快照还原为文件夹书（`1d245d8` +
  `6ada52d` 测试钉住）。涉及 `blueprints/assets.py`（重写 323 行）、`cards.py`、`world_book.py`、
  `scripts/migrate_worldbook_layout.py` 等。
- **便携打包**（`37ce3d3`）：世界书连同自有资源整体打包迁移。
- **旧格式清理**（`b716e23`、`77d2df0`）：删除旧 schema 兼容分支与旧运行时读取路径；
  `89cdad0` 把「内部版本策略 + 外部格式例外」写成文档口径（即现 AGENTS.md 的关键约束节）。
- **管理界面简化**（`28ccfbb`）。

### 2026-09-28 — 会话实时剧情图谱与叙述规则绑定世界书

- **实时剧情图谱**（`ceb0745`）：对话页新增 live 会话故事图，带角色位置标记
  （`components/story/SessionStoryGraph.tsx` + `utils/sessionStoryGraph.ts` +
  `styles/session-story-graph.css`）；台词归属优先显式说话人证据、证据不足保留未知归属（`5610286`）；
  图谱节点详情查看与剧情引用修复（`0c17e25`，`GraphNodeDetails.tsx`、`graphReferences.ts`）。
- **叙述数值与物品选择绑定世界书**（`70b506a`）：设计文档 `docs/design/narrative/story-rules.md`；
  剧情选项组件 `StoryChoices.tsx`；`SceneManager` 与 `blueprints/chat.py` / `scene.py` 配套；
  `scripts/prepare_beyond_twin_story_rules.py` 为彼岸双生配置剧情规则；`scripts/test_story_rules_ui.cjs`
  钉住交互。
- **验证**：`scripts/test_session_graph_browser.py`、`test_session_graph_ui.cjs`、
  `test_graph_details_browser.py` 等新增 / 更新通过。

### 2026-09-28 — 界面细节一批与工作区清理

- **统一危险操作确认**（`9df9e10`）：新增主题化确认对话框 `components/common/ConfirmDialog.tsx`，
  替换 12 个组件里各自的删除确认（世界书 / 角色 / 资产 / 记忆 / 剧情状态 / 战斗节点等）。
- **会话界面**：「主控与阵容」选择界面精简（`32f84c5`）；人物简介改浮动提示（`779ced8`）；
  大厅目录复用、新建向导即时可交互（`670648c`）；sideview 输入生命周期与响应式加固（`9d72dbc`）；
  世界书分组可读性改进（`e3e6083`）。
- **工作区清理**（无提交）：确认 main 与 origin/main 无差异后，清理 9 个已完成 worktree 与 2 个
  临时副本（先断开 `frontend/node_modules` junction 防连带删主仓依赖），删除已合并分支
  `feat/story-rules`、`feat/task-graph-continuation`；保留含未合入提交的 `script-lab-20260927` 克隆。

### 2026-09-27 — 补遗：形象候选上传、资源页布局、浅色大厅横幅、彼岸双生剧情美术

> 当日两条正式条目（剧情自动选中、项目更名）之外的一批落地改动，补记于此。

- **角色形象候选上传**（`2535a13`）：上传不再直接覆盖，先进候选列表
  （`resources/characters/<name>/candidates/<media_type>/`），点击候选才应用；应用时旧覆盖归档回
  候选（内容去重），换形象不丢图；候选不计入已覆盖判定，随存档导出携带；sessions 蓝图新增候选
  上传 / 服务 / 应用 / 删除四端点；`tests/test_session_character_candidates.py` 覆盖上传不覆盖、
  应用 / 切换 / 去重、删除保留生效图、路径穿越与非法类型。
- **资源页彩色区块 + 侧栏拖拽调宽**（`3cae162`）：角色形象改按名字哈希稳定着色的色块，只显示本会话
  生效图（会话覆盖 → 书内快照 → 全局默认）；新增 `useResizableWidth` + `ResizeHandle`（拖拽调宽、
  localStorage 持久化、键盘微调、双击复位），接入对话页场景面板（220–560px）、大厅会话列表与
  教程目录。
- **浅色主题大厅横幅**（`361c669`）：`html.light` 覆盖 `session-hero` 与战斗演练面板为浅底深字，
  用 `background-image` 长手避免重置基类 `background-size: cover` 与渐变字。
- **彼岸双生剧情美术**（`722508d`、`d002aac`、`310d22e`、`f27090e`）：剧情立绘 / CG 补全
  （Nicole 走廊坠落 CG、程旭显示器朝向修正、雨景 CG 替换）；节点图配置舞台背景与 CG 线索
  （`f417425`）；世界书动态预览条目显示触发词（`c1ea2c2`）。

### 2026-09-27 — 新建会话：选中剧情即自动选中世界书与该书全部角色

> 点一下剧情，绑定的世界书、默认主控与该书的角色都自动选中；「主控与阵容」这一步从此只选角色。

- **剧情声明驱动默认选中**：剧情 frontmatter 新增可选 `player_identity`（默认主控），`worldbook_id`
  经 `/api/plots` 一并返回。选中剧情即自动绑定该书（书未安装时保留玩家当前选择），主控取
  `player_identity`、缺省回退开场角色首位；规则在 `utils/characterCatalog.ts` 的
  `resolvePlotDefaults` / `resolveLineupDefaults` 里只有一份（`pickPlot` 与界面提示共用，
  `scripts/test_session_main_control_ui.cjs` C 段钉住）。
- **该书角色整批入选**：新增 `WorldBook.character_ids()`（启用且非系统条目的 `character_id`，
  去重保序），随 `/api/worldbook` 摘要返回 `character_ids`；自动选中 = 该书花名册 + 剧情开场角色
  − 主控，整批入队并标「自动预选」（长夜临光实测：主控博士 + 17 名）。书内名单只能从条目上读 ——
  角色卡 frontmatter 的 `worldbook_id` 记的是拆分前的 `arknights`。
- **候选不再只认角色卡的来源书**：候选 = 已绑定世界书的角色 + 各书花名册 + 剧情自带阵容
  （`selectableCatalogItems`）。拆分出来的剧情书（`near-light` / `fengxue-guojing` / `combat-test`）
  内条目带 `character_id`，只按来源书过滤会让「这本书的角色」整批消失。
- **绑定大书不会静默塞满阵容**：自动选中只吃剧情声明那本书的花名册（`resolveLineupDefaults` 的
  `rosterBookIds`）；手动再加书只扩候选，要一并选上走队友区的显式按钮「按绑定世界书全选角色」。
- **开场角色口径统一**：`session_overlay.plot_initial_characters` —— `initial_characters` 优先，
  没有该字段时回退旧字段 `characters`（「灰灯渡口」「战斗功能测试」）；服务端开场加载、
  `session_manager` 的重载回退与 `/api/plots` 共用同一份。
- **「主控与阵容」只选角色**：候选范围、手动追加条目与全量兼容不再在这一步调整（按书配置在世界书
  工作台）；创建仍提交空追加 / 非全量，与 `POST /scope-preview` 指纹同口径。
- **「命名创建」只显示估算 token**：不再整块渲染候选范围卡片，「候选规模减少 0 token（0%）」这类
  无信息量的行消失；候选条目明细仍在世界书工作台查看。
- **改动位置**：`src/world_book.py`、`src/blueprints/sessions.py`、`src/session_overlay.py`、
  `src/session_manager.py`、`frontend/src/utils/characterCatalog.ts`、
  `frontend/src/components/session/CreateSessionWizard.tsx`、`frontend/src/types/index.ts`、
  `data/worldbooks/content/plots/*/index.md`（5 份剧情补 `player_identity`）与
  `data/worldbooks/content/plots/TEMPLATE.md`；`tests/test_worldbook_system_layer.py`（花名册与摘要）、
  `tests/test_data_layout.py`（剧情字段与 `characters` 回退口径）。

### 2026-09-27 — 项目更名 Ark Tavern（仓库 `ark-tavern`）

> 仓库与产品名统一为 **Ark Tavern**：GitHub 仓库由 `arknights-tavern` 更名为 `ark-tavern`（旧地址自动重定向）。

- **应用标识**：`frontend/package.json` 的 `build.appId` 由 `com.arknights-tavern.app` 改为 `com.ark-tavern.app`；
  `name` / `productName` 仍为 `ark-tavern` / `Ark Tavern`。
- **界面与预览稿**：`ui-styles/` 下 6 份风格预览稿的品牌字样统一为「Ark Tavern / ARK TAVERN」，
  `frontend/src/styles/skin-tavern.css` 注释同步。
- **保持不变（数据与存储契约，不随更名改动）**：世界书扩展命名空间 `extensions.arknights_tavern`、围栏
  `arknights_tavern_lore_bindings`、`localStorage` 键 `arknights-tavern.worldbook.pending.v1`。
- **历史归档不回改**：`docs/archive/` 保留当时的旧称与旧本机路径。
- **历史重写**：本次 `main` 推送包含一次提交历史重写，提交哈希全部变化。既有 clone 请重新克隆，
  或在确认无本地改动后 `git fetch origin && git reset --hard origin/main`。

### 2026-09-23 — 对话页：舞台视图、场景面板插件化、角色数值三层口径

> 对话页多了一个像 galgame 的「舞台」布局；左侧面板改成图标栏 + 页签并对第三方开放；
> 「资产 / 卡牌」并入角色之下，角色多了一栏按世界书统一字段填写的「数值」。

- **舞台视图**（`components/stage/StageView.tsx` + `utils/stageScript.ts` + `GET /api/sessions/<id>/stage`）：
  顶栏「记录 / 舞台」切换（localStorage 记住）。舞台 = 背景（会话覆盖 > 地点 `combat_bg` > default，都没有时按
  时段 / 天气生成渐变）+ 场景角色立绘（会话覆盖优先，没有立绘退回头像牌）+ 底部对话框。最新一条叙述 / 回复拆成
  逐句步骤，点击对话框推进（空格 / 回车 / →，← 回退），**说话人的立绘高亮、其余压暗**，同一说话人也同步高亮到
  场景角色列表；走到末尾亮出选项，流式生成实时显示。「记录」按钮把完整消息流以抽屉覆盖在舞台上（同一份 DOM）。
  消息流里点击台词气泡同样高亮说话人。
- **顶栏与面板布局**：撤掉对话区页头的「会话大厅 🏛」（顶栏已有「返回大厅」）与「会话资源 🗂」；场景面板的
  开合按钮移到顶栏**左侧**（与它控制的面板同侧）；原右侧独立的「会话资源」并入场景面板成为「资源」页。
  场景面板改为**竖向图标栏 + 当前页**（角色 / 物品 / 环境 / 剧情 / 回忆 / 任务 / 数值 / 资源），收起时只剩图标栏。
- **场景面板插件接口**（`plugins/scenePanels.tsx`）：内置面板与第三方面板走同一个 `registerScenePanel()`；
  第三方文件放 `plugins/custom/*.tsx` 自动加载（示例：会话笔记）。面板拿到 `ScenePanelContext`：`stats`（会话数值
  读写）、`data`（按命名空间的插件数据，≤ 64 KB / 命名空间）、`refresh` 刷新键、`api`。数据接口在新蓝图
  `blueprints/stage.py`，插件数据与会话数值都存 `overrides.json` 并随剧情树节点快照回档。
- **角色数值三层口径**（`character_stats.py`，设计 `docs/design/session-scene-plugins.md`）：字段定义在世界书
  （`stat_fields`，工作台 hero「数值字段」对话框；随书保存 / 导出 / 导入 / 复制），角色全局值写 frontmatter `stats`
  （角色页「数值」页签），会话值写 `character_stats`（场景面板「数值」页）。合并顺序默认 → 全局 → 会话，界面标来源；
  会话内字段以**会话绑定书**为准。有非默认值时叙述提示词多一个 `<character_stats>` 块，自由模式角色回复的场景上下文
  也带【角色数值】。
- **角色页**：角色详情分「资料 / 数值 / 资产 / 卡牌」四个页签；「资产」只看这个角色的头像 / 立绘 / 卡面，上传直接落到
  `avatar/` `skin/` 子目录所以能设默认（总资产页上传到实体根目录设不了默认的问题绕开了）；「卡牌」内嵌卡牌编辑器。
- **视觉**：对话页样式集中到 `styles/chat.css`（`--ng-*` 令牌，随皮肤与明暗）：顶栏、页头、消息气泡（叙述衬线、用户
  渐变蓝、选项卡片）、回退分隔线、输入栏与发送按钮、舞台的对话框 / 名牌 / 选项 / 环境角标。皮肤工具类覆盖块重跑
  `scripts/gen_skin_utils.py`（230 类）。
- **验证**：`tests/test_character_stats_api.py`（13 例：字段规范化与校验 / 值转换与合并 / 提示词块 / 世界书序列化与
  导出回读 / 全部端点 / 快照回档）+ 全量 pytest 通过；`scripts/test_stage_ui.cjs`（舞台脚本、注册表、字段编辑器、
  SSR 骨架）；`scripts/shot_chat_ui.py` 真实页面 18 屏截图（默认 / light / PRTS / 酒馆皮肤）无页面错误；`tsc` 与
  `vite build` 通过。

### 2026-09-23 — 新建会话：主控角色与角色入队合并为同一次选择

> 「选玩家身份」不再是独立一步：玩家在「主控与阵容」里挑一个角色当主控（= 玩家身份），
> 该角色随即入队；队友在同一个列表里多选。候选目录把自建角色与世界书角色放在一起并标注来源。

- **流程**：向导步骤由 `模式 → 玩家身份 → 剧情 → 世界书 → 角色入队 → 命名` 收敛为
  `模式 → 剧情 → 世界书 → 主控与阵容 → 命名`（自由模式无剧情步）。原「玩家身份」步删除，
  其数据源 `/api/player-identities`（只含 `player_identity: true` 的角色）不再决定候选人；
  主控可以是角色库里的**任何**角色。
- **共用选择逻辑**：新增 `components/session/CharacterPicker.tsx`（搜索 + 来源筛选
  「全部 / 自建 / 世界书 / 具体某本书」+ 磁贴，单选或多选）+ `utils/characterCatalog.ts`
  （纯逻辑：目录构建与来源判定、筛选、绑定书优先排序、阵容去重、主控校验）。新建向导的
  主控步 / 队友步、会话大厅的「添加角色」与「换主控」共用这一个组件，不再各写一份。
- **主控语义**：主控经 `identity` 声明并作为阵容首位入队，队友经 `roster_character_ids` 入队，
  同一角色不会因「身份」与「入队」两条路径重复出现。服务端口径收敛到
  `SceneManager.get_roster()`（主控 + 队友）：候选范围解析、会话依赖面板、换主控后的重算
  全部改用它；`get_scene_characters()` 仍只有队友，模型不会替玩家说话。
  `Session.to_dict()` 新增 `roster`，会话大厅阵容区按它渲染并把主控标为「🎭 主控（你）」（不可移出）。
- **边界处理**：没选主控不能创建（向导拦截 + 后端对**显式空** `identity` 直接 400；
  完全不传该字段的旧调用方仍回落「博士」）；世界书角色缺头像走既有 `EntityAvatar` 首字色块兜底、
  缺 `summary` 显示统一文案并标「缺简介」、缺目录 id 用展示名成键、既无 id 又无名的条目从候选中
  剔除并如实提示条数。
- **验证**：`tests/test_session_main_control.py`（12 例：空主控拒绝 / 主控进阵容不进场景 /
  不重复 / 换主控同步 / `SceneManager` 阵容口径与范围重算）+ `tests/legacy/main_control_flow.py`
  （真实应用端到端：自建主控与世界书主控两条路径的「预览 → 创建」指纹一致、阵容与场景口径）
  + `scripts/test_session_main_control_ui.cjs`（候选目录纯逻辑 + `CharacterPicker` SSR 结构）。
  前端 `tsc` 与 `vite build` 通过；改动文件经 Impeccable 检测器扫描无告警。
  另修复 `tests/test_node_graph_worldbook.py` 的 `PLOT_BOOKS` 漏登记 `beyond_twin`（`6d967c6`
  新增该剧情后该用例一直 `KeyError`，与本改动无关）。

### 2026-09-22 — 角色页视觉整理：撤重复入口、统一控件与字体语言、验证玩家身份实例

> UI 专项（承接同日的信息架构合并）：「角色」页四个模块页签的重复展示清掉，
> 三个界面改用同一套控件与字体语言，并用一个真实的玩家身份实例做了整页截图验证。

- **撤掉的重复展示**：角色库的「平铺 / 按世界书」维度切换删除——两者展示同一份列表，
  只差不分组，现只按来源世界书分组（点分组头的「全部」回到不过滤状态）；资产 / 卡牌侧栏
  顶部与模块页签同名的「资产」「卡牌」标语删除；「新建身份」由三处收敛为工具栏一处，
  空状态只做文字引导；资产页「按类别」维度下来源下拉只做筛选，不再切成第二套按书分组；
  每个侧栏只保留一个「折叠 / 展开」（作用于该视图可折叠的那一级）；本家角色 `title` 与
  `name` 同值时列表行不再重复显示一行；卡牌编辑器内嵌时不再重复渲染实体标题。
- **共用控件与字体语言**：新增 `components/roles/RoleWidgets.tsx`（面板页头 / 来源徽章 /
  工具栏图标按钮 / 折叠按钮 / 搜索框 / 操作按钮 / 空状态 / 来源世界书下拉）与
  `components/roles/EntityAvatar.tsx`（无头像时按名称取色的首字色块）；`styles/roles.css`
  定义衬线标题 + Orbitron 眉标 + 分节线，色值取 `--ng-*` 令牌，随明暗与两套皮肤切换；
  `AppIcon` 补 14 个图标（身份 / 用户 / 职业 / 关闭 / 折叠展开 / 裁剪 / 保存 / 加号 …），
  「＋」「✕」「★」等字符图标全部换成 SVG；皮肤工具类覆盖块按新用到的 Tailwind 颜色类重新生成。
- **顺手修正**：新建 / 删除玩家身份后角色库列表同步刷新（身份本就是角色目录）；卡牌页
  新增名称搜索；卡牌编辑器的页签、按钮与空提示改为中文。
- **验证**：`scripts/test_role_worldbook_nav_ui.cjs` 新增第 6 节断言（重复入口不回流、
  共用控件到位），并修复其转译钩子未传 `fileName` 导致自 `d328ce0` 起即失败的问题
  （见 `notes.md`）；新增 `scripts/shot_roles_ui.py`：驱动截图专用前端（5174 → 5001）
  逐屏截图，并新建示例玩家身份「龙门侦探」确认身份编辑器、列表行与角色库分组；
  `vite.config.shot.ts` 改用独立 `cacheDir`，避免与主开发服务器互相覆盖依赖缓存。
- **已知未修**：资产页实体行「+」上传落在实体目录根、不进 `avatar/` 子目录，故上传的图片
  不能设为默认头像（`notes.md` 已记）。

### 2026-09-22 — 世界书「本家索引」改为会话条目特调

- 页签改名为「会话条目」，移除原全局 Markdown 索引的导入、导出和依赖验证操作，只保留刷新。
- 默认源按当前世界书分类展示条目；会话源只列出绑定当前世界书的会话，不再混入其它书或未绑定会话。
- 单条配置支持「跟随默认 / 启用 / 停用」：世界书条目配置是默认值，会话覆盖只写入本会话作用域；接口使用 `scope_revision` 防止并发覆盖。

### 2026-09-22 — 信息架构合并：内容中心拆解 + 角色/世界书两级

> UI 与信息架构专项（承接 09-12 的信息架构整治）：一级入口由六项收敛为五项——
> 「内容中心」整页删除，资产与卡牌并入「角色」页的模块页签，节点图并入世界书
> 工作台并替换掉旧的「节点视图」页签，跨世界书统一检索迁到世界书书架。

- **「内容中心」一级入口删除**：`ContentHub.tsx` 整文件删除，store 的
  `contentHubTab` 一并移除；主菜单（`HomeMenu.tsx`）与顶栏（`GameTopBar.tsx`）
  只剩 会话大厅 / 角色 / 世界书 / 文档 / 设置，原「角色管理」标签改为「角色」。
- **资产 / 卡牌并入「角色」页**：`CharacterManager.tsx` 现有四个模块页签
  角色库 / 玩家身份 / 资产 / 卡牌，页签状态收敛为 store 的 `characterTab`
  （`characters` / `identities` / `images` / `cards`），跨组件跳转直接落到指定页签。
- **节点图并入世界书工作台，替换旧「节点视图」**：工作台页签由
  `条目` / `Prompt 预览` / `节点视图` / `本家索引` 改为
  `条目` / `Prompt 预览` / `节点图` / `本家索引`（页签值 `nodes` → `graph`），
  新页签挂 `components/combat/PlotGraphPage.tsx`，以当前选中的世界书为受控书、
  整页画布编辑。
  - 旧的「节点视图」**整页删除**（记录条目注入顺序的那张只读轨道图）：组件
    `components/worldbook/tabs/NodeViewTab.tsx`、样式
    `styles/worldbook-node-view.css`、纯逻辑 `utils/worldbookNodeView.ts`、
    UI 测试脚本 `scripts/test_worldbook_node_view_ui.cjs` 全部移除；只服务于它的
    `promptPreviewOrder` 死状态一并删除。
- **依赖配置的编辑 UI 处于未接线状态**（本次核实）：`分类与载入` 页签早已撤销，
  其三个子视图 `components/worldbook/tabs/LoadTab.tsx` /
  `components/worldbook/WorldBookConfigOverview.tsx` /
  `components/worldbook/WorldBookEntryWorkbench.tsx` 当前没有任何引用，配置草稿的
  `patch` 无调用点；`条目` 页上的「节点配置有未保存修改」保存条实际不可达，
  保留原路径待接线（草稿、接口与数据不变）。
- **统一检索迁到世界书书架**：原内容中心顶栏的跨世界书条目检索移到世界书工作台
  左侧书架上方；命中后选中该书、跳到「条目」页签并预填条目筛选。
- **跨页跳转改写**：战斗页战前简报的「⚙ 编辑此节点」由「内容中心 → 节点图」
  改为「世界书 → 节点图」（先定位该节点归属的世界书，再落到节点图页签）；
  会话大厅 / 新建会话向导的「管理玩家身份」跳到「角色 → 玩家身份」；角色卡详情的
  「编辑卡牌」切到「角色 → 卡牌」。
- **受影响文件（本批主要改动）**：
  - 删除：`frontend/src/components/ContentHub.tsx`、
    `frontend/src/components/worldbook/tabs/NodeViewTab.tsx`、
    `frontend/src/styles/worldbook-node-view.css`、
    `frontend/src/utils/worldbookNodeView.ts`、
    `scripts/test_worldbook_node_view_ui.cjs`；
  - 前端：`frontend/src/App.tsx`、`components/HomeMenu.tsx`、
    `components/GameTopBar.tsx`、`components/CharacterManager.tsx`、
    `components/AssetManager.tsx`、`components/CardManager.tsx`、
    `components/WorldBookManager.tsx`、`components/combat/CombatView.tsx`、
    `components/combat/PlotGraphPage.tsx`、`components/session/SessionManagerView.tsx`、
    `components/session/CreateSessionWizard.tsx`、
    `components/worldbook/tabs/types.ts`、`stores/appStore.ts`、`types/index.ts`、
    `utils/worldbookLibrary.ts`、`styles/worldbook-graph.css`、`styles/worldbook-entry-refresh.css`
    （节点图页签的满幅画布布局 + 书架统一检索的样式）、`style.css` 与 `ErrorBoundary.tsx` /
    `AssetManager.tsx` / `CardManager.tsx` / `WorldBookScopePreview.tsx` 的注释与文案
    （仅去掉对已删入口/页签的指路）；
  - 皮肤生成块：`scripts/gen_skin_utils.py`（仅注释口径）与重跑生成物
    `styles/skin-prts.css` / `styles/skin-tavern.css`（内容中心删除后，仅它使用的颜色工具类
    不再出现在扫描结果里；顺带收进此前漏生成的一项）；
  - 测试脚本：新增 `scripts/test_role_worldbook_nav_ui.cjs`（导航结构 / 角色页模块页签 /
    工作台四页签 / 已删文件不回流）；改 `scripts/test_worldbook_scope_ui.cjs`、
    `scripts/test_worldbook_library_ui.cjs`；
  - 文档：`docs/architecture.md`、`docs/tutorial.md`、`README.md`、
    `docs/design/content-hub-design.md`、
    `docs/design/worldbook/worldbook-on-demand.md`、
    `docs/design/worldbook/worldbook-library.md`、
    `docs/design/narrative/rag-retrieval.md` 与 `docs/system-update-log.md`
    （本文件）。

### 2026-09-12 — 信息架构整治：内容中心去重 + 世界书归属 + 节点图编辑器

> UI 与信息架构专项：消除重复入口、收敛功能层级、把"世界书"确立为内容归属的
> 一等主体（剧情语料、战斗节点、资产与卡牌的来源标注）。

- **返回入口全站唯一**：`ContentHub` 子栏的「◀ 主菜单」删除，返回统一走全局
  顶栏 `GameTopBar`（全库排查仅此一处重复；ChatView 的返回按钮在沉浸式页面，
  是唯一入口，不属重复）。
- **删除「角色·剧情」栏，文档迁移世界书**：`DocumentManager`（1737 行，文档/
  图像/卡牌三层 Tab 嵌套）拆解删除——
  - 图像管理 → `AssetManager.tsx`（内容中心「资产」Tab，等价入口）；
  - 卡牌管理 → `CardManager.tsx`（内容中心「卡牌」Tab，等价入口）；
  - SillyTavern 角色卡导入 → `CharacterManager`（原有）与世界书导入（PNG/JSON
    连带导入角色 + 内嵌世界书）双入口保留；
  - 文档语料 → `scripts/generate_builtin_worldbook.py` 重写为**世界书整合包**
    生成器：12 类语料（世界观/规则/属性/种族/职业/地点/物品/敌人/角色/剧情）
    全量完整正文打包为 `data/packs/arknights.json`（109 条，~215KB），随程序
    预装分发，亦可经世界书导入功能手动导入；
  - 统一检索只搜世界书条目；`CharacterManager` 的「编辑角色资料」改为跳转
    世界书页（优先该角色标注的来源世界书）。
- **战斗节点 → 关联世界书 + 节点图**：
  - 节点 JSON 新增 `worldbook_id` 归属字段（世界书导入自动标注；存量 16 节点
    已迁移归属 arknights；剧情 index.md frontmatter 同步标注）；
  - `combat_nodes.plot_flows`：解析剧情叙述区的章节/节拍结构与 `[COMBAT:]`
    引用（只收叙述区，忽略 near-light 场景流程图配置区里的重复章节）；
  - 新端点 `GET /api/combat/nodes/graph?book_id=` + 节点列表 `book_id` 过滤；
  - `NodeFlowEditor.tsx`（新）：先选世界书再编辑，横向可展开节点图同屏呈现
    剧情节点（plot → 章节 → 节拍，章节可折叠）与战斗节点（节拍 ↓ 连线触发），
    「未绑定剧情」与跨书引用单独呈现；点击任意节点开右侧抽屉编辑、支持增删；
  - `BattleNodeForm.tsx`（自原 BattleNodeEditor 抽出）：单节点完整编辑（地图/
    波次/难度/校验/试打），抽屉内挂载；
  - `StoryBeatEditor.tsx` + `utils/plotBeatEditor.ts`：剧情节拍抽屉编辑，对
    `data/plots/<id>/index.md` 做节拍增删改的 Markdown 手术（documents API
    保存，`_hash` 冲突检测；注意会按 yaml 规范化 frontmatter，与
    `set_default_image` 同一行为模式）。
- **资产/卡牌标注来源世界书**：
  - 实体 index.md frontmatter 新增可选 `worldbook_id`（来源约定）；角色卡
    导入时自动写入其内嵌世界书 id；
  - `GET /api/assets/images` 附带 `parent_dir`（上级目录）与 `worldbook_id`；
    `GET /api/cards/tree` 附带 `worldbook_map`；
  - 新端点 `PUT /api/assets/<category>/<entity>/worldbook` 标注/清除归属
    （资产与卡牌共用）；
  - `AssetManager`/`CardManager`：实体条目显示来源徽章，支持按世界书筛选
    （选中后按书归类分组），详情面板可改标注。
- **测试**：新增 `tests/test_node_graph_worldbook.py`（plot_flows 解析、按书
  过滤、导入自动打标 10 项）；已跟踪 pytest + perf_tests 全绿；前端 tsc +
  vite build 通过。

### 2026-09-12 — 战斗系统重构批次 3：升级属性点 + 难度带生效 + LLM 生成铺垫

> 承接批次 2（编辑器）。本批次补齐"成长曲线不好"与"为 AI 生成战斗铺垫"两件事，并把散落的
> 威胁模型收敛成一份可复用实现。

- **升级重新发放属性点**（`src/combat_rules.py` + `src/combat_settlement.py`）：
  `data/combat/rules/growth.json` 可配「每级属性点」（默认 1）；默认
  `auto_allocate_attribute_points=true` 时自动加到**最低未满属性**并写回
  `attribute_changes` → 会话覆盖 → 下一次战斗的战斗数值（HP/攻/防/速…按公式派生）。
  关掉自动分配则累积为 `progress.attribute_points` 待分配。结算界面新增
  「属性点 +N（已自动分配/待分配）」与专精点行。
  此前 `attribute_changes` 在 v1 恒为空（"属性只由剧情里程碑改变"），现按用户要求重做。
- **难度带与威胁预算生效**（`src/combat_balance.py` + `data/combat/rules/difficulty.json`）：
  - 威胁模型从 `scripts/migrate_balance_v1.py` 抽成共享实现（五类模板 / 威胁点 /
    期望 DPR / 有效生命 / 阶段带推荐），校验器、编辑器、生成与审计工具共用；
  - 校验器返回 `metrics.threat`（实际威胁 vs 声明预算、声明阶段带 vs 模型推荐），
    容差 25%，**只警告不阻断**；逐单位 `stats` 覆盖会重新分类（hp 150 的"士兵"不再算 1.6 威胁）；
  - 节点写 `difficulty.apply_band_scaling: true` 时，敌人数值按阶段带倍率缩放
    （T0 ×0.8 … T4 ×1.75/×1.5），一套敌人覆盖多个难度档；默认关闭（数值即文件终值）。
- **生成 → 校验 → 试跑 → 入库 闭环**（为 LLM 生成铺垫）：
  - `docs/design/combat/battle-spec.md`：节点 JSON 全字段、格子效果、威胁与阶段带锚点、硬错误/警告清单、
    世界书分发格式 —— LLM 与设计者共用的规格说明书；
  - `tools/validate_battle_spec.py`：候选规格结构+数值自洽校验（退出码门禁，支持批量/stdin）；
  - `tools/simulate_battle.py`：**未入库候选**也能固定种子试跑，输出胜率/中位回合/P90/
    首回合清场/治疗溢出/血损/每轮 AP，并支持 `--min-win-rate` 等阈值判定；
  - `tools/generate_battle_spec.py`：按阶段带程序化生成合法战斗（保留中央通路避免软锁，
    按威胁预算凑编排，生成后自校验），作为 LLM 的确定性基线与兜底；
  - `.agents/skills/combat-designer/SKILL.md`：给代理/LLM 的流程规范（铁律：不改引擎、
    先校验后试跑再入库、数值要有依据；含判定标准表与回报格式）。
- **审计工具收敛**：新增 `tools/balance_audit.py`（敌人分层一致性 + §12「XP 与威胁点单调」
  + 节点预算/阶段带），产出 `perf_tests/balance_audit_report.md`；删除已失效的
  `scripts/migrate_balance_v1.py`、`scripts/tune_encounters_v1.py`
  （输入格式 `data/combat/encounters|enemies/*.md` 已在批次 1 被 JSON 节点 + 统一敌人库替代）。
  当前审计结论：敌人分层偏差 0、XP 单调性 0 问题、节点 1 处真实偏差
  （`enc_elite_hunt` 实际威胁 11.0 vs 声明预算 7.0，待设计者决定是调预算还是削编排）。
- **文档对齐**：`docs/design/combat/combat-numerical-design.md` 升到 v1.2 —— 共享 AP 旧口径
  （`2 + (INT-5)//3`、上限 3、AP=3 卡"不可行"）全部改为 v1 实际值（基础 4 / 最高 5），
  网格与距离改为自由尺寸 + 统一曼哈顿。
- **测试**：新增 `tests/test_combat_growth_balance.py`（24 项：属性点分配/满值封顶/写回载荷/
  威胁分类/阶段带推荐/预算告警/带宽缩放生效/生成器与两个 CLI 闭环/可复现性/接口指标）；
  更新 `perf_tests/test_settlement_v1.py` 的成长断言。全量 `bash scripts/run_tests.sh` =
  153 + 58 + 4 个 legacy 脚本全绿；前端 `tsc --noEmit` 通过。

### 2026-09-12 — 战斗系统重构批次 2：节点注册表 + 世界书携带 + 可视化编辑器

> 承接批次 1（JSON 节点战场）。本批次把"手写 JSON 节点"变成"可编辑 + 可随世界书分发"，并让编辑器读到会话的剧情节拍进度。

- **节点注册表**（`src/combat_nodes.py`）：JSON 读写 + `_hash` 冲突检测（与卡牌共用
  `src/shared/json_hash.py`，同一套"带着旧 hash 保存 → 409"语义）+ 校验（敌人名称/数量上限/
  站位越界与阻挡/回合上限/奖励/阶段带/度量）+ 剧情节拍绑定扫描 + 会话进度 + 世界书条目编解码。
  校验规则与**开战前**一致：错误阻止保存与试打，警告仅提示。
- **接口**（`src/blueprints/combat_nodes.py`）：`GET /api/combat/nodes?session_id=`（总览：
  地图尺寸/单位数/节拍绑定/`progress` = done·current·locked/来源世界书/待创建标记）、
  `POST`（新建，空波次可存但不可开战）、`GET|PUT|DELETE /api/combat/nodes/<id>`
  （PUT 带 `_hash` → 409；DELETE 被剧情引用时 409，需 `force=1`）、
  `POST /api/combat/nodes/validate`（只校验不落盘）、`GET …/worldbook`（条目预览）、
  `POST /api/combat/nodes/import-worldbook`（按条目或书 id 导入）、
  `GET /api/combat/nodes/progress?session_id=`。
- **世界书携带**：节点可编码为一条世界书条目 —— `content` 内 ```json combat-node 围栏块
  （酒馆格式唯一无损文本通道）+ `raw.extensions.arknights_tavern.entry_type=combat_node`。
  导入世界书时**自动落地**为 `data/combat/nodes/*.json`（校验失败逐条返回错误、不落半成品）；
  导出前从注册表**回灌**条目 content，节点侧编辑不丢。
- **编辑器**（`frontend/src/components/combat/BattleNodeEditor.tsx` + `BattleMapCanvas.tsx`）：
  左侧节点列表（搜索/新建/删除/剧情节拍绑定/进度徽章/待创建提示），右侧 — 基本信息（含
  `plot/chapter/beat` 绑定）、**地图绘制**（行列调整、画格子笔刷、整图填充、玩家/敌方部署区
  涂抹）、**敌人编成**（波次增删、从图鉴加敌人、数量、**逐单位血量覆盖**、📍点图指定站位）、
  难度与奖励、服务端校验面板；顶部支持**保存（含 409 冲突重新加载）**与**⚔ 试打**。
  入口：内容中心新增「战斗节点」Tab；战斗视图战前卡片的「⚙ 编辑此节点」直接跳到该节点。
- **保底**：空节点（没有敌人）可保存但开战会被拒绝（`NodeError` → 400 与可读原因），
  避免出现"零敌人战场"。
- **测试**：新增 `tests/test_combat_nodes.py`（22 项：校验矩阵、CRUD 冲突、删除保护、
  进度、世界书往返、坏条目拒绝、整书导入、空节点拦截）。全量 `bash scripts/run_tests.sh` =
  151 + 58 + 4 个 legacy 脚本全绿；前端 `tsc --noEmit` 与 `vite build` 通过。

### 2026-09-12 — 战斗系统重构批次 1：JSON 节点战场 + 统一曼哈顿度量 + 可扩展地形

> 承接批次 0（去历史包袱）。本批次把"固定 7×7 网格 + 全局遭遇文件 + 切比雪夫距离"换成"自由尺寸战场 JSON + 统一曼哈顿 + 地形系统"，并完成敌人库合并。

- **数据格式切换**：`data/combat/encounters/*.md`（16 个）→ `data/combat/nodes/<node_id>.json`，
  **node_id 与原 encounter_id 一致**，所以剧情节拍里的 `[COMBAT:enc_*]` 零改动即可解析
  （16 个节点中 8 个已自动回填 `bind.{plot_id,chapter_id,beat_id}`）。
  两套敌人库（`data/enemies/` 叙事 11 个 + `data/combat/enemies/` 战斗 11 个，其中 2 个重名且内容不一致）
  合并为 `data/enemies/` 单一库：叙事 `attributes` + 战斗 `combat_stats`；无 `combat_stats` 的敌人
  由引擎按 `attributes` 派生数值（与玩家同一套公式）。
- **地图即数据**：`map.{rows,cols,tiles,tile_defs,deploy}`；`tiles` 支持二维 `tile_id` 数组或
  整图简写（`"ground"`）；部署区支持 `rect`/`cells` 两种写法并**真正生效**（此前 `grid_size`/
  `deploy_zones` 字段写了但代码从不读取，玩家固定 4 坐标、敌人随机落点）。上限 40×40 / 1200 格，
  校验精确到行列，软锁（出生点被墙封死）给警告不阻断。
- **可扩展地形**：格子效果由 `data/combat/tiles/*.json` 与节点内联 `tile_defs` 定义 ——
  `blocks_movement`/`blocks_los`/`move_cost`/`defense_bonus`/`evasion_bonus`/`damage_bonus`/
  `on_enter`/`on_round_start`（伤害·治疗·状态）。内置 ground/wall/cover/high_ground/hazard_fire；
  未知字段只警告（为 `on_attack`/`aura` 等留扩展位），**新增一种格子不需要改引擎代码**。
- **统一曼哈顿度量**：移动与攻击范围都改成曼哈顿（8 向，**斜向步代价 ×2**，等价于曼哈顿距离）；
  移动走 Dijkstra（含 `move_cost` 与占位），默认**禁止切角**（`rules.allow_corner_cut` 可开），
  攻击需要视线（Bresenham + 拐角；起点/终点所在格不参与阻挡，"站在掩体里仍可被瞄准"）。
  敌人 AI 的斜向贪心踏步改为**寻路下一步**（此前遇墙会卡死）。
- **射程覆盖影响与补偿**：r≥2 覆盖约减半（`(2r+1)²` → `2r²+2r+1`），r=1 由 8 邻格降为 4 正交格。
  据此对**单体近战卡**（玩家 11 张 + 敌方 `enemy_atk`/`enemy_heavy`）执行射程 1 → 2 迁移，
  补回 4 个斜角邻格；CV 预算随之收紧这几张卡的伤害（`scripts/cv_audit.py --apply`，
  新增 `melee_range_manhattan` 例外说明）。前后对照见 `perf_tests/metric_migration_report.md`
  （中位回合平均 +0.07，胜率与血损率基本持平）。
- **接口**：新增只读 `GET /api/combat/nodes`、`/api/combat/nodes/<id>`、`/api/combat/enemies`、
  `/api/combat/tiles`；战斗状态 DTO 换成 `rows/cols/tiles/tile_defs/deploy/map_warnings/
  range_metric/valid_moves_unit`（**移除 `grid_size`**），`valid_moves` 改由服务端权威计算
  （此前恒为空数组、前端自己按切比雪夫推）；`GET …/state?selected_unit=` 支持按选中单位取可达格。
  combat-test 改为节点直启（删除 `data/plots/combat-test` 的敌人池随机采样间接层）。
- **前端**：`CombatGrid` 按行列渲染（非正方形）+ 地形着色与字形 + 部署区标识；`cellSize`
  自适应（`clamp(min(availW/cols, availH/rows), 28, 72)`）；移动高亮改读服务端 `valid_moves`；
  范围/AOE 高亮与后端同度量（`metricDistance`）；战前卡片改为战斗节点下拉（显示尺寸与敌数、
  剧情节拍绑定）。
- **回归网**：新增 `tests/test_combat_map.py`（33）、`tests/test_grid_terrain.py`（13）、
  `tests/test_terrain_effects.py`（17）、`tests/test_combat_api.py`（8）；黄金基线按"有意变更项"
  重录（`tests/golden/`），全量 `bash scripts/run_tests.sh` = 99 + 58 + 4 个 legacy 脚本全绿。

### 2026-09-12 — 战斗系统去历史包袱（批次 0：回归网 + 删死代码 + 文档归档）

> 背景：项目仍处早期，**不承担旧会话/旧数据兼容**。战斗重构分三批（0 去包袱 → 1 JSON 节点地图 + 统一曼哈顿度量 + 地形 → 2 节点注册表 + 世界书绑定 + 编辑器），本条目为批次 0。

- **回归网入库**：`tests/` 解除 `.gitignore` 并纳入版本控制；新增 `tests/golden/combat_openings.json`（16 场战斗的开局结构快照）与 `tests/golden/combat_sim_metrics.json`（固定种子模拟指标），由 `tests/test_combat_golden.py`、`tests/test_combat_sim_golden.py` 守护（`GOLDEN_RECORD=1` 重录）。统一入口 `scripts/run_tests.sh`（pytest + `tests/legacy/` 脚本式检查 + 无外部依赖的 `perf_tests` 子集）。此前 AGENTS.md 写的 `python -m pytest tests/ -q` 是错的：`tests/test_*.py` 是 import 即执行并 `sys.exit()` 的脚本，会让 pytest 收集器直接 INTERNALERROR。
- **删除死代码**：战斗态从不落盘（`session.combat` 仅内存），故删除 `CombatSession.from_dict`（约 100 行）与 `CombatEngine.to_dict/from_dict`（含 v0→v1 平衡迁移分支）、`CombatUnit.from_dict`、`CardPool.from_dict`；`CombatSession.to_dict()` 收敛为结算专用的 `snapshot()`（`blueprints/combat.py` 三处调用点同步）。若将来需要"战斗中恢复"，应以「节点 spec + 命令流重放」实现。
- **修一处真 bug**：`CombatUnit.to_dict()` 缺 `is_alive`，导致结算侧 `player_alive` 恒为 True（阵亡干员按存活 100% 拿经验）。现已导出 `is_alive`。
- **删除失效工具**：`tools/migrate_combat_md_to_json.py`、`tools/split_combat_cards.py`（源格式 `combat.md`/index.md 战斗段已不存在）。`scripts/sync_cards_json_from_code.py` **保留**——`scripts/cv_audit.py:226` 依赖它生成 cv 审计基线。
- **文档口径**：`docs/archive/combat-core-design.md` 归档至 `docs/archive/`（该文档自述"已实现"，而 AGENTS.md 仍称其"未实现的目标态"，两处口径矛盾已修正）；其 B1「7×7 网格明确不改」条款作废，后续以批次 1 的可变地图为准。
- **并发核查**：入场两次 `git status` 快照一致（无并发写）；发现休眠 worktree `../arknights-tavern-ui-preview`（分支 `design/ui-preview-20260912`，11 小时前创建、近 2 小时无写入），未触碰。
### 2026-09-12 — Windows 一键重启修复：Electron 二进制自愈 + bat 编码修复

- **Electron 起不来的根因（关键）**：electron 42 的 `install.js` 依赖 `extract-zip@2 + yauzl@2`（2015 年的流式解压栈），在 Node 26 上解压 electron zip 时解压 promise 永不落定——写完第 1 个文件（`dxil.dll`）即静默挂起，事件循环清空后 node 以退出码 0 结束：不报错、不写 `path.txt`。于是 `npm run dev` 时 vite-plugin-electron 一加载 electron 包就抛 `ENOENT ... path.txt`，游戏窗口起不来。修复：用系统自带 bsdtar 从 `@electron/get` 下载缓存（`%LOCALAPPDATA%\electron\Cache`，zip 已在且校验可用）解压补齐 `dist/` 并写 `path.txt`。
- **restart-win.ps1 自愈预检**：启动前检测到 `node_modules/electron/dist/electron.exe` 缺失时，自动从下载缓存解压补齐（优先选与已装 electron 包同版本的 zip；tar 不可用时回退 `Expand-Archive`），防未来重跑 `npm install` 后复发。
- **restart-win.bat 编码修复**：`chcp 65001` 与 bat 内多字节中文注释组合会让 cmd.exe 在码页切换后按错误字节偏移重解析脚本，把注释片段（"一个窗口"、"待前端进程……"）当命令执行（`'...' is not recognized as an internal or external command`）。bat 改为纯 ASCII（逻辑与中文输出全部在 ps1 侧），`chcp 65001` 保留——对纯 ASCII 的 bat 是安全的。
- **后端就绪探测加固**：ps1 原用 `Invoke-WebRequest` 探测 `/api/status`，它会走系统代理——挂代理的机器上连 127.0.0.1 都可能被拦截（表现为等待 60s 超时，Electron 的 PythonProcessManager 健康检查同样失败，误判后端缺失再拉起第二个 Flask 抢占 5000）。改用 `HttpWebRequest` + `Proxy=$null` 直连回环。

### 2026-08-21 — 对话延迟优化：真流式 + 分调用思考档位

- **修复伪流式（关键）**：`load_llm.py` 流式路径由 `httpx client.post()`（先下载完整响应体再 `iter_lines`，导致 SSE 所有 chunk 一次性到达、首字可见≈总时长）改为 `client.stream()` 真流式；ApiLLM 与 LocalLLM（Ollama）同步修复，保留连接错误/429/5xx 重试与 400/422 stream_options 降级。实测叙述首字 20.5s → ~0.4-0.8s。
- **按调用类型显式思考档位**：`ApiLLM.chat`/`LocalLLM.chat` 新增 `thinking` 参数；新增配置 `narration_reasoning_effort`（默认 `none`）控制剧情叙述/角色对话；标记提取、回忆生成、文档摘要批处理固定 `thinking="none"`。此前 `enable_thinking=false` 时不发任何参数，DeepSeek 混合模型仍缺省思考（实测 ~550 tok），现在显式发送 `reasoning_effort=none` 才能真正关闭。
- **实测收益**：叙述总时长 20.5-23.2s → ~2.7-3.5s；标记提取 3.9-8.0s → ~1.2-2s；提取空/截断重试率明显下降。
- **设置 UI**：设置页新增「叙述思考档位」（关闭/低/中/高）。
- **其他**：embedding 端点首次失败后短路跳过（自由模式每轮省 2 次注定失败的网络请求）；`docs/perf/perf-round-latency.md` 记录完整分段测量与前后对比。

### 2026-08-18 — 外部世界书/角色卡导入修复 + 玩家身份角色

- **世界书导入支持 PNG 角色卡**：`/api/worldbook/import` 识别 PNG 签名，经 character_card 解析提取内嵌世界书（character_book / extensions.world），前端文件选择器放开 `.png`；纯 JSON/JSONL 导入行为不变
- **角色卡连带导入角色（角色/开场白可正常使用）**：世界书导入遇到角色卡（PNG/JSON）时，除导入内嵌世界书外自动写入 `data/characters/<slug>/index.md` + 头像（复用 /api/characters/import 同一条流水线，抽为 character_card.import_character_card / write_character_dir），响应携带 character 信息，前端提示"角色已连带导入，可入队使用"
- **开场白与场景对应**：角色卡导入把 `scenario`/`first_mes` 写入角色 frontmatter（正文保留分节），SceneManager 首轮叙述注入 `<opening_setup>`（场景设定 + 角色开场白，含 {{char}}/{{user}} 宏替换），开场叙述忠实呈现卡片设定；CharacterAgent 常驻 prompt 不重复注入（dump 排除 first_mes/scenario）
- **角色入队界面修复**：/api/characters 返回的 DocumentInfo 增加 `name` 兼容别名（此前前端读 `c.name` 得到 undefined → 磁贴无名字/无头像/选中态失效/入队加载失败）；新建向导与大厅角色选择器统一按目录名（slug）加载、显示显示名，选中磁贴增加 ✓/「已入队」徽章，完成页列出所选角色名单
- **玩家身份角色（用户自身）**：会话新增 `player_identity`（默认"博士"，创建时可选任意角色卡），持久化到 session.json（导出/导入存档携带）；新建会话向导新增「玩家身份」步骤（默认博士 + 角色库可选，头像/✓ 选中态）；对话/叙述 identity 默认取会话身份；叙述与角色对话注入 `<player_profile>`（身份简介/标签/背景，src/player_profile.py 进程内缓存）；用户消息气泡显示身份名；会话大厅统计网格显示玩家身份
- **测试**：tests/legacy/full_import_flow.py（解析/写盘/档案全流程）+ tests/legacy/api_integration.py（Flask 集成：PNG 导入/连带角色/会话身份/叙述注入）全绿，测试自清理无残留

### 2026-08-16 — 内容中心整合：三模块合一 + 方舟整合包（统一管理）

- **单一入口**：顶栏/主页导航「资产 / 世界书 / 索引」三项合并为「🗂️ 内容中心」（内部 Tab：角色·剧情 / 世界书 / 索引 / 资产 / 卡牌）；会话大厅「索引配置」跳转改走内容中心索引 Tab
- **统一管理模式（整合包机制）**：不做内置/导入分层——data/packs/arknights.json（git 跟踪）作为随程序分发的方舟整合包，WorldBookManager 首次启动自动安装到 data/worldbooks/（source=preinstalled），与用户导入的书在同一列表、同一套规则下管理（启用/停用、编辑、删除、一键重装、复制、导出）
- **世界书 API**：列表/详情新增 source/is_preinstalled/enabled；所有书可写（无只读层）；新增 POST /reinstall（重装整合包）、GET /search?q=（跨书/条目检索）；resolve 回退链扩展为 会话绑定 > 全局默认书 > 已启用的预装包
- **消除功能重叠**：DocumentManager 移除重复的依赖引用管理（编辑/扫描/批量扫描/断裂跟踪），收敛到索引 Tab，仅保留「🔗 在索引中管理」入口；删除 findDocNameInTree 等孤儿代码
- **统一检索**：内容中心顶栏全局搜索框跨世界书条目/文档检索，命中一键跳转对应 Tab 并选中该书
- **来源徽章**：新组件 SourceBadge —— 预装（青）/ 导入（紫），全列表统一标识
- **生成脚本**：scripts/generate_builtin_worldbook.py 从角色/剧情 index.md 生成整合包（19 角色 + 3 剧情 = 22 条）
- **测试**：test_world_book.py / test_worldbook_integration.py 全绿（31 用例）；自定义 data_dir 不注入预装包保持测试隔离
- **文档**：新增 docs/design/content-hub-design.md 设计文档；README 导航/世界书章节同步
- **角色卡导入**：POST /api/characters/import（SillyTavern 角色卡 PNG/JSON）→ data/characters/<slug>/index.md（source: imported）+ 头像 + 内嵌世界书自动导入；内容中心「角色·剧情」Tab 顶部「⬆角色卡」一键导入；新模块 src/character_card.py（PNG tEXt 解析/ST v1/v2 规范化）

### 2026-08-15 — 代码清理与可维护性优化（冗余淘汰）

- **删除死代码**：ChibiSprite.tsx、SessionList.tsx（已被 fallbackToken / 会话大厅取代）；清理其专属孤儿 CSS（.unit-hit-shake、.chibi-placeholder* 全套）
- **tsconfig 开启 noUnusedLocals/noUnusedParameters** 并修复 16 处未使用代码：App 轮询变量、CropModal pctAspect、ChatPanel handleSelectVariant（整段死函数）、CombatCard cardArtGradient 死 hash 计算、GridCell 无用 unit prop（CombatGrid 传参同步简化）、UnitStatusPanel labelColor、HomeMenu storyCount、DocumentManager scanExisting 只写状态 / closeContextMenu / updated / clearBrokenRefForDoc、IndexManager allEntityPaths、SessionManagerView bookName
- **.gitignore 补全**：.dsh-tmp/、.pi-subagents/、src/data/（运行时数据，消除长期未跟踪噪音）
- **README 更新**：过时的「左侧边栏/左侧导航」描述改为主页主菜单 → 会话大厅 → 沉浸式会话/战斗的新流程
- **Vite 构建优化**：pixi / react 手动分包（大依赖独立 chunk，利于缓存与并行加载），chunkSizeWarningLimit 600 消除构建告警
- **脚本整理**：录音（record_loopback.py）/ 转换（convert_audio.py）工具移入 scripts/audio/ 供复用，删除一次性生成/清理脚本

### 2026-08-15 — 音频控制增强：静音改暂停/继续 + BGM 音量条

- **静音改为暂停/继续**：audioManager.setMuted 由 stopBgm 改为 pauseBgm/resumeBgm（记住播放进度，再次点击从原位置继续），新增 resumeMenuBgmAfterUnmute（取消静音后若无 BGM 在播则启动菜单轮播）
- **BGM 音量可调**：setBgmVolume 按元素增益恢复音量（菜单曲目 ×0.6、战斗 ×1，WeakMap 记录）；UI 三处新增音量条——主页页脚（home-vol-slider）、管理页顶栏、设置页「音频」区块（BGM 音量 + 音效音量 + 静音开关 + 失焦暂停）

### 2026-08-15 — 主页 BGM 更换为 Mureka 生成曲目（双曲轮播）

- 用 Mureka 生成的两首自作曲替换合成 menu_loop.wav：`data/audio/bgm/menu_1.mp3` / `menu_2.mp3`（192kbps 44.1kHz）
- audioManager `startMenuBgm` 改为曲目列表顺序轮播：`playMenuTrack(index)` 播完 ended 自动切下一首，两首播完回到第一首；背景音量取用户音量 ×0.6 适配完整编曲响度；原 `menu_loop.wav` 移除

### 2026-08-15 — 菜单 BGM 重做（温暖陪伴风）

- 参考米哈游 BSide: Olivia Lin 电台气质重制 menu_loop.wav：C 大调 66bpm · 16 小节，毛毡钢琴琶音（Cmaj7-G6-Am7-Fmaj7）+ 卡林巴五声音阶旋律 + 柔和贝斯 + 垫底 pad + 黑胶爆豆/磁带嘶声；修复首尾交叉淡化的循环接缝（前移截断法，接缝仅剩单采样自然步进）

### 2026-08-15 — 游戏化界面改版：主页主菜单 + 沉浸式会话/战场 + 战斗 UI 强化

- **主页主菜单（HomeMenu）**：应用启动进入游戏主页 —— 全屏背景图（menu_bg.jpg）+ 氛围遮罩 + 「点击进入」闸门（满足浏览器自动播放策略，启动菜单 BGM）；居中栏目菜单（会话大厅/资产/世界书/索引/文档/设置），带渐显动画与主入口强调；底部显示后端/LLM 状态与音频开关
- **菜单 BGM**：audioManager 新增 startMenuBgm（data/audio/bgm/menu_loop.wav，numpy 生成 32s 无缝循环氛围乐）；菜单类页面（主页/大厅/管理页）自动播放，进入对话静默，战斗 BGM 由战斗接管
- **界面外壳重构（App.tsx）**：移除常驻 Sidebar，改为三层结构 —— 主页（全屏主菜单）/ 管理页（GameTopBar 顶栏：返回主菜单 + 管理页导航 + 音频开关，底部 StatusBar）/ 沉浸式页面（chat 与 combat 全屏无顶栏）。ChatView 保持常驻挂载以保留 SSE 流
- **沉浸式对话（ChatView）**：新增顶栏（返回大厅 / 主菜单 / 剧情·自由模式切换 / 场景面板折叠 → 全宽沉浸）；进入会话即全屏故事体验，调节世界书/阵容等需退出到大厅
- **会话大厅**：in_combat 会话卡片/详情新增「⚔ 进入战斗」直达全屏战场；头部新增「战斗演练」入口（无会话测试战场）；进入会话时自动同步对话模式
- **战斗 UI**：
  - 任务状态栏（CombatQuestBar）：战场顶部胶囊显示主任务，点击展开进行中任务列表（主线/支线/深层 + 目标），随 envRefreshKey 刷新
  - 单位模型升级（fallbackToken）：无 Spine 单位由 10px 圆点升级为职业令牌 —— 队伍色圆环 + 半透明底座 + 职业徽章，异步加载角色头像（圆形蒙版裁剪），上方名字下方 HP 条；playAttack/playHit/playDeath 对非 Spine 单位生效（冲刺/闪红抖动/渐隐下沉）
  - 出牌动画（CardFlyOverlay）：出牌时卡牌克隆沿弧线飞向目标格子（WAAPI 460ms，中途放大落点淡出），点击与拖拽两条出牌路径均触发，与手牌缩回动画叠加
### 2026-08-13 — 破甲 + 净化（卡组完成收尾）

- **破甲（ignore_def）**：Card 新增 ignore_def（物理攻击无视防御比例）；compute_damage 按 (1-ignore_def) 折算 DEF；guard_pierce「破甲斩」/ sniper_ap_round「穿甲弹」生效（无视 50% 防御）
- **净化（cleanse）**：Card 新增 cleanse；CombatUnit.clear_debuffs() 驱散减速/束缚/虚弱/沉默/燃烧/致盲（保留增益）；medic_cleanse「净化术」生效
- **战场扫描**：cmd_scan 复用 weaken（虚弱多受 25% 伤害）
- **测试**：tests/test_pierce_cleanse.py（3 用例：破甲减抗/净化保留增益/卡牌声明）
### 2026-08-13 — 状态效果收尾：闪避 + 致盲（卡组完成）

- **闪避（evade）**：CombatUnit.status 新增 evade；check_hit 中防御者闪避姿态 → EVA +3（更难被命中）；spec_evade「闪避姿态」生效
- **致盲（blind）**：check_hit 中攻击者被致盲 → HIT -3（更难命中）；spec_smoke「烟雾弹」生效
- **前端**：UnitStatusPanel 新增闪避/致盲徽章
- 至此 10 种状态效果 + 16 张描述性卡牌全部生效，卡组完成度闭环（仅剩破甲/净化/位移等可选精化）
- **测试**：tests/test_evade_blind.py（3 用例：闪避提 DC/致盲降命中/卡牌声明）
### 2026-08-13 — 状态效果补充：嘲讽（taunt）+ 侦察标记/领域展开

- **嘲讽（taunt）**：CombatUnit.status 新增 taunt；效果支持 self 标志（施加在施法者自己而非目标）；敌人 AI 目标选择（_enemy_target）优先攻击嘲讽中的玩家；defender_taunt「嘲讽打击」生效
- **侦察标记/领域展开**：vang_recon「侦察标记」、supp_zone「领域展开」复用 weaken 效果（虚弱目标多受 25% 伤害）
- **前端**：UnitStatusPanel 新增嘲讽徽章
- **测试**：tests/test_taunt.py（4 用例：无嘲讽打最近/有嘲讽打嘲讽者/嘲讽为自效果/卡牌声明）
### 2026-08-13 — 状态效果补充：沉默 + 燃烧 DoT

- **沉默（silence）**：CombatUnit.status 新增 silence；被沉默单位无法施放源石技艺（arts）卡牌（play_card 拦截 + 敌方 AI 跳过 arts 卡）；supp_nullify「源石沉默」/ supp_disrupt「干扰术」卡牌生效
- **燃烧（burn/DoT）**：新增 apply_burn(damage, duration)；每回合开始 _apply_burn 造成 burn_damage 点伤害（护盾先吸收，可致死）；caster_burn「法力灼烧」卡牌生效
- **前端**：UnitStatusPanel 新增沉默/燃烧状态徽章
- **测试**：tests/test_silence_burn.py（5 用例：沉默挡法术不挡物理/燃烧施加与递减/燃烧掉血/卡牌声明）
### 2026-08-13 — 战斗反馈打磨：闪避文字 + 伤害定位 + 状态音效

- **闪避/未命中浮动文字**：命中判定修复（feat/hit-fix）后 dodge/miss 造成 0 伤害，此前因前端 `damage > 0` 守卫被完全静默；现在 miss/dodge 显示「闪避」浮动文字 + miss 音效 + 攻击者 Spine 动作
- **伤害定位修复**：后端 damage/heal/death/status/物品治疗事件补齐 target_pos（此前前端 `target_pos || [4,4]` 永远回退到网格中心，伤害数字/粒子/受击特效错位）
- **状态效果音效**：前端处理 status 事件——护盾播 shield 音效、减速/束缚/虚弱/增幅播 ui 音效
- **CSS**：新增 .damage-number.miss（灰白描边小字「闪避」）
### 2026-08-13 — 敌人意图头顶图标（战斗 UI）

- CombatView 玩家回合（PLAYER_TURN）在敌人头顶渲染意图徽章：⚔攻击 / 💢重击 / 🌐范围攻击 / 👣移动 / 🛡坚守，复用 getCellCenter + relativeRef 与伤害数字同一套 DOM 定位，zIndex 90 叠加于 Spine 画布之上
- 与侧面板「意图 → 目标」行互补：读牌无需移眼到侧栏，战术可读性提升
### 2026-08-13 — 角色成长面板（成长可视化）

- **后端**：scene.py get_character_merged 新增返回 progress（level/xp）+ combat_stats（派生战斗数值，与 CombatUnit.from_character_metadata 同源：HP/PATK/MATK/HEAL/DEF/RES/SPD/HIT/EVA/MAX_AP）
- **前端**：CharacterDetailCard 会话活跃时拉取合并数据，新增「成长」区块（Lv + XP 进度条，阈值 level×100）与「战斗数值」区块（10 维），成长→属性→战斗数值反馈可视化
- 至此角色成长闭环可感知：战斗胜利→XP→升级属性+1→战斗数值提升→下次战斗更强
### 2026-08-13 — 卡组构建（战后 1 选 1）

- **持久化卡组**：会话 overlay 新增 combat_deck（战后选中的奖励卡），CombatSession.start 新增 bonus_cards 参数——开场按 class_required 匹配小队角色解析 owner 后注入共享牌堆（换阵容也能用）
- **战后 1 选 1**：胜利结算生成 3 张候选卡（_squad_card_pool 聚合小队各职业卡池去重，_generate_card_choices 排除已拥有）；新端点 POST /combat/card-pick 落库
- **前端**：CombatView 战利品面板新增卡牌三选一（选中后高亮并提示「已加入卡组」，下场战斗可用）；useApi.combatCardPick
- **测试**：tests/test_deck_building.py（5 用例：卡池聚合/候选去重/全拥有无候选/奖励卡注入 owner 解析/无匹配回退第一角色）
### 2026-08-13 — 命中/闪避检定修复 + 数值重平衡

- **修复 dodge bug**：compute_damage 原来只判 miss（自然 1），未达 DC 的 dodge 仍造成全额伤害，导致 HIT/EVA 属性几乎无效；现在 `not hit`（miss 或 dodge）均 0 伤害，play_card 的伤害与状态施加统一改为 `hr.hit`
- **DC 重平衡**：`10 + EVA` → `6 + EVA`。数据实测：角色 HIT≈13 vs 敌人 EVA≈5、敌人 HIT≈6 vs 角色 EVA≈10，若只修 bug 敌人命中率仅 ~37%（过于无力）；改用 DC=6 后玩家 ~95%（自然 1 仍失手）、敌人 ~56%，命中/闪避真正生效且战斗保持张力
- **命中结果透出**：damage 事件已含 hit_result（HIT/DODGE/MISS/CRIT），前端 miss/dodge 音效与结果展示复用
- **文档**：docs/design/combat/combat-design.md / docs/design/combat/combat-numerical-design.md 公式同步为 DC=6+EVA
- **测试**：tests/test_hit_fix.py（5 用例：dodge/miss 0 伤害、命中、暴击翻倍、DC=6 判定）+ 修复 test_combat_engine.py SPD 排序测试随机性（monkeypatch roll_d20）
### 2026-08-13 — 状态效果运行时（卡组完成度）

- **状态模型**：CombatUnit 新增 status（shield/slow/bind/weaken/strengthen），apply_status / tick_status（每回合递减）/ status_amount；take_damage 先扣护盾再扣 HP
- **卡牌声明**：Card 新增 effects 字段（[{type,value/duration}]）；重装·防御阵线/不破壁垒、医疗·守护之盾（护盾）、辅助·减速术（减速）、束缚术（束缚）、削弱（虚弱）、增幅过载（增幅）等卡牌现在真正生效（此前为 0 伤害/纯文案）
- **引擎**：play_card 命中后施加 effects + 虚弱/增幅 ±25% 伤害修正 + 护盾吸伤（damage 事件透出实际扣血与 shielded）；move_unit 束缚禁移 / 减速移动减半；_start_round 递减持续状态
- **前端**：CombatUnitDTO.status + UnitStatusPanel 状态徽章（护盾/减速/束缚/虚弱/增幅）
- **测试**：tests/test_status_effects.py（9 用例：护盾吸伤/状态递减/束缚禁移/减速减距/护盾卡群体生效/卡牌声明/状态透出）
### 2026-08-13 — 难度曲线：回合上限 + 撤退（fail-forward）

- **回合上限**：CombatEngine 消费 encounter.conditions.max_rounds，超过上限强制判负（battle_end winner=enemy reason=回合超时），为战斗加入时间压力
- **撤退（escape）**：CombatEngine 新增 escape()（仅 escape_enabled 时可用），玩家主动撤退结束战斗 winner=escaped，不判死亡、无奖励、剧情继续（fail-forward）
- **状态透出**：get_state 新增 max_rounds / escape_enabled；to_dict/from_dict 持久化；前端回合数显示「第 X/N 回合」+ 战斗操作栏新增「撤退」按钮
- **战后叙述**：/combat/complete 对 escaped/timeout 生成差异化结果描述与战后自动叙述（撤退/战败均为 fail-forward，不 GAME OVER）
- **测试**：tests/test_combat_difficulty.py（6 用例：回合超时/无上限/撤退/撤退禁用/条件读取/会话撤退动作）
### 2026-08-13 — 战前简报流（剧情模式战斗触发改造）

- **两段式战斗触发**：chat.py 的 _apply_combat_trigger → _apply_combat_briefing：标记提取到 [COMBAT:enc_id] 后不再自动开战，改为下发 combat_briefing 事件（含遭遇名 + 打法列表 approaches）；非流式路径在 JSON 响应中返回 combat_briefing
- **前端简报面板**：ChatPanel 收到 combat_briefing 后弹「战前打法选择」弹窗（强攻/突袭/谈判/撤退卡片），选打法后 POST /combat/start {approach_id}；谈判检定成功展示 d20 结果并可「继续」、失败展示检定后「进入战斗」、撤退直接触发战后自动叙述
- **状态**：appStore 新增 pendingBriefing；useApi 新增 onCombatBriefing 处理器 + combat_briefing 分发；types 新增 ApproachDTO / CombatBriefingDTO
- 至此「剧情模式」完整闭环：叙述 → 战前简报 → 选打法 → 投点/开战 → 结算奖励 → 战后自动叙述（对齐 combat-core-design.md C1）
### 2026-08-13 — 战前打法（Approach）+ 剧情投点（d20 展示）

- **战前打法**：新增 src/combat_approaches.py（resolve_approach 映射 enemy_scale/first_strike/player_effects/reward_mult + roll_check d20 剧情投点 + 兜底打法）；encounters 新增 approaches 字段（enc_snow_convoy/enc_final_showdown/enc_training/初遇整合运动）
- **战斗参数**：CombatSession.start() 消费 enemy_scale（敌人缩放）、first_strike（首回合共享 AP+1）、reward_mult（奖励倍率，to_dict/from_dict 持久化）；/combat/start 支持 approach_id（combat/check/avoid 三态）；/combat/complete 应用 reward_mult
- **剧情投点**：谈判/抉择类打法走 d20 检定（取小队最高属性，自然 20 必成 / 自然 1 必败），成功避免战斗、失败以 fail_combat 参数强制开战
- **修复 bug**：同名敌人 count>1 共享 unit_id 导致 add_enemy_unit 互相覆盖（遭遇战只生成 1 个该敌人）→ 现在生成唯一 unit_id（name#n），敌人数恢复设计值
- **前端**：手动开战路径（CombatView）新增打法卡片 + d20 检定结果 + 撤退提示；useApi.combatStart 支持 approach_id
- **测试**：tests/test_combat_approaches.py（13 用例：resolve/roll_check/enemy_scale/first_strike/reward_mult/唯一 unit_id）
### 2026-08-13 — 敌人意图 + SPD 行动顺序（战斗可读性）

- **敌人意图**：CombatEngine 在 ROUND_START 为每个存活敌人计算意图（attack/heavy/aoe/move/defend），含目标单位与伤害估算区间；ai_behavior=defensive 的敌人离队时坚守、aggressive 的追击（消费 enemy frontmatter 已有的 ai_behavior 字段）
- **SPD 行动顺序**：敌人阶段由 dict 顺序改为按 SPD 降序逐个行动，先手权真正生效
- **意图透出**：CombatState 新增 enemy_intents，随 state.enemy_intents 与 round_start SSE 事件下发；前端敌方面板（UnitStatusPanel）显示「意图 → 目标（伤害区间）」行
- **敌人出牌确定性**：敌人不再每回合随机抽 1 张，改为从完整卡池挑选当前最优卡（范围可达 + 可命中多人时偏好 AOE），使意图与实际行动一致（可被玩家读牌应对）
- **数据管道**：CombatUnit 新增 ai_behavior 字段（create_enemy/to_dict/from_dict/combat_data_loader 全链路）；新增 tests/test_combat_engine.py（6 用例：意图分类/防守坚守/SPD 顺序/状态透出）

### 2026-08-13 — LLM 调用工程优化（借鉴 DSH 调用纪律）

- **结构化错误**：`load_llm.py` 不再把错误伪装成模型回复（修复错误文本被当成角色台词/写入记忆的隐患），改为抛 `LLMError` 系列（connect/timeout/http/unknown）；连接错误与 429/5xx 指数退避重试，读超时不重试
- **请求指纹日志**：每次 LLM 调用记录 sha1 指纹 + token 估算，作为前缀缓存漂移的测量标尺
- **路由信任**：`get_llm()` 去掉每次 ping，改为 120s 验证缓存 TTL + 真实失败 `on_failure` 回调标记端点进入 30s 降级冷却
- **世界书注入纪律**：常驻 position-0 条目留稳定层，触发型条目一律进动态层（请求前缀缓存稳定）

### 2026-08-13 — 世界书（酒馆 Lorebook 兼容）导入与管理

- 新增 `src/world_book.py`：数据模型 + 4 源解析（酒馆 v1 导出 / v2 规格 / 角色卡内嵌 / 聊天备份 .jsonl）+ 触发匹配（主副键/selective/常驻/概率/大小写/全词）+ 注入格式化（token 预算、`{{user}}`/`{{char}}` 宏）+ 酒馆格式回灌导出
- 新增 `src/blueprints/worldbook.py`：书 CRUD、导入（文件/JSON）、条目 CRUD、全局默认书、会话绑定、resolve 查询
- 注入链路：叙述模式（`<reference>` 稳定层 + `<world_book>` 动态层）与对话模式（卡前/卡后）双通道；会话绑定存于 overlay `worldbook_id`，回落全局默认书
- 前端新增「📖 世界书」面板（`WorldBookManager.tsx`）：导入/条目编辑/会话绑定/导出；Sidebar 与 App 视图接入
- 实测兼容：导入 GitHub 社区世界书（艾尔登法环 6 本 + 明日方舟 2 本，最大 1221 条目）；修复旧版酒馆 `disable` 停用字段解析与回灌导出

### 2026-08-12 — 战斗功能工作提交（音频/物品/Spine 工具）

- 新增战斗音效资源（`data/audio/`）与前端 `audio/audioManager.ts`
- 新增物品数据（源石碎片/急救包等 11 件）、`docs/archive/combat-core-design.md` 设计文档
- 新增 `tools/download_audio.py`、`tools/import_spine.py`、`frontend/src/components/combat/spineAnimSpecs.ts`、`frontend/src/utils/baseUrl.ts`
- 战斗计时日志（叙述/提取/回忆的 LLM 调用耗时）与 combat action 类型扩展（物品使用）

### 2026-08-06 — 会话级战斗背景覆盖

- 每个会话新增背景覆盖目录 `data/memory/sessions/<mode>/<session_id>/backgrounds/`：丢入 `<bg_id>.<ext>` 替换对应背景、`default.<ext>` 替换兜底背景，只影响当前会话
- 选用优先级变为：会话覆盖图 > 全局图；背景 ID 仍按「遭遇战 `background` → 地点 `combat_bg` → default」确定
- `resolve_background()` 新增 `session_dir`/`session_id` 参数；`CombatSession.start()` 接收会话数据目录；`Session.data_dir` 属性统一会话路径
- 会话详情接口新增 `backgrounds_dir` 字段（绝对路径，方便用户直接打开目录放图）
- 新增路由 `GET /api/sessions/<id>/backgrounds/<file>` 提供会话覆盖图（含路径穿越与文件类型防护）

### 2026-08-06 — 战斗背景系统 + AI 生成工作流

- 战斗界面支持场景背景图：根容器由纯色改为 `backgroundImage` + 压暗渐变遮罩（顶/底压暗保证文字与手牌可读，中部露出画面），无图时回退原纯色
- 背景选用优先级：遭遇战 frontmatter `background` → 地点 frontmatter `combat_bg` → `default` 背景；后端在 `CombatSession.start()` 解析为 `background_url` 透传进战斗状态 DTO
- `combat_data_loader.py` 新增 `load_background` / `background_image_url` / `resolve_background`；`from_dict` 恢复时按遭遇战重新解析
- 新增资产类别 `combat_backgrounds`（data/categories.yaml），图片走现有 `/api/assets/` 路由，文档管理界面可直接编辑提示词与上传图片
- 数据约定：`data/combat/backgrounds/<bg_id>/index.md`（提示词 + 元信息）+ 图片文件；内置 `default`（含程序化生成的占位图）与 `wasteland_ruins`（待生成）两个条目
- `session_manager.start_combat()` 传入当前剧情地点；剧情模式战斗背景随场景联动
- 新增 `tools/generate_combat_backgrounds.py`：`--scaffold` 为被引用但缺失的背景建提示词草稿、`--dry-run` 导出提示词、默认调用 OpenAI 兼容 images 接口批量出图（配置 `config/image_config.json`）
- 新增战斗背景提示词文档（现归档于 `docs/archive/combat-background-prompts.md`）：构图规范（轻微俯视 + 中央开阔地面 + 远景地标 + 无人物无文字 + 偏暗重暗角）、基础提示词模板、场景配方与各平台参数
- 地点模板 TEMPLATE.md 补充 `combat_bg` 字段说明；遭遇战「初遇整合运动」指定 `background: wasteland_ruins`


### 2026-05-27 — 卡牌打出动画 + 手牌重排 + 剧情格式迁移

- 新增卡牌打出动画（`card-play-out`）：打出时卡牌放大 1.15× → 发光 → 淡出上浮 36px，时长 0.45s
- 乐观动画时序：动画立即播放，API 并行调用，保证最小 400ms 显示
- 手牌重排：React key 从 `card_id-index` 改为 `card_id-owner`，剩余卡牌 CSS transition 平滑过渡（0.3s）
- `cardPlayInProgressRef` 防重复守卫覆盖点击/拖拽/键盘三种出牌路径
- 剧情格式迁移：`combat-test` 和 `near-light` 从旧多文件格式迁移到单一 `plot.md`
- `session_overlay.py`：`_extract_section` 改用顶层边界表头模式，避免嵌套子标题提前截断
- `combat.py`：测试战斗配置读取从 `index.md` → `plot.md`
- `.gitignore` 新增 `data/characters/*/spine/`、`temp_*.png`

### 2026-05-25 — 战斗卡牌数据拆分 + UI 微调 + 配置清理

- 12 个角色的战斗卡牌定义从 `index.md` 提取到独立 `combat.md`（专属卡牌 + 通用卡牌池）
- 新增 `tools/split_combat_cards.py` 迁移脚本 + `tools/check_imports.py` imports 诊断工具
- ChatPanel / DialogueBubble 角色名字号 `text-xs` → `text-sm`
- constants.py 移除废弃的 `子职业一览` 配置，`战斗定位` depth 3→1

### 2026-05-25 — Markdown 文档渲染 + Prompt 卫生改进

- 新增 `MarkdownRenderer.tsx` 组件（react-markdown），文档预览从纯文本改为富文本渲染
- 支持标题/列表/引用/代码块/表格/图片/链接等全部标准 markdown 元素，含暗色主题样式
- style.css 新增 amber/purple/orange/blue/green/red 色系 light-mode 覆盖
- SceneManager 上下文注入：`plot_state` 加前缀"剧情结构参考（导航用，非脚本）"，`plot_log` 加前缀"已发生的事件，请勿重复"
- `_rewrite_plot_state` 移除当前节拍内的具体场景/对话原文，仅保留节拍名 + 轮次计数 + 下一节拍方向摘要
- `_PLOT_LOG_HEADER` 常量：引导 LLM 参考已有内容推进新剧情而非重复
- chat.py 修复第二条叙述路径遗漏的 `append_plot_log` + `update_beat_progress` 调用
- document_manager.py 子文档跳过逻辑简化 + 文件夹检测修复

### 2026-05-25 — 会话自有文档：剧情状态与进度日志解耦

- 节拍系统从"代码动态拼接 prompt 上下文"重构为"会话自有文档"模式
- 新增 `init_session_docs(plot_id)`：从 narrative.md 模板生成 `plot_state.md` + `plot_log.md` 写入会话目录
- `plot_state.md`：YAML frontmatter（chapter_idx/beat_idx/completed_beats）+ Markdown body（剧情概要/章节结构/节拍路线图/当前节拍详情）
- `plot_log.md`：增量轮次日志，每次叙述追加一行摘要（`append_plot_log`）
- `read_session_doc()` / `write_session_doc()` 通用会话文档读写 + 内存缓存
- SceneManager 上下文注入从 `get_beat_context()` + `get_narrative_overview()` 改为读取会话文档
- `record_narration_on_beat()` 拆分为 `append_plot_log()` + `update_beat_progress()`，日志记录与节拍推进解耦

### 2026-05-25 — 数据清理 + Prompt 上下文重排 + 默认图片系统 + 子文档扫描

- **数据清理**：全部角色/职业/势力文档的 `imports` 去除冗余 `| name` 后缀，移除废弃的 `# 可检索条目` 章节
- `index_manager.py` 写 imports 前先剥离已有后缀防重复堆积
- `near-light` 剧情 frontmatter 重构：规范字段排列，新增 sub-document imports（narrative/pacing/opening/quests/scenes/setting）
- **Prompt 上下文重排**：SceneManager 注入顺序从 "状态→开场→叙事→预加载→角色→动态" 改为 "状态→角色→玩家→动态→开场→进度→背景"
- 以 `get_narrative_overview()` 剧情概览（概要+章节结构）替代全文注入，避免具体场景描写引导 LLM 重复叙述
- **默认图片系统**：新增 `GET/PUT /api/assets/<category>/<entity>/default-image` API，读写 index.md frontmatter 中的 `default_avatar`/`default_skin`
- 前端图片面板新增预览大图、设为默认头像/立绘、子目录分组、默认标记（★）
- **子文档扫描**：`document_manager.py` 第三遍扫描收集实体目录内的非 index.md 子文档，复合 doc_id 支持
- `documents.py` 搜索扩展匹配 doc_id 和完整路径（`category/doc_id`）
- 前端依赖面板可折叠、验证改用 `valid` 替代 `exists`

### 2026-05-25 — 节拍引导简化 + 图片资产管理 + 跨分类搜索

- **节拍引导简化**：`get_beat_context()` 移除当前节拍详细内容和指令性语言，仅保留路线图定位 + 下一节拍方向提示
- SceneManager prompt 从 7 条规则简化为 6 条，改为自然推进策略（"推进到自然结束点时输出 [BEAT_COMPLETE]"）
- 上下文注入顺序优化：先注入剧情参考文档全文，再注入节拍进度定位
- **图片资产管理**：新增 `POST /api/assets/<category>/upload` 和 `DELETE /api/assets/<category>/<path>` API，含路径穿越防护
- `_list_entity_images()` 重写为递归子目录扫描（支持 avatar/skin 等深层目录），返回 `size` 字段
- 前端 DocumentManager 新增图片过滤、分类/实体级上传、hover 删除按钮、文件大小展示
- **跨分类搜索**：`searchDocuments` 移除 category 必传限制，`exclude_doc_id` 替代 `doc_id`
- 搜索和 imports 建议结果新增 `path`、`level`、`title` 字段
- 陈 index.md imports 格式迁移 + 移除废弃的"可检索条目"

### 2026-05-25 — 剧情节拍跟踪系统

- `session_overlay.py` 新增 `init_beat_state` / `get_beat_context` / `advance_beat` / `record_narration_on_beat` 等方法
- 解析 `data/plots/<id>/narrative.md` 章节/节拍结构（`_parse_narrative_beats`），注入 LLM prompt 引导剧情推进
- LLM 输出 `[BEAT_COMPLETE]` 标记时自动推进到下一节拍，跨章节自动处理
- 超过 8 轮叙述未完成当前节拍时强制自动推进
- `SceneManager.py` 新增第 6/7 条系统规则（遵循节拍指引 + 输出完成标记），注入节拍上下文和剧情参考文档
- `chat.py` 流式/气泡/请求三条路径均集成 `_handle_beat_complete` 和 `record_narration_on_beat`
- 会话创建时自动初始化节拍状态（`sessions.py`）

### 2026-05-25 — 角色立绘全屏限制 + 位置优化

- CharacterIllustration 仅在 `isFullscreen` 时渲染，避免非全屏下遮挡战斗界面
- 立绘位置左移（12rem）、上移（82px），渐变蒙版柔化

### 2026-05-25 — 战斗触发流程修复

- CombatView 接入 `combatSessionId`：LLM 触发战斗时自动加载已启动的会话（`useEffect` 监听 → `fetchState` + `connectSSE`）
- `chat.py` `_handle_combat_trigger` 不再通过私有属性 `_overlay` 获取 overlay，改为 `session.overlay`

### 2026-05-25 — LLM 触发战斗系统 + 9 角色叙事卡牌扩展

**LLM 触发战斗系统**：
- LLM 战术模式 prompt 中注入可用遭遇列表，叙述时输出 `[COMBAT:encounter_id]` 标记
- 后端检测标记 → 自动启动战斗会话 → 发送 SSE `combat_trigger` 事件
- 战斗中自动守卫（423 Locked）所有对话/叙述路由
- 战斗结束后自动写入场景事件日志（含遭遇 ID 和胜负）
- 新增 `PUT /api/sessions/<id>/combat-mode` 切换叙事/战术模式
- `Session.start_combat()` 便捷方法

**前端战斗 UX**：
- ChatPanel 标题栏：战斗中状态徽章（⚔）、战术模式复选框、手动触发按钮
- 战斗中禁用输入框和发送按钮（placeholder 变为"战斗中，无法对话..."）
- SSE `onCombatTrigger` 处理器自动切换至战斗视图
- 角色立绘定位和缩放优化（`left: 15rem; transform: scale(1.2)`）

**叙事卡牌扩展（9 角色，~30 张）**：

| 角色 | 新增卡牌 |
|------|---------|
| 德克萨斯 | POCKY时间(★)、企鹅物流·配送(★★)、狼的嗅觉(★★★)、德克萨斯之名(★★★★★★) |
| 玛恩纳·临光 | 公文包格挡(★)、上班族的直觉(★★)、老骑士的忠告(★★★)、十三年前的那一剑(★★★★★★) |
| 瑕光 | 扳手敲击(★)、装备评估(★★)、大师之作(★★★★★★) |
| 砾 | 飞刀投掷(★)、反监视训练(★★)、无胄盟的遗产(★★★★★★) |
| 银灰 | 贵族剑击(★)、谈判的艺术(★★) |
| 闪灵 | 基础包扎(★)、安眠之触(★★)、罪与赦(★★★) |
| 阿米娅 | 源石技艺·弹(★)、领导者的鼓舞(★★)、罗德岛的战术(★★★) |
| 陈 | 拔刀斩(★)、警官的直觉(★★)、赤霄·压制(★★★) |
| 霜星 | 冰霜之触(★)、冻土的记忆(★★) |

**文档更新**：
- `docs/design/combat/combat-design.md`：网格尺寸 9×8→7×7 全面修正
- `docs/design/combat/combat-numerical-design.md` v1.0→v1.1：双轨卡牌体系（叙事 vs 引擎）、动态共享 AP 上限表、Buff/Debuff 系统附录
- 已实现功能清单新增：LLM 触发战斗、叙事卡牌体系（30+张）

### 2026-05-25 — 角色卡牌扩展：临光 / 佐菲娅 / 博士

- 临光新增 3 张卡牌：盾牌格挡(★)、骑士的号令(★★)、耀骑士之名(★★★)
- 佐菲娅(新角色)新增 4 张卡牌：基础剑术(★)、社交之眼(★★)、临光的家徽(★★★★★)、家族的脊梁(★★★★★★)
- 博士新增 4 张卡牌：战术指令·前进(★)、战场评估(★★)、博士的计策(★★★)、石棺的记忆(★★★★★★)
- 6★ 卡牌均包含详细剧情影响段落，与角色弧线和世界观设定深度绑定

### 2026-05-25 — 会话级 Token 累计统计 + 聊天面板标题栏

- Session 新增 `total_usage` 累计字段，持久化到会话 JSON
- 所有 LLM 调用路径（chat/group-chat/narrate/narrate-continue/narrate-variant）接入 `accumulate_usage()`
- ChatPanel 新增标题栏：会话名、当前轮数、累计 token 消耗（入/出）
- Session 类型定义扩展 `narration_count` 和 `total_usage`

### 2026-05-25 — Phase 2 后端重构：Blueprint 架构 + Wiki 工具调用 + 结构化对话

**修改动机**：原有 `app.py` 2569 行单体路由难以维护，缺乏工具调用和结构化输出能力，registry_manager 设计过时。

**核心变更**：

| 模块 | 变更 |
|------|------|
| `src/app.py` | 从 2569 行单体重构为 115 行 Flask factory（`create_app()`），路由拆分为 13 个 Blueprint |
| `src/blueprints/` | 新增 13 个功能域 Blueprint（sessions, chat, scene, combat, documents, index, llm, wiki, environment, assets, legacy, memories, status） |
| `src/wiki_manager.py` | 新增 WikiManager：全量目录索引、imports 链 BFS 展开（depth 0/1/2）、模糊查询、目录摘要注入、LLM 摘要回填 |
| `src/session_context.py` | 新增会话文档缓存：角色变化时沿 imports 链预加载 |
| `src/CharacterAgent.py` | 新增 `wiki_query` 工具调用（最多 3 轮），会话文档上下文注入，token 用量追踪 |
| `src/SceneManager.py` | 新增结构化叙述模式（JSON 片段数组：narration/dialogue）、3 级 JSON 修复回退、`narrate_stream()` 线程+队列流式生成 |
| `src/load_llm.py` | `chat()` 返回值从 `str` 改为 `dict`（`{type, content, usage, tool_calls}`），新增工具调用解析（Ollama/OpenAI），`chat_text()` 向后兼容辅助 |
| `src/session_manager.py` | RegistryManager → WikiManager 迁移，Session 集成 WikiManager/SessionContext |
| `src/constants.py` | 新增核心章节提取规则、属性名中英文映射 |
| `src/avatar_color.py` | 从头像提取主题色，自动写入角色 frontmatter |
| `src/services/` | 新增 buff 池抽取系统和 d20 骰子系统 |
| `src/shared/` | 抽取公共辅助（SSE 响应、JSON 错误、缓存失效） |
| `src/combat_session.py` | 新增 `CombatTestSessionManager` 替代全局 dict |
| 删除文件 | `GameAgent.py`（840 行）、`registry_manager.py`（489 行）、`logging_setup.py`、`main.py`、`ui.py` — 均为死代码 |
| 前端 | 对话气泡模式（DialogueBubble/AvatarPlaceholder/NarrationText/LoadingIndicator/TokenUsage）、角色立绘组件（CharacterIllustration）、对话解析器（dialogueParser）、SSE 事件扩展（dialogue_segments/token_usage） |
| 数据模板 | v4.0→v5.0：imports 依赖链替代可检索条目章节，新增 summary 字段 |
| 资产 | 12 个角色 + 1 个新角色（佐菲娅）的 avatar/skin PNG 资产 |
| 依赖 | 移除 `readchar`，新增 `Pillow`（头像取色） |

### 2026-05-24 — 代码与数据冗余清理

- 移除未使用的 npm 依赖（react-markdown、d3-force、@types/d3-force）
- 删除前端死代码：`getCellSize`/`getCardSize`（combatConfig）、`getIndexGraph`/`getOverrides`/`listDocuments`（useApi）、`"MOVING"` UI 模式（appStore）
- 删除 CombatGrid 未使用的 props（`grid`、`validTargets`、`validMoves`）
- 删除后端死代码：`combat_data_loader.py` 中未使用的卡牌加载方法、`engine.py` 中 3 个未使用方法（`get_unit_hand`/`get_active_unit`/`to_dict`）、`index_manager.py` 中未使用的会话配置函数
- 清理死数据：删除 `data/combat/cards/` 下 55 个卡牌 markdown 文件（卡牌数据已由 `card_data.py` 硬编码管理）
- `engine.py` 中 `execute_enemy_turn` 重命名为 `_execute_enemy_turn`（仅内部调用）
- 修复 `app.py` 中 `_project_root` 变量名遮蔽导致战斗测试 500 错误
- 战斗错误提示增加 5 秒自动消失

### 2026-05-24 — 全局索引管理系统 + 等距网格优化

**修改动机**：原有索引分散在文档 frontmatter 中，缺乏全局管理视图和可视化引用树。战斗网格需要等距 3D 效果和小精灵覆盖层优化。

**修改内容（本地）**：

| 模块 | 变更 |
|------|------|
| `src/index_manager.py` | 新增全局索引配置管理器：CRUD、反向引用树构建、会话级配置、YAML 导入/导出、全量树合并（含未配置文档） |
| `frontend/src/components/IndexManager.tsx` | 新增索引管理组件：三栏布局（配置文件列表 + 文档树 \| 详情引用编辑 \| 实体选择添加）、引用树全屏视图、类别筛选、YAML 导入/导出、会话配置切换 |
| `frontend/src/components/DocumentManager.tsx` | 移除逐文档索引编辑面板，索引管理统一由 IndexManager 处理 |
| `frontend/src/components/Sidebar.tsx` | 新增"🔗 索引"导航项 |
| `frontend/src/App.tsx` | 注册索引视图路由 |
| `frontend/src/stores/appStore.ts` | `currentView` 类型扩展 `"index"` |
| `frontend/src/types/index.ts` | 新增索引配置树类型定义 |
| `frontend/src/hooks/useApi.ts` | 新增索引配置 API 方法（全量树、添加/移除文档、来源列表） |
| `src/app.py` | 新增索引配置 REST 路由 |

**修改内容（远程）**：

| 模块 | 变更 |
|------|------|
| `CombatGrid.tsx` | 等距 3D 网格渲染、小精灵覆盖层叠加 |
| `GridCell.tsx` | 单元格交互优化、反选支持 |
| `CombatView.tsx` | 交互逻辑重构、状态管理优化 |
| `AttackArrow.tsx` | 攻击箭头简化重构 |
| `CombatParticles.tsx` | 粒子特效优化 |
| `gridUtils.ts` | 新增网格工具模块 |

### 2026-05-23 — 角色悬浮提示 + 会话覆盖战斗集成

- 新增 `CombatUnitTooltip` 组件（Portal 浮层，展示属性/数值）
- 战斗启动时应用会话 overrides（角色编辑后的属性流入战斗）
- 新增 `POST /combat/complete` 战斗结算写回端点
- 新增 DeckViewer 卡组查看组件（按角色分组，手牌/抽牌堆/弃牌堆/消耗堆）

### 2026-05-23 — 战斗 UI 合并与优化

- 拖拽出牌支持，3D 透视网格，CSS 粒子特效
- GridCell 按钮嵌套修复（ChibiSprite 改为 pointer-events-none）
- 选中/活跃单位视觉区分（分别使用不同边框样式）
- 卡牌攻击范围高亮



