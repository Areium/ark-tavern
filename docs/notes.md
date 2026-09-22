# 项目工程笔记（notes）

只记**本项目内、可复现、下次会再撞上**的细节：踩过的坑、口径约定、环境差异、已知未修项。
通用的工程经验、跨项目的方法论**不**放这里；需要长期影响 AI 行为的规则走 `AGENTS.md`
或 `.agents/skills/`，设计目标态走对应的 `docs/*.md` 设计文档。

新增条目请写明：现象 → 根因 → 现状口径 → 证据（文件/用例），并在条目首行标注日期与提交号。

---

## 会话

### 新建向导的「入队角色」不是只由玩家点击决定（2026-09-19，`d91f22a`）

- **现象**：剧情模式下选「长夜临光」后只点了一个角色，入队却有 4～5 名。
- **根因**：点选剧情磁贴时会用该剧情 frontmatter 的 `initial_characters` **覆盖** roster
  （`CreateSessionWizard.tsx` 的 `pickPlot`）。`data/worldbooks/content/plots/near-light/index.md` 的开场角色是
  临光、瑕光、砾、阿米娅、玛恩纳·临光 共 5 名，点剧情即预勾 5 个；预勾磁贴与玩家自选原先
  完全同款，点一下已预勾的角色其实是在**取消**（5 − 1 = 4）。
- **现状口径**：
  - 预选行为**保留**，但界面显式化：预选角色标「剧情预选」（区别于「已入队」）、顶部说明
    「它们已处于入队状态」并提供「清空阵容」、剧情卡片标注「开场角色 N 名 · 选中后自动预选入队」。
  - 预选只收「非玩家身份」且角色目录存在的角色。
  - 服务端**严格按 `roster_character_ids` 入队**（`blueprints/sessions.py`）：前端总会带该字段，
    因此 `_load_plot_opening(load_characters=False)` 不会再用开场角色补齐 —— **显式空阵容 = 0 角色**，
    剧情开场角色不会兜底（向导里已就这条给出提示）。
- **证据**：`.tmp/repro_story_roster.py` 风格的端到端复现：`POST /api/sessions`
  （`plot_id=near_light`、`roster_character_ids=["临光"]`）→ `characters == ["临光"]`。
- **已知未修（2026-09-20，基线 `a049ae1` 已复现）**：`session_manager._restore_scene()` 在 story 会话
  持久化场景角色为空时，会回退加载**整份** `initial_characters`。显式空阵容创建后重载确实触发，
  不再只是未验证隐患；应区分字段缺失与显式空数组。见 `tests/test_greybridge_acceptance.py`
  的 `test_explicit_empty_roster_survives_session_reload` 及剧情验收报告 QA-05。

### 剧情完整体验的已知缺口（2026-09-20，基线 `a049ae1`）

- **现象**：普通回归通过不等于剧情通关。新候选《灰桥回声》真实模型 18 轮完成 3/12 节拍，
  五任务仍 hidden；变体选择同步返回 500，开场上下文泄露后续章节，树回滚丢分支目的地。
- **根因**：开场章节边界正则、前后端变体参数合同、快照字段保存各有明确缺陷；自动任务与
  剧情终态尚缺状态提交链路。另有非法任务 ID 被接受、平铺 `急救包.md` 列出却无法读入的问题。
- **现状口径**：本轮只交付设计、复现测试和修复方案；未修改运行时，未注册候选剧情。
  `xfail` 表示缺陷复现，不能计入通过。战斗模拟 120 次通过结构/执行检查，但普通战压力偏低。
- **证据**：[完整功能矩阵与修复顺序](qa/2026-09-20-story-audit.md)、
  [剧情设计](scenarios/greybridge-echoes/README.md)、`tests/test_greybridge_acceptance.py`。
- **后续修正（2026-09-22，`feat/worldbook-data-layout`）**：DocumentManager 已补平铺 Markdown
  的读取回退，QA-07（`急救包.md` 可列出但详情 404）随数据布局迁移修复；本节列出的其余剧情缺陷
  未因该修复自动关闭，仍以各自验收用例为准。

## 测试

### 世界书条目工作台持久化口径（2026-09-22，`feat/worldbook-entry-refresh`）

- **顺序**：旧书没有 `entry_order` 时继续使用既有注入排序；首次拖动后写入完整 UID 排列，新增、摘录、
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

### 本机跑测试的等价命令（2026-09-19）

本机（Windows + conda python）**没有可用的 bash**：`bash scripts/run_tests.sh` 里的 `bash` 实际落到
WSL，而本机未安装 WSL。等价做法：

```powershell
python -m pytest tests/ perf_tests/test_combat_runtime_v1.py perf_tests/test_combat_data_v1.py `
  perf_tests/test_settlement_v1.py perf_tests/test_card_json_roundtrip.py perf_tests/test_cv_budget.py
$env:PYTHONPATH='<repo>\src'; python tests\legacy\<each>.py   # tests/legacy 下逐个跑，需 src 在 PYTHONPATH
```

### CLI 夹具必须自己钉死 UTF-8（2026-09-19，`f6ea4e7`）

- **现象**：`tests/test_combat_growth_balance.py` 里 4 个用例在 `PYTHONIOENCODING=utf-8` 的 shell 下
  报 `_readerthread UnicodeDecodeError: 'gbk' codec`，看起来像工具坏了。
- **根因**：工具 CLI 输出中文；子进程按环境变量写 UTF-8，而父进程 `subprocess.run(text=True)` 按 locale
  （Windows 是 GBK）解码 → 读线程抛错。夹具受**外部环境变量**影响，不在工具本身。
- **现状口径**：`_run()` 统一 `encoding="utf-8", errors="replace"` 并给子进程注入 `PYTHONIOENCODING=utf-8`；
  `balance_audit` 也走同一个 `_run()`，不再自己拼 `subprocess.run`。
- 新增 CLI 用例请复用 `_run()`，不要另写 `text=True` 而不指定 `encoding`。

### 预装书用例依赖 gitignored 的本地数据（2026-09-19，`f6ea4e7`）

`data/worldbooks/` 被 `.gitignore` 忽略，`tests/test_worldbook_*.py` 的"预装书"用例读的是**本地实际内容**，
因此写死数字或写死 v2/v3 状态都会随本地数据漂移而假失败：

- 工作量估算：`estimate_workload` 必须按 `run_build` 的同一份输入算 —— 只把**出现在候选对里的 uid**
  放进 `analysis_metadata`。实测预装书「全量 262 条 → 49 批」对「受审 252 条 → 48 批」，
  混用会让 `card_calls` 断言假失败。
- v3 状态断言：普通保存应断言「保存前后 v3 状态一致」（`after.v3_enabled == original.v3_enabled`），
  不要硬编码 `not after.v3_enabled` —— 预装书早已是 v3。

### 无浏览器 SSR 断言脚本里，zustand 只读得到初始快照（2026-09-22）

`scripts/test_*_ui.cjs`（`ts.transpileModule` 加载 `.tsx` + `react-dom/server`）是本地主力断言手段，
但它有一条硬边界：**不能用 store 状态去驱动 SSR 输出**。

- **现象**：`useAppStore.setState({ characterTab: "cards" })` 之后渲染，`useAppStore.getState()`
  返回 `cards`，而 `renderToStaticMarkup` 出来的 markup 仍是 `characters` 那一屏
  （探针输出：`after setState: cards` / `renders cards manager? false | renders role column? true`）。
  即同一进程里出现两个真相，按状态对比 markup 的断言会恒等或恒不等，是假阳性。
- **根因**（zustand 4.5.7，已读 `frontend/node_modules/zustand/` 源码确认）：`useStore` 的服务端快照是
  `api.getServerState || api.getInitialState`（`esm/index.js:20`），而 `getInitialState` 永远返回
  **store 创建时**那一份 —— `setState` 重新赋值的是 `state`，从不动 `initialState`
  （`esm/vanilla.js:8,12-13,26-28`）。React 18 服务端渲染取 `getServerSnapshot`，于是走的就是初始快照。
- **不能从外面 patch**：`create()` 里是 `Object.assign(useBoundStore, api)`（`esm/index.js:35`）单向拷贝，
  而 `useStore` 闭包持有的是内部 `api` 对象。所以给绑定 store 挂 `useAppStore.getServerState = ...`
  **不会被读到**。真要接管，只能用 `createStore` 自建 store 再配导入出的 `useStore`（`esm/index.js:48`）
  渲染——但依赖未文档化的 `getServerState` 约定，仅适合断言脚本，不要用在产品代码里。
- **什么断言仍然有效**（判据不是「SSR 能不能用」，而是「这一步是否依赖 store 的当前值」）：

  | 断言写法 | 可行 | 说明 |
  | --- | --- | --- |
  | store 迁移：`getState()` + action | ✅ | 不经过 React 服务端快照 |
  | 源码接线：读 `.tsx` 文本 `includes` | ✅ | 纯文本 |
  | 组件导出的常量/配置（如 `WORLDBOOK_PANEL_TABS`） | ✅ | 不读 store |
  | SSR markup 中**不随 store 变化**的部分（页签标签齐全、旧文案已消失、两模块 markup 不同） | ✅ | 这些量本来就不依赖被切的那个字段 |
  | SSR markup 中**随 store 变化**的部分（切到卡牌应渲染 CardManager） | ❌ | 就是上面那条现象 |
  | 真按状态渲染 | ✅ | 上 playwright；本机未装，`scripts/test_worldbook_review_ui.cjs` 因此跑不了 |

  另一条路子（另一会话独立踩到后采用）：通过模块缓存注入只读 store 替身。
- **现状**：`scripts/test_role_worldbook_nav_ui.cjs:76-77` 已经把这条结论写在脚本注释里并据此改写
  （改成断言 store 迁移 + 组件接线）。本节是把它提升为仓库级口径，避免下次再花一轮去踩。
- **证据**：探针输出见 `event:66710`；另一会话独立复现见 `event:60798`；源码读于本机已安装的
  `frontend/node_modules/zustand@4.5.7`。

## 世界书前端

### 条目分层是三层，不是两层：系统层不计 token、不进 Prompt 预览（2026-09-22，`feat/worldbook-frontend-polish`）

- **现象**：剧情节点图条目（`plot_graph_*`）在「条目」页签上被打成「动态层」，并被计入
  「约 N token」；「Prompt 预览」的 `dropped[]` 里还会给它报一个 `keyword_miss`
  （「关键词未命中」），读起来像是「去补个触发词就好了」。
- **根因**：分层口径只有两种取值 —— `position == 0 && always_active ? 稳定层 : 动态层`。
  节点图条目按设计是「空触发键 + 非常驻」，只服务画布与系统判定、永不注入，落进
  「其余都是动态层」这个兜底分支纯属口径缺失；而展示 token 又是 `self.entries` 全量求和。
- **现状口径**（唯一真源 `src/world_book.py`，前端镜像在 `frontend/src/utils/worldbookLayer.ts`）：
  - 第三层叫**系统层**，判定 `is_system_entry()`：`raw.extensions.arknights_tavern.entry_type ∈
    {plot_graph, lore_bindings}`，或正文命中围栏块（与 `plot_graphs.is_graph_entry` /
    `node_lore_scope.is_lore_bindings_entry` 同构）。**判定顺序必须先系统层再位置分层** ——
    系统层条目同样满足「非常驻」，先按位置分层就会退回成动态层。
  - 战斗节点条目（`combat_node`）**不在**系统层：它有关键词、会随剧情提及注入。
  - 统计口径 `book_entry_stats()`：`injectable` = **启用的非系统条目**，`tokens` 只累计这一批。
    `WorldBook.estimated_tokens()`、接口摘要 / 详情的 `estimated_tokens` 与
    `injectable_entry_count` / `disabled_entry_count` / `system_entry_count` 全部走它。
    界面上勾掉一条，条目数与 token 立刻跟着掉（前端 `bookEntryStats(detail.entries)` 同步算，
    书架列表在选中书上用同一份实时值，其余书用服务端摘要的同口径字段）。
  - Prompt 预览：系统层条目既不进 `order`（本来就不注入），也**不进 `dropped`**；
    `preview_all_entries` 自己按 `is_system_entry` 排除，调用方不必再挑 UID。
  - 「显式全量兼容」`_full_scope_entries()` / `full_scope_uids()` 也排除系统层：
    全量放宽的是候选，不是把永不注入的条目算进 `full_entry_count` / `full_estimated_tokens`。
  - 「会话条目」页签（`IndexManager`）同样不列系统层条目 —— 给它一个会话开关拨了也不会有
    任何变化，只会误导；改为一行说明「另有 N 条系统层条目永不注入」，分母也换成会注入的条目。
  - **展示顺序**：`sortEntriesByLayer()` 恒定按层分组（稳定 → 动态 → 系统），
    **与这本书有没有显式 `entry_order` 无关**。系统层条目一律沉到最底端，并在第一条前插一行
    「系统层 · 不参与注入与排序」分界。它们也**不参与拖动排序**：`isSortableEntry()` 为假时
    不给 `draggable`，手柄位置换成锁标记（`.wber-drag.is-locked`），拖到它上面会被拒绝并提示。
    这是**展示层**排序，持久化的 `entry_order`（注入顺序）不受影响 —— 拖拽仍按原有整排列语义
    写回，系统层条目留在数组末尾即可（后端要求 `entry_order` 是完整排列）。
  - **不在书架项与 hero 统计上出系统层计数标识**（曾短暂加过「系统 N」/「N 条系统层」，已按要求去掉）：
    同一件事已经有三个更贴上下文的出口 —— 条目行的分层标签、列表底部的分界行、Prompt 预览与会话
    条目页的说明。hero 只留「会注入的条目 / 共 N」与「约 X token」（外加「N 条已停用」，
    它解释的是勾选结果，属于同一处交互的反馈）。条数本身在 `bookEntryStats` /
    `system_entry_count` 里照常可查，只是不占版面。回归守卫见
    `scripts/test_worldbook_layer_ui.cjs` 第 8 组（对源码做「不许再出现」断言）。
- **别让两张表漂移**：`SYSTEM_ENTRY_TYPES` / `SYSTEM_ENTRY_FENCES` 在 Python 与 TS 各有一份。
  `tests/test_worldbook_system_layer.py` 比对承载模块自己的 `_ENTRY_TYPE` / `WORLD_BOOK_FENCE`；
  `scripts/test_worldbook_layer_ui.cjs` 直接读 `src/world_book.py` 比对两张表 —— 任一侧新增类型
  而另一侧没跟上都会立刻失败。
- **证据**：`tests/test_worldbook_system_layer.py`（判定 / 统计 / 单轮与全书预览 / 全量口径）、
  `scripts/test_worldbook_layer_ui.cjs`（三层判定 / 展示顺序与不可拖 / 统计口径 / 两张常量表 /
  封面 / 两处页面说明）。本机数据实测：`data/worldbooks/` 下
  `combat-test` / `fengxue-guojing` / `near-light` 各含 1 条 `plot_graph_*`，`arknights` 含 2 条停用条目，
  这些现在都不再计入展示 token。

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
- **现状口径**：13 个分发内容目录统一位于 `data/worldbooks/content/`；预装包位于
  `data/worldbooks/packs/`；`categories.yaml` 留在 `data/` 根目录；用户书 JSON、
  `settings.json`、备份和会话数据保持原位。环境内容只有 `Location/` 与 `weather/`，
  时段预设仍是代码内置列表，不存在 `environment/time/` 目录。
- **迁移限制**：`scripts/migrate_data_layout.py` 默认仅预览，`--apply` 在全部目标无内容冲突时才移动；
  可中断重跑，但不会覆盖不同内容，也不会重新生成预装包或刷新已安装书。运行迁移前应停止应用，
  冲突需人工确认后再重跑。
- **证据**：`tests/test_data_layout.py` 覆盖 Document/Wiki 与内容 API、素材 URL、临时候选剧情、
  战斗节点提示刷新、背景引用和生成器临时输出；迁移行为由 `tests/test_data_layout_migration.py` 覆盖。

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
