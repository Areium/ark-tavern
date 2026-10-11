# 世界书管理模块重构方案

本页保存 2026-09-21 工作台重构的取舍与技术计划。当前维护者应先读下表，只有追溯删改范围、原接口目标或阶段验收时才继续读历史计划；不把旧菜单、内部兼容字段与验收任务重新接回产品。

> 创建与原最后更新：2026-09-21。原行号基准：`main@6bd6ef4`。
> 最近核对：2026-10-11（主线 `7344cea` 的页签、预览、范围解析与会话依赖源码静态核对；未运行测试、测速或浏览器验收）。
> 状态：历史提案，部分目标落地，部分已被后续需求替换。下文的“现状”、文件规模、行号和阶段命令均指实施前基线，不是当前清单。

## 当前入口与历史目标的对应

| 主题 | 当前状态与查询入口 |
|---|---|
| A-1 工作台与导航 | 内容中心已删除；资产与卡牌归入角色页面，节点图归入世界书。世界书当前为条目、Prompt 预览、节点图、会话条目。资料库仅条目。全局依赖 `LoadTab` 未挂载，不存在可用的“分类与载入”页签。 |
| A-2 Prompt 预览 | API 保留显式参数的单轮模拟路径；当前 UI 固定 `all_entries=true`，展示整本书启用条目，跳过范围、节点、关键词、概率与预算，不代表下一轮请求。 |
| A-3 依赖逐层展开 | 条目页保留依赖阅读；早期“行内加关系 → 页头统一保存”的编辑入口已被后续条目页需求替换。会话局部依赖微调仍可用。 |
| A-4 顺序轨道节点视图 | 早期 `nodes` 页签已删除；当前 `graph` 是剧情节点编辑器，不能当作这里设计的注入顺序轨道。虚拟化、400 节点阈值与首屏指标保留为原设计假设。 |
| D-1～D-3 图谱与旧入口删减 | 原图谱画布、内容中心世界书图谱/索引入口与专属交互已调整；具体旧符号和行号留在 §2 便于追溯。 |
| D-4 AI 自动构建 | 全局构建与会话 AI 微调已移除；人工依赖功能保留。旧 AI 证据透传、内部 v2、有限深度与全量兼容计划后来也被当前内部 schema v3 契约取代。 |

当前依据：[工作台](../../frontend/src/components/WorldBookManager.tsx)、[Prompt 页](../../frontend/src/components/worldbook/tabs/PromptPreviewTab.tsx)、[范围与快照](../../src/world_book.py)、[会话人工依赖](../../frontend/src/components/session/SessionWorldbookDependencies.tsx)。当前规则见[按需载入](../design/worldbook/worldbook-on-demand.md)与[资料库](../design/worldbook/worldbook-library.md)，后续需求和验收见[条目页重做](worldbook-entry-refresh.md)。

# 第一部分 · 原设计取舍

## 重构要解决的问题

原页面把条目、依赖图谱与索引拆在不同一级入口。方案选择以世界书工作台承载这些任务，用可展开列表表达依赖，用预览区区分候选范围与注入结果，减少维护另一套前端遍历语义的成本。

| 编号 | 原取舍 | 理由与边界 |
|---|---|---|
| D-1 | 删除可拖动的圆形关系画布 | 平移、缩放、框选与连线增加操作成本；旧画布有 400 节点显示上限，且使用不同于真实 v3 的遍历。该上限是旧实现条件，不是新性能实测。 |
| D-2 | 内容中心的图谱取消、索引移入世界书 | 合并查找入口；本家索引仍管理内置语料实体、文档完整性和会话白名单，不等同世界书条目。 |
| D-3 | 删除画布专属交互与固定导入/导入源词表 | 列表统一用起点与展开规则表达；保留分类、依赖数据、草稿与会话人工微调，不误删同名战斗节点图。 |
| D-4 | 删除 AI 自动构建及会话 AI 微调 | 两者共用构建、缓存、证据校验与任务链；只留会话 AI 仍需保留大部分内核与模型成本。人工依赖不在删除范围内。 |
| A-1 | 工作台统一页签与跳转状态 | 资料库仍收敛到条目页，切书不能出现空白；五页签是当时目标，当前入口见上表。 |
| A-2 | 同一路径生成可复现的单轮预览 | 候选不等于注入；原目标区分剧情/自由宿主，固定 seed，复用匹配与预算，返回未插入原因。 |
| A-3 | 条目依赖逐层展开 | 重复引用与环必须有限展开，related 只供浏览，不应冒充必需依赖。 |
| A-4 | 只读顺序轨道替代关系网络 | 原静态序号表示“若均命中时”的顺序，不表示本轮全部注入；灰节点只表达候选去重，可跳到主节点，仍可查看下游。 |

## 原用户路径与不变约束

原设计把作者路径分为三步：配置起点和依赖决定候选，在条目树或轨道查引用，再以单轮预览核对输入、触发、顺序和预算。索引留在世界书，内容中心只管理资产、卡牌与战斗节点图。这个路径是历史目标，当前全局配置入口与 UI 预览的限制见页首，不能照此完成全部操作。

方案要求保留依赖数据与分类、候选解析、原子草稿保存及冲突保留、会话局部覆盖/屏蔽/恢复；不改战斗节点图。常驻 position-0 条目进入稳定层，触发条目进入动态层。后续条目页把元信息与正文改为自动保存，其约定归属[条目页方案](worldbook-entry-refresh.md)。

历史技术部分继续沿用 D-1～D-4、A-1～A-4 编号，§0 可定位详细删改项。重复的用户场景已合并到本节；独有接口、排序、灰节点、失败语义与阶段门禁保留在后文。

---

# 第二部分 · 具体实现

## 0. 对齐索引

| 编号 | 含义 | 详细章节 |
|---|---|---|
| D-1 | 删除图谱画布技术栈 | §2.1 |
| D-2 | 删除内容中心两个二级菜单 | §2.2 |
| D-3 | 删除图谱专属交互与旧词表 | §2.3 |
| D-4 | 删除 AI 自动构建依赖（含会话侧 AI 微调） | §2.4 |
| A-1 | 世界书升级为带页签工作台 | §3.1 |
| A-2 | Prompt 预览 | §3.2 |
| A-3 | 条目依赖逐层展开 | §3.3 |
| A-4 | 世界书节点视图 | §3.4 |
| — | 数据结构与接口变更汇总 | §4 |
| — | 测试与脚本同步 | §5 |
| — | 文档同步 | §6 |
| — | 实施顺序与验收 | §7 |
| — | 假设与风险 | §8 |

---

## 1. 现状事实（实施前必须知道的前提）

本节只记录 `main@6bd6ef4` 的实施前状态。文件行号、大小、旧 ContentHubTab 与有限深度遍历不能用于定位 2026-10-11 源码；当前入口见页首状态表。

### 1.1 现有导航与状态

| 位置 | 现状 |
|---|---|
| `frontend/src/components/HomeMenu.tsx:30-37` | 一级菜单 6 项：`sessions` / `characters` / `worldbook` / `content` / `docs` / `settings` |
| `HomeMenu.tsx:35` | 「内容中心」desc = 「世界书图谱 · 索引 · 资产 · 卡牌 · 节点图」 |
| `frontend/src/components/GameTopBar.tsx:15` | 顶栏同样有 `content` 项 |
| `frontend/src/stores/appStore.ts:21` | `ViewName = "home" \| "chat" \| "sessions" \| "settings" \| "combat" \| "worldbook" \| "content" \| "docs" \| "characters"` |
| `appStore.ts:24` | `ContentHubTab = "index" \| "images" \| "cards" \| "combat" \| "worldbook-deps"` |
| `appStore.ts:38-39, 158-159` | `contentHubTab` / `setContentHubTab`，默认值 `"index"` |
| `appStore.ts:42-47` | `worldbookJumpId`（检索命中跳书）、`worldbookScopeJumpId`（跳依赖图谱）、`worldbookEntryJump`（跳条目） |
| `frontend/src/components/ContentHub.tsx:27-33` | 5 个 Tab：`worldbook-deps`(世界书图谱) / `index`(索引) / `images`(资产) / `cards`(卡牌) / `combat`(节点图) |
| `ContentHub.tsx:25, 155-156` | 懒加载 `WorldBookDependencyPage` |
| `ContentHub.tsx:44-49, 76-79` | 世界书检索命中 → 设 `worldbookJumpId` → `setCurrentView("worldbook")` |

**「索引」的真实职责**（重要，决定它的归属）：`frontend/src/components/IndexManager.tsx` 管的是**内置语料实体索引**与**文档依赖完整性**、以及**会话级索引白名单**——对应 `useApi.ts:314-324, 377-386` 的 `/api/index/overview`、`/api/index/export|import|verify`、`/api/sessions/<id>/index-config`、`/api/sessions/<id>/index/verify`。它与"世界书条目"不是同一层对象；同属本家语料（`data/packs/arknights.json` 由 `scripts/generate_builtin_worldbook.py` 从同一批语料生成）。

### 1.2 注入管线（A-2 必须复刻的真相）

| 环节 | 位置与事实 |
|---|---|
| 拼装格式 | `src/world_book.py:1385-1423` `format_injection()`：每条渲染为 `### {name}\n{正文}`，块间 `\n\n`，整段加 `【世界书】\n` 头 |
| 宏替换 | `src/world_book.py:1403` `_substitute_macros(content, identity, active_char)`，处理 `{{user}}` / `{{char}}` |
| 排序键 | `src/world_book.py:1380` `sort(key=(position, -group_weight, depth, uid))`；`position: 0=卡前 / 1=卡后`（`world_book.py:158`） |
| 预算 | `src/world_book.py:1407-1411`，`budget_tokens > 0` 时跳过当前超限条目并继续扫描，后续较小条目仍可加入，但至少保留首条 |
| 分层纪律 | `src/world_book.py:1392-1394, 1412-1415`：稳定层只收 `position=0 且 always_active`；**触发型条目即使是 position=0 也进动态层** |
| 触发匹配 | `src/world_book.py:1323-1381` `collect_matches(recent_text, current_input, rng, eligible_uids)`；`eligible_uids_for()` 先裁剪候选（`:1324, 1345`）；概率抽签在 `:1352-1355` |
| 候选解析 | `src/worldbook_scope.py:399-464` `resolve_v3_scope` 的 BFS：`best` 表按**最大剩余深度**去重（`:401-404`），`remaining==0` 不再遍历（`:406-407`），`used_edges` 记录实际遍历过的边（`:409`），`display_tree` 由 `(depth, uid)` 排序稳定生成（`:445-464`），交叉引用 = `used_edges - tree_edges`（`:466-468`），闭包超限报 `closure_too_large`（`:414-428`） |

**四个插入宿主（A-2 必须区分）**：

| 模式 | 稳定层位置 | 动态层位置 |
|---|---|---|
| 剧情（`src/SceneManager.py`） | `<reference>` 块内，在 `<worldview>` 之后、玩家身份档案之前（`:1026-1048`） | `<world_book>` 块，在 `<scene_events>` 之后、收尾 MUST 指令之前（`:1091-1097`） |
| 自由（`src/CharacterAgent.py`） | system_parts 中紧跟角色卡之后、`<worldview>` 之前（`:186-193`） | system_parts 中 `memory_context` 之前（`:243-248`） |
| 节点绑定 | `src/node_lore_scope.py:38-39, 231` 的 `inject_position` 可覆盖 `position` / `depth` / `group_weight`，在 `src/world_book.py:1358-1377` 生效；常驻条目禁止绑定，绑定后被强制钳到动态层（`world_book.py:1373-1375`） | 同左 |

### 1.3 现有前端文件规模（供工作量判断）

| 文件 | 规模 | 去向 |
|---|---|---|
| `frontend/src/components/WorldBookManager.tsx` | 约 1650 行 | 改造为工作台 + `条目` 页签 |
| `frontend/src/components/WorldBookDependencyPage.tsx` | 143 行 | 迁入工作台，去掉 `advanced` 视图 |
| `frontend/src/components/WorldBookScopeManager.tsx` | 约 1000 行 | 大幅缩减，去画布视图 |
| `frontend/src/components/WorldBookGraphCanvas.tsx` | 约 520 行 | **整文件删除** |
| `frontend/src/utils/worldbookGraph.ts` | 约 260 行 | **整文件删除** |
| `frontend/src/utils/worldbookDependency.ts` | 453 行 | 大幅删减 |
| `frontend/src/utils/worldbookBatch.ts` | 104 行 | 删框选、改起点批量 |
| `frontend/src/styles/worldbook-graph.css` | 约 560 行 | 删画布区段，保留基础类 |
| `frontend/src/components/IndexManager.tsx` | 约 1300 行 | 平移到工作台 `本家索引` 页签，本身不改 |
| `scripts/test_worldbook_scope_ui.cjs` | 252+ 行 | 需重写约 150 行断言 |

---

## 2. 删减详解

### 2.1 D-1 删除图谱画布技术栈

**删除整文件**

- `frontend/src/components/WorldBookGraphCanvas.tsx`（约 520 行）：SVG 画布、圆形节点渲染、拖动/平移/缩放、框选、连线路由、缩略图、图例、跟随拖动、键盘导航、`localStorage` 视图偏好、`readFollowPref` / `writeFollowPref` / `followSetFor` / `boundsFor`。
- `frontend/src/utils/worldbookGraph.ts`（约 260 行）：`WorldBookGraphView`（`:9`）、`WorldBookGraphNode/Edge/Data`（`:12-58`）、`categoryNodeId` / `entryNodeId` / `dependencyEdgeId`（`:58-60`）、`buildWorldBookGraph`（`:66`，含 400 节点显示上限与 `hiddenCount`）、`layoutWorldBookGraph`（`:185`）、`worldBookEdgeGeometry`（`:247`）、`spreadWorldBookGraph`（`:262`）。

**删除视图分支**

- `WorldBookScopeManager.tsx` 的 `view: "dependencies"`（力导向关系网络）与 `view: "tree"`（分层树画布）：含 `ADVANCED_VIEWS`、`WorldBookGraphCanvas` 渲染点（`:743`）、树工具条（`:625-636`：展开层级 / 全部展开 / 重置折叠 / 未覆盖条目）、`<title>` 文案（`:566-569`）。
- `taxonomy` 视图退化为**分类树列表 + 条目归属表**，去掉圆形分类/条目节点与分类连线。

**删除 CSS 区段**：`frontend/src/styles/worldbook-graph.css` 中的 `.wbg-svg` / `.wbg-node*` / `.wbg-edge*` / `.wbg-minimap` / `.wbg-legend` / `.wbg-tree-*` / `.wbg-link-*` / `.wbg-tray*` 等画布专属类。**保留** `--wbg-*` 色板 token 与 `.wbg-page` / `.wbg-view-tabs` / `.wbg-button` / `.wbg-field` / `.wbg-notice` / `.wbg-search` / `.wbg-workbench` 等基础类（`WorldBookEntryWorkbench.tsx`、`WorldBookConfigOverview.tsx`、`DependencyBuildPanel.tsx` 仍在用）。

**理由**（写进 commit message 与 §6 文档）

1. 画布唯一不可替代的价值是"展示全局节点内容"，而 A-4 的节点视图能用更低的认知成本做到。
2. 大书上必然退化——`worldbookGraph.ts` 自带 400 节点上限就是这条路走到尽头的证据。
3. 画布展示的是**前端自算的 v2 遍历**（`utils/worldbookDependency.ts` 与后端 v2 `expand_sources` 同构），而 v3 真实语义在 `resolve_v3_scope`。保留画布＝长期维护第二套语义。

### 2.2 D-2 删除内容中心两个二级菜单

**目标导航**

```
会话大厅 · 角色管理 · 世界书 · 内容中心 · 文档 · 设置
                            │
                            ├─ 条目
                            ├─ 分类与载入
                            ├─ Prompt 预览
                            ├─ 节点视图
                            └─ 本家索引

                            └─ 内容中心：资产 · 卡牌 · 节点图
```

**清理清单**

| 位置 | 动作 |
|---|---|
| `frontend/src/stores/appStore.ts:24` | `ContentHubTab` 删 `"worldbook-deps"` 与 `"index"` |
| `appStore.ts:158` | `contentHubTab` 默认值 `"index"` → `"images"` |
| `appStore.ts:44-45` | `worldbookScopeJumpId` / `setWorldbookScopeJumpId` 语义改为「跳到工作台 `分类与载入` 页签」 |
| `appStore.ts` 新增 | `worldbookTab: "entries" \| "load" \| "prompt" \| "nodes" \| "index"` + `setWorldbookTab`，作为所有跨组件跳转的唯一入口 |
| `frontend/src/components/ContentHub.tsx:25` | 删 `WorldBookDependencyPage` 懒加载 |
| `ContentHub.tsx:28-29` | 删前两个 Tab 定义 |
| `ContentHub.tsx:155-156` | 删两个渲染分支 |
| `ContentHub.tsx:44-49, 76-79` | `worldbookJumpId` 跳转保留，改为设 `worldbookTab` |
| `frontend/src/components/WorldBookScopeManager.tsx:513` | `setContentHubTab("worldbook-deps") + setCurrentView("content")` → `setWorldbookTab("load") + setCurrentView("worldbook")` |
| `WorldBookScopeManager.tsx:613` | 「打开内容中心 · 依赖图谱 →」按钮文案与目标同改 |
| `frontend/src/components/session/SessionManagerView.tsx:798` | 改为跳工作台 `分类与载入` |
| `SessionManagerView.tsx:821` | `setContentHubTab("index")` → 跳工作台 `本家索引` |
| `frontend/src/components/combat/CombatView.tsx:1272` | 保留（目标 Tab 仍在内容中心） |
| `frontend/src/components/CharacterManager.tsx:246` | 保留（目标 Tab 仍在内容中心） |
| `frontend/src/components/HomeMenu.tsx:35` | 内容中心 desc 去「世界书图谱 · 索引」；建议「世界书」desc 改为「条目 · 载入 · Prompt 预览 · 节点视图 · 本家索引」 |
| `frontend/src/components/GameTopBar.tsx:15` | 一级项不变，确认无「世界书图谱」字样 |

**「索引」→「本家索引」的结论**：搬到工作台第 5 个页签并改名。理由：它管的是内置语料实体索引与会话白名单（`useApi.ts:314-324, 377-386`），与会话候选范围是同一件事的两面，且与本家世界书共用同一份语料。页签副标题必须写「内置语料索引 · 依赖完整性 · 会话白名单」。

### 2.3 D-3 删除图谱专属交互与旧词表

| 目标 | 位置 |
|---|---|
| 五种依赖角色词表 | `frontend/src/utils/worldbookDependency.ts:12-29`（`DependencyRole`、`DEPENDENCY_ROLES`、`ROLE_LABELS`、`ROLE_GLYPHS`、`ROLE_HINTS`）、`classifyDependencyRoles`（`:102`）、`edgeStateKey`（`:99`） |
| 角色着色与筛选 UI | `WorldBookScopeManager.tsx:615-624`（「按类型 / 按角色」切换、role chip 过滤） |
| 树形布局与层带 | `worldbookDependency.ts` 的 `DependencyTreeLevel` / `DependencyTreeBand` / `DependencyTreeLayout`（`:362-394`）、`layoutDependencyTree`、`defaultTreeDepthLimit`（`:321`） |
| 框选几何 | `frontend/src/utils/worldbookBatch.ts:32` `pickedInRect`、`:12` `BatchRect` |
| 画布批量选择 | `WorldBookScopeManager.tsx` 的 `picked` 由画布点选/框选驱动、「全选可见条目」、`linkFrom` 批量连线模式 |
| 旧词汇 UI | `WorldBookScopeManager.tsx:913-916`（固定导入 / 设为导入源开关）、`:1003`（固定导入托盘）、批量栏的「固定导入 / 取消固定 / 设为导入源 / 取消导入源」（`:652-661`） |

**保留并改名**：`worldbookBatch.ts` 的 `batchFixed`（`:48`）与 `batchSource`（`:61`）合并为 `batchRoots(policy, uids, activation, expansion, maxDepth)`，仍在统一草稿上工作；`batchAddEdges`（`:77`）/ `batchRemoveEdges`（`:98`）/ `batchMove`（`:108`）/ `categoryEntryUids`（`:17`）/ `knownUids`（`:26`）保留。

**v2 兼容字段保留**：`WorldBookPolicyDraft` 里 `fixed_entry_uids` / `dependency_sources` 继续存在（`PUT /import-config` 仍需），只是不再作为 UI 主表述。

**同名不同物，勿误删**：`tests/test_node_graph_worldbook.py` 测的是战斗节点图 `NodeEditor`，与世界书图谱无关。

### 2.4 D-4 删除 AI 自动构建依赖

**结论：全局构建与会话侧 AI 微调一起删，会话面板只保留纯人工部分。**

**全局侧（整条 LLM 构建链路）**

| 目标 | 位置 |
|---|---|
| 构建内核 | `src/worldbook_builder.py`（元数据索引 / 分段 / 候选对 / 分析卡 / 判定 / 程序校验 / 任务 / 缓存）、`src/worldbook_builder_plan.py`（`Unit` / `ExactPacker` / `RequestPlan` / `packs_all_units`）、`src/worldbook_reading.py`（构建第一遍的「自适应选择性阅读」选择器，及 `READING_MODE_ADAPTIVE` / `READING_MODES` 两个常量） |
| 后端路由 | `src/blueprints/worldbook.py:1473-1594`：`POST/GET /api/worldbook/<id>/dependency-proposals`、`GET .../<job_id>`、`POST .../cancel`、`POST .../retry` |
| 后端辅助函数 | 同文件 `:1218` `_job_input_hash`、`:1225` `_model_identity`、`:1245` `_verified_proposal`、`:1343` `_verified_materialized_roots`、`:1408` `_character_directory_ids`、`:1419` `_active_job`、`:1427` `_start_job`；`:146-212` `_merge_v3_payload` 的 `proposal` 合并分支 |
| 证据过期口径 | `:109` `_ai_evidence_issues`、`:498` `WorldBookDetail.evidence_issues`、`:960` scope-preview 的 `stale_issues` |
| 前端面板 | `frontend/src/components/worldbook/DependencyBuildPanel.tsx`（整文件，约 350 行）、`worldbook/WorldBookConfigOverview.tsx:5` 的 import 与 `:275` 的挂载点 |
| 前端接口 | `frontend/src/hooks/useApi.ts:484-512`：`createDependencyProposal` / `listDependencyProposals` / `getDependencyProposal` / `cancelDependencyProposal` / `retryDependencyProposal` |
| 前端类型 | `frontend/src/types/index.ts:898-1000` 的 `DependencyJobStage` / `DependencyProposalRecordDTO` / `DependencyProposalResultDTO` / `DependencyJobOutcome` / `DependencyProposalJobDTO` / `WorldBookReadingMode`，`:1046` 的 `result`，以及 `WorldBookDetail.evidence_issues`（`:754-755`） |
| 脚本 | `scripts/verify_worldbook_builder_llm.py`、`scripts/benchmark_worldbook_builder.py`、`scripts/benchmark_worldbook_selective_reading.py` |
| 测试 | `tests/test_worldbook_builder.py`、`tests/test_worldbook_builder_perf.py`、`tests/test_worldbook_selective_reading.py` |
| 数据目录 | `data/worldbook_analysis`（分析卡与判定缓存，`src/worldbook_builder.py:46, 1597`）、`data/worldbook_jobs`（全局构建任务，`:47, 1796`） |

**会话侧（AI 微调，一并删除）**

- `src/blueprints/sessions.py:460-680`：`POST/GET /api/sessions/<session_id>/worldbook-dependency-jobs` 及 `/<job_id>`、`/cancel`、`/retry`、`/apply`；连带 `:28` 的 `worldbook_builder` import、`:43` 的 `data/memory/session_dependency_jobs` 任务目录。
- `frontend/src/hooks/useApi.ts:354-376` 的 5 个 job 方法；`components/session/SessionWorldbookDependencies.tsx:15` 的 job 状态与 AI 微调入口。
- **为什么一起删**：两者共用同一套构建内核（分析卡缓存、判定、证据校验、任务存储），只留会话侧等于保留九成代码与全部 LLM 成本；而会话侧 AI 微调的价值前提是全局侧先有规则，全局侧一去它就没有输入来源。

**明确保留（不在本节删除范围）**

- 会话依赖面板的**纯本地**能力：人工增删 `requires` / `related`、屏蔽继承（`suppressed_edges`）、恢复继承、`inheritance - suppressed + local_overrides` 公式、冲突按 local wins 展示、角色入离队刷新。
- 会话侧路由 `GET/PATCH /api/sessions/<session_id>/worldbook-dependencies`、`/restore`、`/inheritance-preview`、`/inheritance`。
- 确定性的分类入口：`POST /auto-classify`（`src/worldbook_classify.py` 只读条目元数据、不调模型）、`PUT /taxonomy`。
- `WorldBookRootDTO` 的 `activation` / `expansion` / `character_ids` / `max_depth`——这是载入语义本体，与 AI 无关，全部保留。

**数据模型处置：字段保留、只停写**

- `WorldBookRootDTO` 的 `origin` / `model` / `prompt_version` / `source_content_hash` / `evidence` / `review_status` / `job_id` / `locked`，与 `WorldBookRulesDTO` 的 `rejected` / `edge_meta`：语义只在 AI 构建里成立，但已经写进旧书 JSON；删字段会破坏旧书读回与酒馆格式往返导出，因此**留在 schema 里做兼容透传，新写入不再产生**。
- `WorldBookDetail.evidence_issues` 与 scope-preview 的 `stale_issues` 后端可保留可删，但**一律不得再出现在任何 UI 文案里**。

**删除安全性**（已 grep 确认，非推测）

- `worldbook_builder.py` / `worldbook_builder_plan.py` / `worldbook_reading.py` 三个模块只被 `src/blueprints/worldbook.py`、`src/blueprints/sessions.py` 的 import 行与上述测试 / 脚本引用；`worldbook_reading.py` 另被 `worldbook.py:50`、`sessions.py:32` 各取一个常量，随同删除后无残留引用。
- `worldbook_builder_plan.py` 只被 `worldbook_builder.py` 与 `tests/test_worldbook_builder_perf.py`、`scripts/benchmark_worldbook_selective_reading.py` 引用，无第三方消费者。

**连带的口径变化（写进 UI 文案与文档）**

- 「待复核」这个概念消失：`review_status` 不再有新值；配置概览的「待处理」只保留确定性项（依赖引用不存在的条目、角色分类缺角色关联、起点角色不在目录、必要依赖成环、停用 / 空正文）。
- `docs/design/worldbook/worldbook-on-demand.md:40-55` 的「AI 自动构建依赖」整节与其 API 表行（`:231-235`）失效，见 §6。
- **实施顺序**：本节必须先于 §7 阶段 2（页签收敛）落地，否则「分类与载入」页签会先接上 AI 面板再摘掉，白做一次接线。

---

## 3. 增补详解

以下为原接口和界面目标。`full_scope`、`legacy_depth`、`max_depth`、旧配置页签与 nodes 轨道后来均不再属于当前内部契约；A-2 UI 也已改为整书预览。保留这些字段用于解释当时设计，不要求现实现接受它们。

### 3.1 A-1 世界书升级为带页签工作台

**页签定义**

| 页签 id | 名称 | 承载组件（来源） |
|---|---|---|
| `entries` | 条目 | `WorldBookManager.tsx` 现有条目区（列表 / 编辑器 / 导入导出 / 资料库检索摘录 / 会话绑定） |
| `load` | 分类与载入 | `WorldBookDependencyPage.tsx` 的 `overview` + `entries` 视图（`WorldBookConfigOverview`、`WorldBookEntryWorkbench`）+ 由 `WorldBookScopeManager` 缩减而来的分类树列表与批量操作。**不含 AI 自动构建面板**——该面板随 §2.4 一并删除 |
| `prompt` | Prompt 预览 | **新增**，见 §3.2 |
| `nodes` | 节点视图 | **新增**，见 §3.4 |
| `index` | 本家索引 | `IndexManager.tsx` 平移（组件本身不改） |

**页签状态收敛**（关键重构点）

- 现状有两套页签状态：工作台页签（本方案新增的 `worldbookTab`）与 `WorldBookManager.tsx:135-140, 194` 的 `detailTab` / `normalizeDetailTab`（`utils/worldbookLibrary.ts`，值域 `entries` / `taxonomy`）。
- **必须合并为一套**：`detailTab` 的 `entries` 对应 `worldbookTab="entries"`；`detailTab` 的 `taxonomy`（界面名为「高级配置」，渲染 `WorldBookScopeManager view="taxonomy"`，见 `WorldBookManager.tsx:1077-1086`）对应 `worldbookTab="load"` 的分类部分。
- 保留 `utils/worldbookLibrary.ts` 的 `normalizeDetailTab` 的**语义**（资料库书不显示配置类页签），但实现改为对新页签状态归一，避免两处各判一次。

### 3.2 A-2 Prompt 预览

**接口契约**（只读，不写盘、不动候选缓存、不创建/修改会话、不污染全局 `random`）

```
POST /api/worldbook/<id>/prompt-preview
```

- 请求：`mode: "narrative" | "free"`、`input_text`、`recent_text`、`roster_character_ids[]`、`manual_entry_uids[]`、`full_scope`、`identity`、`active_char`、`seed`（默认 0）、`budget_tokens`（可选覆盖）、`policy`（完整草稿，可选，口径同 `POST /api/worldbook/<id>/scope-preview`）。
- **实现必须复用同一条执行路径**：`eligible_uids_for()` → `collect_matches(..., rng=random.Random(seed))` → `format_injection()`（`src/world_book.py:1323-1423`）。不新写分支；预览与线上注入必须字节等价（概率抽签改用固定种子是唯一差异）。
- 响应字段：

| 字段 | 内容 |
|---|---|
| `order[]` | `{ uid, name, seq, layer: "stable"\|"dynamic", position, group_weight, depth, estimated_tokens, reasons[], matched_keys[], override_from_node? }`，顺序即 `(position, -group_weight, depth, uid)` |
| `stable_text` / `dynamic_text` | 两个已拼装好的完整文本块（含 `【世界书】` 头） |
| `sites[]` | `{ layer, host: "reference" \| "world_book" \| "system_parts", after_block, before_block, description }` |
| `skeleton[]` | 宿主 prompt 的块顺序（剧情：`system → reference(含世界书) → characters → story_context → scene_state → conversation_history → player → scene_events → world_book → 收尾指令`；自由：`角色卡/system → reference/worldview → identity → knowledge → custom_instruction → length_rule → situation → 世界书动态层 → memory`），世界书块标记高亮 |
| `dropped[]` | `{ uid, name, reason }`，reason ∈ `not_in_scope` / `keyword_miss` / `secondary_miss` / `selective_reject` / `probability_miss` / `disabled` / `empty_content` / `budget_exceeded` / `node_binding_demoted` |
| `totals` | `{ stable_tokens, dynamic_tokens, budget_tokens, truncated, candidate_count, matched_count }` |

**界面（工作台第 3 个页签）**

- 顶部**必选**模式切换「剧情模式 / 自由模式」——两个宿主的插入点物理不同，不是可选装饰。
- 左栏（输入）：当前输入 + 最近对话两个文本框；「用当前会话最近 N 条真实对话填充」按钮（取 `activeSessionId`）；试选阵容（与配置概览共用 roster 状态）；手动追加条目；`full_scope` 开关；token 预算；固定随机种子提示「概率条目按固定种子抽取，结果可复现」。
- 中栏（最终文本）：默认折叠摘要卡（`稳定层 N 条 / X token`、`动态层 M 条 / Y token`、是否截断）；展开后按 `stable_text` → `dynamic_text` 逐字显示，`### 名称` 行作可点击锚点；每块上方一行说明插入位置（来自 `sites[]`）。
- 右栏（条目与顺序）：按 `seq` 排列，显示序号、层徽标、`position`、`group_weight`、`depth`、token 估算、命中原因（起点 / 依赖 / 手动追加 / 全量 / 关键词命中键）。
- 顶部骨架条：横向列出 `skeleton[]` 各块，世界书块实心高亮并标「前插 / 后插」。
- 底部「未插入」折叠区：按 `reason` 分组，每组一句解释 + 修复入口（例：`budget_exceeded` → 「提高预算或减少常驻条目」）。
- 分工文案（写死在页签顶部）：「配置概览的范围预览回答『哪些是候选』；这里回答『这一轮实际插进去什么、插在哪个位置、什么顺序』。前者按书，后者按**单轮**。」

**约束与验收**

- 同一输入 + 同一种子，连续两次请求返回**字节一致**（测试断言）。
- 节点绑定存在时，预览需展开 `override_from_node` 并标注「position 被节点绑定覆盖为 1（动态层）」。
- 请求前后对比书文件哈希与 mtime，必须零变化。

### 3.3 A-3 条目依赖逐层展开

**承载位置**

- 工作台 `条目` 页签的条目列表（`WorldBookManager.tsx:1121` 起的行渲染）。
- `分类与载入` → 条目与角色列表（`worldbook/WorldBookEntryWorkbench.tsx`）。
- 两处共用一个新组件 `EntryDependencyTree`；展开状态互相独立，不改动列表本身的筛选与分页。

**接口**

```
GET /api/worldbook/<id>/dependency-tree?entry_uids=A,B&max_depth=N
```

- 返回与 `resolve_v3_scope` 的 `display_tree` **同构**的节点：`uid` / `name` / `parent_uid` / `child_uids` / `depth` / `remaining` / `is_root` / `relation`，以及带 `status` 的边。
- **必须复用后端同一个遍历函数**（`src/worldbook_scope.py:399-464`：BFS + 最大剩余深度去重 + 环终止），不新增第二套遍历，保证"条目页看到的依赖"与"分类与载入页看到的范围"永远一致。
- 支持一次传多个 `entry_uids` 拿回整棵子树，避免逐层往返。
- 替代前端 `utils/worldbookDependency.ts` 的 `buildDependencyTree`（`:177`，与后端 v2 `expand_sources` 同构的另一套实现）。

**展开交互规则**

- 行首折叠三角，**仅当存在 `requires` 出边时显示**（`related` 出边不算展开来源），旁挂出边数徽标。
- 逐层缩进 16px，竖向导引线；默认展开 1 层。
- 行内容：名称 + uid + 边关系徽标（`requires` 实线参与展开 / `related` 点线仅提示不可再展开）+ 条目状态徽标（停用 / 正文为空 / 不存在，来自 `issues`）+ `remaining`（该路径还剩几跳预算；`legacy_depth` 起点受限，`requires_closure` 为无限）。
- **重复到达**：同一 uid 在同一次展开中第二次起渲染为**灰色行**，标注「已在上层展开（路径：A → B → X）」，默认不再展开子树；提供「仍要展开（仅查看）」链接，展开后整棵子树同为灰色。
- **环**：环内边标红并标「依赖环」，环内节点不再向下（服务端按最佳剩余深度终止，前端不自行截断）。
- 工具条：「展开到 N 层」「折叠全部」「只看 requires（隐藏 related）」。
- 固定说明行：「这是**静态依赖关系**，不代表该条目本轮一定载入；实际候选看『分类与载入』，实际注入看『Prompt 预览』。」
- 编辑入口：展开行右侧「＋加依赖」「－移除」，写入**统一草稿**（requires / related 选择器），由页头一次 `PUT /api/worldbook/<id>/configuration` 保存；不做拖拽连线。

### 3.4 A-4 世界书节点视图

#### 3.4.1 布局

```
[ 轨道：全书条目，从左到右，节点上方显示序号 ]
   ┌───┐   ┌───┐   ┌───┐   ┌───┐
   │ 1 │   │ 2 │   │ 3 │   │ 4 │  ...
   └─┬─┘   └───┘   └─┬─┘   └───┘
     │               ├── [灰] X ── 已插入过，不重复
     ├─ A            └─ B
     │  └─ C
     └─ [灰] D ── 已插入过，不重复
```

- **轨道（y=0）**：全书**启用且有正文**的条目，一个 uid 一个节点，从左到右，节点上方显示序号。
- **向下展开**：每个节点向下画出 `requires` 出边所连对象，逐层向下；同父的子按 uid 稳定排序；子树宽度按后代数量分配，父节点居中于子节点群。
- **右侧属性栏**：选中节点详情。
- **顶部统计条**：起点数 / 已在范围内 / 未被任何起点覆盖 / 依赖环 / 超深度边 / 隐藏节点数。

#### 3.4.2 先后顺序规则

轨道排列键 = **服务端真实注入排序键**，与 `src/world_book.py:1380` 完全一致：

```
position 升序（0=卡前 → 1=卡后）
  → group_weight 降序
  → depth 升序
  → uid 升序（稳定兜底）
```

- 节点上方序号即该排序的位次。
- **假设（必须写进界面文案）**：此处「先后」指**静态注入顺序键**，不是「本轮一定按此顺序全部插入」——每轮实际命中是关键词 / 概率 / token 预算决定的子集，轨道顺序表达的是"若都被命中时的插入次序"。
- 起点（`active_roots`）用**金色左缘 + 徽标**标出，徽标写明 `activation`（`always` 基础设定 / `roster_any` 角色入队 / `manual` 手动 / 全量兼容）与 `expansion`（`none` / `requires_closure` / `legacy_depth+N`）；未被任何起点覆盖的条目用**浅灰左缘 + 「游离」弱标**。
- 轨道**不重新分组**，严格单一序列，只加视觉标记（分组会破坏"位次即注入顺序"的直觉）。
- **本轮命中叠加**：跑过 Prompt 预览后，`order[]` 中的条目在轨道节点上叠加实心圆点 + **实际序号**（右下标），与左上的静态序号区分。

#### 3.4.3 灰节点与去重插入规则

**灰节点 = 该 uid 在本视图中的一次「非首次到达」。**

1. **主节点唯一**：同一 uid 只允许一个主节点——轨道上的出现优先；轨道上没有（例如条目已停用）时取最早到达的展开位置。
2. **其余出现位置一律渲染为灰节点**：灰底、灰字、虚线边框、不透明度降低；**保留可展开手柄**，仍可展开（其下游可能带出别处没有的节点），展开结果整棵子树同为灰色只读视图。
3. **灰节点标注**：「已插入过（路径 A → B → X），不重复插入」，并提供「跳到首次出现」按钮定位主节点。
4. **去重口径与服务端完全一致**：`src/worldbook_scope.py:401-404` 的 `best` 表按**最大剩余深度**去重（`_rank_remaining(known_remaining) >= _rank_remaining(remaining)` 时跳过）。**主节点 = 路径预算最强的那次到达；灰节点 = 被它覆盖的其他到达。**
5. **灰节点不参与 token 统计与序号**：token 估算、顺序号、范围计数只算主节点；灰节点只在边上计数。
6. **灰节点 ≠ 一定不注入**：文案必须写死「不重复进入候选范围；是否实际注入仍由关键词、概率、token 预算决定，见『Prompt 预览』」。灰节点表达**候选去重**，不是最终注入裁决。

#### 3.4.4 边与节点视觉

| 元素 | 含义 |
|---|---|
| 实线箭头 | `requires` 且 `status=skeleton`：主路径（`display_tree` 父子关系，`worldbook_scope.py:445-464`） |
| 灰实线 | `requires` 且 `status=cross`：边生效但目标已被覆盖 → 目标渲染为**灰节点**（对应 `cross_references`，`:466-468`） |
| 灰虚线 | `requires` 且 `status=capped`：上游已到达但遍历深度用尽（`remaining==0` 未遍历，`:406-407`） |
| 点线 | `related`：仅图示，不参与展开（`:441-443`，`active: false`） |
| 红虚线 | 位于依赖环内 |

节点角标：`position`（0/1）、`depth`、`group_weight`（非 100 才显示）、起点 `activation` 徽标、问题徽标（停用 / 空正文 / 缺失，来自 `preview.issues`）。

#### 3.4.5 数据来源与后端改动

- 数据来自已有 `POST /api/worldbook/<id>/scope-preview`：`display_tree` / `resolved_edges` / `cross_references` / `issues` / `selection_reasons` / `active_roots`。**不新增解析接口。**
- 后端只在 `resolve_v3_scope` 返回上补**读时派生**字段（不改任何持久化 schema，不改载入语义）：
  - `resolved_edges[].status: "skeleton" | "cross" | "capped" | "idle"`（由已有 `used_edges`（`:409`）与 `tree_edges`（`:467`）推出；`capped` = 上游 `remaining==0` 未遍历的边；`idle` = 上游不在 `best` 中的边）
  - `display_tree[].repeated` / `first_parent_uid` / `display_index`
  - 可选 `arrivals: { uid: [ { from_uid, remaining, depth } ] }`，供路径 breadcrumb 直接渲染

#### 3.4.6 交互（全部只读）

- 顶部横向滚动 + 缩略进度条；轨道条目 > 120 时启用虚拟化，只渲染视口内节点与其已展开子树。
- 点击节点 → 右侧属性栏：uid、名称、分类、`position`/`depth`/`group_weight`、是否被起点激活、到达路径 breadcrumb（逐级可点跳转）、下游规模、问题列表；底部「编辑条目」「加依赖」（写统一草稿）。
- 折叠/展开单个分支；「展开到 N 层」默认取覆盖约 60 个节点的层数；「折叠全部」。
- 筛选器：分类、问题类型、只看起点与依赖闭包、只看本轮命中（依赖 Prompt 预览结果）。
- **不提供**：节点拖拽、画布平移缩放、框选、在图上连线、节点位置持久化。布局完全确定性，同一份输入永远同一张图。

#### 3.4.7 规模控制

- 预装整合包 261 条约 261 个轨道节点；**默认只展开已激活起点**的子树，未被覆盖的条目留在轨道并计入「未覆盖」统计。
- 子树节点总数超过阈值（建议 400，沿用旧画布经验值，见 `docs/design/worldbook/worldbook-on-demand.md:113`）时截断，提示「已隐藏 N 个下游节点，可用筛选或展开层级收窄」；**截断只影响显示，不影响真实候选**。

---

## 4. 数据结构与接口变更汇总

本节“保留兼容透传”是原阶段决定，随后被当前内部 v3 清理纪律取代；SillyTavern 外部互操作继续保留，两者不能混同。

### 4.1 新增接口（均为只读）

| 方法 + 路径 | 用途 | 对应 |
|---|---|---|
| `POST /api/worldbook/<id>/prompt-preview` | 单轮实际注入的文本、顺序、位置、未插入原因 | A-2 |
| `GET /api/worldbook/<id>/dependency-tree?entry_uids=&max_depth=` | 条目依赖子树（与 `display_tree` 同构） | A-3 |
| （复用）`POST /api/worldbook/<id>/scope-preview` | 候选范围解析结果 | A-4 |

### 4.2 字段增补

| 类型 | 增补 | 位置 |
|---|---|---|
| `resolved_edges[]` | `status: "skeleton" \| "cross" \| "capped" \| "idle"` | 后端派生（`src/worldbook_scope.py:438-468`） |
| `WorldBookDisplayNodeDTO` | `repeated: boolean`、`first_parent_uid: string \| null`、`display_index: number` | `frontend/src/types/index.ts:844-853` 与后端同构 |
| scope-preview 响应 | 可选 `arrivals: { uid: [...] }` | 后端派生 |

### 4.3 明确不改的结构

- `WorldBookRulesDTO`（`roots` / `root_rule` / `requires_edges` / `related_edges` / `rejected` / `edge_meta`）—— `types/index.ts:828-838`。其中 `rejected` / `edge_meta` 属 AI 专属，改为**停写不删**（§4.4）
- `WorldBookRootDTO`（`activation` / `expansion` / `character_ids` / `max_depth` / `locked` / `origin` / `model` / `prompt_version` / `source_content_hash` / `evidence` / `review_status` / `job_id`）—— `types/index.ts:813-827`。`activation` / `expansion` / `character_ids` / `max_depth` 是载入语义本体，全部保留；`origin` / `model` / `prompt_version` / `source_content_hash` / `evidence` / `review_status` / `job_id` / `locked` 属 AI 专属，改为**停写不删**（§4.4）
- `WorldBookDependencyEdgeDTO`（`types/index.ts:766`）、`WorldBookImportConfigDTO`（`:803-807`）、`WorldBookEntryDTO`（`:690-713`）、`WorldBookDetail`（`:741-756`）。`WorldBookDetail.evidence_issues`（`:754-755`）属 AI 专属，前端不再渲染（§4.4）
- 会话级：`SessionWorldbookDependenciesDTO`（`:767-791`）、`SessionInheritancePreviewDTO`（`:792-802`）
- 后端蓝图路由保留：`PUT /taxonomy`（`src/blueprints/worldbook.py:849`）、`PUT /configuration`（`:1182`）、`PUT /import-config`（`:924`）、`POST /auto-classify`（`:885`）、`POST /scope-preview`（`:939`）。**dependency-proposals 系列（`:1474-1594`）不保留**，随 `worldbook_builder` 一起删除（§2.4）
- v2 兼容字段 `fixed_entry_uids` / `dependency_sources` 继续保留（`PUT /import-config` 仍需）

### 4.4 本次删除的接口与结构

| 类别 | 删除项 | 对应 |
|---|---|---|
| 后端路由 | `POST/GET /api/worldbook/<id>/dependency-proposals`、`GET .../<job_id>`、`POST .../cancel`、`POST .../retry` | D-4 |
| 后端路由 | `POST/GET /api/sessions/<session_id>/worldbook-dependency-jobs`、`GET .../<job_id>`、`POST .../cancel`、`POST .../retry`、`POST .../apply` | D-4 |
| 前端接口 | `useApi.ts` 的 `createDependencyProposal` / `listDependencyProposals` / `getDependencyProposal` / `cancelDependencyProposal` / `retryDependencyProposal`，以及会话侧 5 个 job 方法 | D-4 |
| 前端类型 | `DependencyJobStage` / `DependencyProposalRecordDTO` / `DependencyProposalResultDTO` / `DependencyJobOutcome` / `DependencyProposalJobDTO` / `WorldBookReadingMode` | D-4 |
| 构建内核 | `src/worldbook_builder.py`、`src/worldbook_builder_plan.py`、`src/worldbook_reading.py` | D-4 |
| 字段（停写不删） | `WorldBookRootDTO` 的 `origin` / `model` / `prompt_version` / `source_content_hash` / `evidence` / `review_status` / `job_id` / `locked`；`WorldBookRulesDTO` 的 `rejected` / `edge_meta`；`WorldBookDetail.evidence_issues` | D-4 |
| 数据目录 | `data/worldbook_analysis`（分析卡与判定缓存，`src/worldbook_builder.py:46, 1597`）、`data/worldbook_jobs`（全局构建任务，`:47, 1796`）、`data/memory/session_dependency_jobs`（会话 AI 微调任务，`src/blueprints/sessions.py:43`） | D-4 |

**字段为什么是"停写不删"**：这些字段的语义只在 AI 构建里成立，但它们已经写进旧书的 JSON（`roots[].origin/model/evidence`、`rules.rejected`、`rules.edge_meta`）。删字段会破坏旧书读回与酒馆格式往返导出，所以保留为兼容透传，新写入不再产生新值；UI 一律不再展示。

---

## 5. 测试与脚本同步

以下动作与验收清单属于原计划；未记录执行结果的项目不能当作通过证据。当前脚本与测试入口以仓库存在的文件为准。

| 文件 | 动作 | 说明 |
|---|---|---|
| `scripts/test_worldbook_scope_ui.cjs` | **重写约 150 行断言** | 删画布相关：`:21-24` 的 `worldbookGraph` / `worldbookDependency` 布局导出、`:48-79` 的图构建与布局断言、`:122-198` 的依赖树建模与布局断言、`:205-213` 的 `pickedInRect` 框选断言。补：节点视图轨道排序与灰节点去重、依赖展开树、Prompt 预览的纯函数与 SSR 断言 |
| `scripts/test_worldbook_review_ui.cjs` | 检查并同步 | 涉及高级分类/归属与切书路径，需随页签收敛更新 |
| `scripts/test_worldbook_library_ui.cjs` | 检查并同步 | `docs/design/worldbook/worldbook-library.md:134` 记录了「详情页签归一（资料库恒为条目页）」断言，需随 `worldbookTab` 收敛改写 |
| `tests/test_worldbook_scope.py` | **不动**，补用例 | 后端范围与原子性回归 |
| `tests/test_worldbook_v3_scope.py` | **不动**，补用例 | v3 解析语义（单角色不激活他人、共享依赖去重、related 不展开、环终止、闭包不静默截断等）——新接口必须与它一致 |
| `tests/test_worldbook_config_api.py` | **删 AI 任务用例**，其余不动 | 现含无模型 503、任务轮询分页、取消与重试、stale 标记、AI 建议并入人工草稿；这些随 §2.4 删除。保留原子写、409 保留草稿、非法写入不落盘、v3 解释只读、单角色与手动追加、`draft_hash` 稳定与阵容敏感、预览过期拒绝、全量兼容一致性、手动追加的会话作用域 |
| `tests/test_session_worldbook_dependencies.py` | **删 AI 任务用例**，其余不动 | 删 scoped LLM 与 requires frontier、任务 stale/取消/预算中断恢复用例；保留继承/覆盖/屏蔽恢复、角色刷新、schema2 局部升级、全局更新冲突、跨会话隔离、并发门禁 |
| `tests/test_worldbook_review_fixes.py` | **删 AI 构建用例** | 含「预装书全书构建在自动预算内完成」类用例，随 §2.4 删除 |
| `tests/test_worldbook_builder.py` | **整文件删除** | AI 构建专项（候选检索、证据降级、校验拒绝、环与高扇出、置信度只排序、卡片与判定缓存、结构化失败、取消、持久化、失败批次重试、调用预算、规则分离与人工保护） |
| `tests/test_worldbook_builder_perf.py` | **整文件删除** | 构建分块与装箱性能 |
| `tests/test_worldbook_selective_reading.py` | **整文件删除** | 构建第一遍的选择性阅读选择器 |
| `scripts/verify_worldbook_builder_llm.py` | **整文件删除** | AI 构建的真实模型端到端验证脚本 |
| `scripts/benchmark_worldbook_builder.py` | **整文件删除** | 构建成本确定性对照 |
| `scripts/benchmark_worldbook_selective_reading.py` | **整文件删除** | 选择性阅读成本对照 |
| `tests/test_node_graph_worldbook.py` | **不动** | 战斗节点图，同名不同物 |

**新增用例清单**

- Prompt 预览：同输入两次请求字节一致；`dropped.reason` 九类覆盖；预算截断；概率未中；未在候选范围；节点绑定降级；零写盘（请求前后文件哈希 + mtime 不变）。
- 依赖树：与 `display_tree` 同构一致性；多源到达保留最大剩余深度；环终止；`related` 不展开。
- 节点视图：灰节点去重口径与 `best` 表逐条一致（构造含多源 + 环 + 超深度的书）；261 条预装书首屏渲染时间与内存。

---

## 6. 文档同步（先改文档再改代码）

以下表格保留原行号清单以追溯影响面。对应文档现已重写或归档，不应照旧行号恢复旧章节；实际同步时先查当前导航和入链。

| 文件 | 行 | 需改内容 |
|---|---|---|
| `docs/architecture.md` | `:125` | `ContentHub.tsx` 的 Tab 清单 |
| | `:128` | `WorldBookManager.tsx` 描述（详情页签与「高级配置」） |
| | `:167` | `scripts/test_worldbook_scope_ui.cjs` 的描述（现写作「世界书图谱/依赖树的纯逻辑与 SSR 检查」） |
| | `:203` | worldbook-on-demand 摘要（「分类与依赖图谱」） |
| `docs/design/content-hub-design.md` | `:11, :17, :21` | 三处仍把「世界书图谱」列为内容中心 Tab |
| `docs/tutorial.md` | `:119` | 内容中心菜单说明 |
| | `:161` | 「分类图谱…保留在高级配置里」 |
| `docs/design/worldbook/worldbook-on-demand.md` | `:7` | 「内容中心 → 世界书图谱」入口描述 |
| | `:22` | 「世界书 → 分类图谱」入口描述 |
| | `:86` | 「分类图谱工具栏的自动分类」入口 |
| | `:90-113` | 「依赖树」「图谱操作」两整节 |
| | `:242` | 前端实现清单（`WorldBookGraphCanvas` / `utils/worldbookGraph` / `utils/worldbookDependency`） |
| | `:11` | 按需载入对「AI 生成的条件起点不会被高级视图静默清掉」的兼容说明 |
| | `:40-55` | 「AI 自动构建依赖」整节（含 10 条流程与约束） |
| | `:231-235` | API 表的 dependency-proposals 五行 |
| | `:248, :259-272` | 验证章节里的 builder 专项测试与真实 LLM 验证脚本 |
| | `:283, :288-289, :292` | 「人工锁定 / 拒绝记录 / 证据过期 / 待复核」「孤儿任务续跑」等 AI 专属口径 |
| `docs/design/worldbook/worldbook-builder-performance.md` | 整文件 | AI 构建性能专项；随 §2.4 移入 `docs/archive/` 或删除 |
| `docs/design/worldbook/worldbook-selective-reading.md` | 整文件 | 构建第一遍的选择性阅读设计；随 §2.4 移入 `docs/archive/` 或删除 |
| `docs/architecture.md` | `:57-59` | `worldbook_builder.py` / `worldbook_builder_plan.py` / `worldbook_reading.py` 三个模块条目 |
| | `:130` | 配置概览描述里的「AI 自动构建面板」 |
| | `:167` | 其他脚本清单里的 `benchmark_worldbook_builder.py` / `verify_worldbook_builder_llm.py` |
| | `:206` | 文档地图里 `worldbook-builder-performance.md` 一行 |
| `docs/tutorial.md` | `:161` | 「AI 自动构建依赖」入口描述 |
| `docs/design/worldbook/worldbook-library.md` | `:115` | 详情页签与 `normalizeDetailTab` |
| | `:134` | SSR 断言描述 |
| `README.md` | — | 世界书截图说明；`docs/images/05-worldbook.jpg` 需重新截图（`06-plot-graph.jpg` 是战斗节点图，不动） |

---

## 7. 实施顺序与验收

六阶段是 2026-09-21 原计划，顺序用于说明依赖关系，不是当前实施队列。这里的命令、全绿要求和兼容断言均为当时门禁，没有执行日志就不是验收结果；原浏览器行号引用也不再是操作入口。

### 阶段 1 · 删除 AI 自动构建依赖

- 按 §2.4 删除后端构建内核（`worldbook_builder` / `worldbook_builder_plan` / `worldbook_reading`）与其路由、前端面板（`DependencyBuildPanel`）与接口、三个脚本、三个测试文件，以及会话侧 AI 微调路由与 UI；清掉 `data/worldbook_analysis` / `data/worldbook_jobs` / `data/memory/session_dependency_jobs` 三个目录的处理代码。
- **验收**：`grep -r "worldbook_builder\|dependency-proposals\|DependencyBuildPanel\|_ai_evidence_issues"` 在 `src/`、`frontend/src/` 零命中；`bash scripts/run_tests.sh` 全绿；旧书读入写出后 `roots` / `requires_edges` / `related_edges` 逐字不变，`origin` / `model` / `evidence` / `review_status` / `rejected` / `edge_meta` 照旧透传且不再新增；配置概览不再出现「AI 自动构建依赖」与「待复核 / 证据过期」。
- **必须最先做**：晚于阶段 2 会出现「先给分类与载入页签接上 AI 面板、再摘掉」的返工。

### 阶段 2 · 导航与页签收敛（不动世界书内部逻辑）

- 新增 `worldbookTab` 状态；工作台加页签容器；迁入 `WorldBookDependencyPage` 的 `overview` / `entries`；`ContentHub` 去掉两个 Tab；改 6 处跳转（`ContentHub.tsx:25,28,155`、`WorldBookScopeManager.tsx:513,613`、`SessionManagerView.tsx:798,821`）；`HomeMenu.tsx:35` 文案；合并 `detailTab` / `normalizeDetailTab`。
- **验收**：所有原入口都能到达目标页签；无死链；全仓 `grep "worldbook-deps"` 为空；`test_worldbook_library_ui.cjs` 页签归一断言同步通过。

### 阶段 3 · 砍画布

- 删 `WorldBookGraphCanvas.tsx`、`utils/worldbookGraph.ts`；`WorldBookScopeManager` 去 `dependencies` / `tree` 视图与角色词表，`taxonomy` 改列表；清 `worldbook-graph.css` 画布区段；`worldbookBatch.ts` 去 `pickedInRect`；重写 `test_worldbook_scope_ui.cjs` 画布断言。
- **验收**：`frontend/` 下 `npm run build` 通过；`node scripts/test_worldbook_scope_ui.cjs` 通过；统一草稿的保存 / 409 保留 / 撤销行为不变（`tests/test_worldbook_config_api.py` 全绿）。

### 阶段 4 · 条目依赖展开

- 后端加 `GET /dependency-tree`（复用 `resolve_v3_scope` 遍历）+ `resolved_edges[].status`；前端做 `EntryDependencyTree` 接进两处列表；编辑写回统一草稿。
- **验收**：与 `display_tree` 同构一致性用例；多源去重、环终止、`related` 不展开用例；纯函数 + SSR 断言。

### 阶段 5 · Prompt 预览

- 后端加 `POST /prompt-preview`（强制走 `collect_matches` + `format_injection`，固定 seed）；前端做第 3 个页签与三栏布局、骨架条、未插入区。
- **验收**：同输入两次请求字节一致；`dropped.reason` 九类覆盖完整；预算截断 / 概率未中 / 未在候选范围 / 节点绑定降级四类专项用例；接口零写盘。

### 阶段 6 · 节点视图

- 后端补 `display_tree[].repeated / first_parent_uid / display_index` 与可选 `arrivals`；前端做虚拟化横向轨道 + 向下展开 + 灰节点 + 属性栏 + 与 Prompt 预览联动。
- **验收**：灰节点去重口径与 `best` 表逐条一致；261 条预装书首屏渲染时间与内存可接受；不出现"展开全书卡死"。

**每阶段收尾统一跑**：`bash scripts/run_tests.sh` + `node scripts/test_worldbook_scope_ui.cjs` + `cd frontend && npm run build` + 浏览器验收（沿用 `WB_UI_URL` / Playwright 路径，见 `docs/design/worldbook/worldbook-on-demand.md:274,292`）。

---

## 8. 假设与风险

### 假设（实施前请确认）

1. 轨道「先后顺序」= **静态注入排序键**，不是本轮实际命中序列（§3.4.2）。
2. 「索引」可改名为「**本家索引**」并接受放在「世界书」页下（§2.2）。
3. 节点视图不引入任何图形库——现状本就无图形库依赖（`worldbook-on-demand.md:242` 明确「图谱不依赖额外图形库」），新视图沿用纯 SVG + DOM，不引入 d3 / react-flow。
4. 除已点名的引用点外，无其他消费方依赖 `utils/worldbookGraph.ts` 与 `utils/worldbookDependency.ts` 的布局导出（已 grep 确认仅 `WorldBookGraphCanvas`、`WorldBookScopeManager`、`WorldBookDependencyPage`、`scripts/test_worldbook_scope_ui.cjs` 引用）。
5. 大书阈值 400 节点沿用旧画布经验值（`worldbook-on-demand.md:113`），未做新的性能实测。
6. `data/worldbook_analysis` / `data/worldbook_jobs` / `data/memory/session_dependency_jobs` 里已有的历史文件：本方案只删除读写它们的代码，**不主动删磁盘数据**；是否清理由你决定（这些目录不影响运行，只占空间）。

### 风险与缓解

| 风险 | 缓解 |
|---|---|
| 「索引」改名后老用户找不到 | `HomeMenu` 的「世界书」desc 直接列出五个页签名；页签副标题写清职责 |
| 全局页签与会话面板（`session/SessionWorldbookDependencies.tsx`）都能改 `requires`，用户误以为改的是全局 | 会话面板显著标注「本会话覆盖 / 屏蔽」，并在保存后展示服务端重算结果 |
| 灰节点被误读为「绝对不会注入」 | 文案与 tooltip 写死「不重复进入候选范围，实际注入见 Prompt 预览」，并提供跳转 |
| 文档先于代码失效 | 阶段 1–3 前先改 §6 列出的文档，避免文档描述不存在的界面 |
| 删掉 AI 构建后，旧书里已有的 AI 关系被误当成"应该一起清掉" | 规则是**字段保留、只停写**：旧书的 AI 关系照常载入、参与候选与依赖展开，只是不再产生新的证据与复核状态；文档与 UI 文案写明「历史 AI 关系仍然生效，可人工增删」 |
| 清理时误删同名文件 | `tests/test_node_graph_worldbook.py` 是战斗节点图，明确排除 |
