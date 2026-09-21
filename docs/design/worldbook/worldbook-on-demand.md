# 世界书按需载入与依赖配置

世界书先计算会话的**候选范围**，再沿用酒馆的关键词、常驻、概率、位置与 token 预算规则决定实际注入。候选范围不是强制注入清单，也不是实际每轮 token 消耗。

## 使用入口

**世界书 → 分类与载入**（工作台第 2 个页签）默认给三个子视图，共用同一份**统一草稿**（分类、角色关联、起点规则、依赖边），右上角一次「保存」原子写入；切视图、切页签都不丢草稿，保存失败或版本冲突（409）也保留草稿。想看「这一轮实际插进去了什么」去 `Prompt 预览`，想看顺序与依赖的全局形状去 `节点视图`。

- **配置概览**：把「这本书怎么载入」压成四组——**基础设定**（所有会话候选）/ **角色设定**（入队时选用）/ **关联补充** / **待处理**，外加「试选阵容」与「本次范围预览」。待处理只列真要动手的项（依赖引用了不存在的条目、角色分类缺角色关联、起点指定的角色不在目录里、必要依赖成环等）；**条目没被当前试选阵容选中不算错误**。
- **条目与角色**：条目列表 + 详情，四个常见动作覆盖绝大多数情况（见下）。显示角色名与头像，实际写入配置的仍然是角色目录 ID。
- **分类结构**：分类树 + 条目归属表 + 批量操作（圆形分类/条目节点的画布与连线已删）。它显示的是**统一草稿的投影**，保存走同一条 `PUT /configuration`；因此条件起点（`roster_any` / `manual` / `requires_closure`）不会被静默清掉。

四个常见动作（条目与角色视图）：

| 动作 | 写入 | 语义 |
|---|---|---|
| 加入基础设定 | 起点 `activation=always, expansion=none` | 不分角色，用这本书就是候选 |
| 角色入队时选用 | 起点 `activation=roster_any, character_ids=[角色]`，`expansion=requires_closure` | 只有该角色入队才载入，并补齐它的必要依赖 |
| 选用此条时同时选用… | `requires` 边 | 参与遍历，对方被一起补上 |
| 仅标记相关 | `related` 边 | 只作浏览，**不展开** |

**世界书 → 分类与载入** 的 **分类结构**：分类树、条目归属与角色关联，工具栏提供「自动分类」（先预览再应用）。切到 `条目` 页签可浏览和编辑原有条目正文。

**创建会话**：选定世界书和阵容后展示服务端真实解析的候选统计、载入树与选用原因；创建时一次性初始化剧情、阵容、绑定与范围快照，失败不会留下半成品会话。创建全程**不调用任何 LLM**。

## 载入规则模型（v3）

v3 把「分类」和「载入」彻底分开：**分类只负责组织内容，起点与展开决定候选**。分类之间移动条目不会隐式改变候选范围。

- 全书是一张有向图，**依赖树只是这张图的一个投影**（服务端生成稳定主路径，前端不自己再走一遍遍历）。
- 起点（root）由两个正交属性描述：
  - `activation`：`always` 恒为候选 / `roster_any` 入队任一指定角色即候选 / `manual` 只手动追加（**不会自动激活**）。
  - `expansion`：`none` 只含自身 / `requires_closure` 完整必要闭包 / `legacy_depth` 旧深度语义（带 `max_depth`）。
- `requires` 边参与闭包遍历（多源、按**最大剩余深度**去重）；`related` 边**不参与遍历**。
- 环可终止，环内边作为「交叉引用」单独列出；新必要闭包不会被任意深度静默截断，超过上限报「来源过大」错误而不是悄悄少载。
- 被依赖带入的条目**不会**反过来激活它所属角色的整组条目——激活只看起点自身的 `activation`，依赖只负责补齐。
- 共享依赖只选一次；移除一个角色不会删掉另一个角色仍需要的内容。
- 已激活必要依赖里出现**停用 / 缺失 / 空正文**的条目会作为可解释问题列出，不会被当成「已完整」。

## AI 自动构建依赖（已移除）

> **已移除（2026-09，提案 D-4）**：原本「配置概览右侧一次点击 → 后台读完整本书 → 逐条给出起点与依赖建议 → 人工逐条复核后应用」的整条 LLM 构建链路（含后台任务、阶段进度、重试、待复核列表与「证据过期」提示，以及会话面板里的 AI 微调入口）连同 `src/worldbook_builder.py` / `src/worldbook_builder_plan.py` / `src/worldbook_reading.py`、`dependency-proposals` 系列接口一并删除；性能与阅读模式两篇专项设计已归档到 `docs/archive/`。见 `docs/proposals/worldbook-workbench-redesign.md` §2.4。
>
> **删的是「让模型替你猜依赖」，不是依赖功能**：依赖数据（`requires` / `related`）、分类、载入规则、统一草稿的保存与撤销、范围预览、节点绑定全部保留，改在 `分类与载入` 与 `节点视图` 里由人手工维护。旧书里**已经存在的 AI 关系照常载入与展开**——`origin` / `model` / `prompt_version` / `source_content_hash` / `evidence` / `review_status` / `job_id` / `locked` 与 `rules.rejected` / `edge_meta` 保留为兼容透传（**停写不删**），可以人工增删。

## 条目的类型与起点

界面上的两套标记是：

| 标记 | 取值 | 依据 |
|---|---|---|
| 类型 | 世界观 / 角色 / 其他 | 条目所属分类的 `scope_type`（分类结构的类型圆点、归属表的类型点） |
| 起点 | `activation`（基础设定（所有会话候选） / 角色入队时选用 / 仅手动追加）× `expansion`（只含自身 / 补齐必要依赖 / 按旧深度展开 + N） | 条目的起点配置，在「条目与角色」逐条配、在批量栏批量配；归属表的起点徽标显示这一组合，未配置时显示「未配置起点」 |

> **旧格式口径（已不是界面表述）**：v2 的「导入源 / 固定导入 / 中转节点 / 叶子节点 / 未配置」五种角色，以及对应的「按类型 / 按角色」着色切换与角色图例，已随 D-1 / D-3 与本功能重构一并删除——代码里不再有任何地方推导它们（`classifyDependencyRoles` 也已移除，`WorldBookScopeManager` 不再引用 `fixed_entry_uids` / `dependency_sources`）。
> 旧字段只在**数据层**保留，用于旧书读回与旧格式解释（`PUT /import-config` 仍需）：`dependency_sources` = 旧「导入源」，`fixed_entry_uids` = 旧「固定导入」；「中转节点 / 叶子节点 / 未配置」只是当年按入出边临时推出来的展示分类，没有对应字段。「仍在使用旧版载入规则」的书会在配置概览里被显式提示，并按「固定导入 → 基础设定、导入源 → 按旧深度展开」解释一次。

## 条目分类（自动分类）

分类本身也是数据：条目通过 `category_id` 归属分类，分类的 `scope_type` 决定它在按需载入下怎么进候选。整合包生成器把类别写在了三处可交叉验证的地方，自动分类只认这些**显式线索**，识别不出就保持未分类，**不按条目名字或正文猜测**：

| 优先级 | 线索 | 例子 |
|---|---|---|
| 1 | uid 生成器前缀 | `characters_阿米娅_index` / `items_01-源石_index` / `plot_graph_*` |
| 2 | `group` 字段（白名单取值） | `世界观` / `角色` / `敌人`（`group1`、`always` 之类一律忽略） |
| 3 | 名称括号后缀 | `泰拉世界基础设定（世界观设定）` |

结论按 1 → 2 → 3 取值；三条线索给出不同分类时会记进「线索冲突」供人工复核。产出的分类树与加载语义对齐：

- **世界观设定**（worldview）下挂 **规则 / 属性 / 种族 / 职业 / 天气 / 地点设定**（子分类继承父类型）。这些「设定类」条目在按需载入下始终是候选，与旧的「world/rules/attributes/races/classes/Location → worldview」约定完全一致，只是界面上能看清具体类别。
- **角色设定**（character）由 `characters_<角色目录名>_index` 推导出 `character_id`；推导不出目录名的条目落到 **角色条目（未关联）**（other），因为角色分类的条目必须带角色关联才能保存。
- **物品 / 敌人 / 剧情设定 / 节点图**（other）沿用旧约定，不参与世界观候选。

入口在 `分类与载入` 页签的**分类结构**工具栏「自动分类」：先出方案（可归类/无线索条数、将写入的分类与条目数、线索来源、冲突与未识别明细），再点「应用分类」写入。预装整合包在分类形同未分类时会自动补齐，**不覆盖用户已编辑过的分类**；外部的酒馆书没有这类元数据，一律保持原样，需要时走这个显式入口。

**自动分类只改「条目属于哪一类」与随之而来的角色关联，不改载入模式、起点与依赖策略**（旧格式字段 `fixed_entry_uids` / `dependency_sources` 也不动）——旧书仅修分类不会自动启用按需载入（与 `PUT taxonomy` 的纪律一致）。

## 节点视图与依赖展开

工作台用两种方式看依赖，**都只读**，数据都来自服务端解析结果，前端不自己再走一遍遍历。

**`节点视图` 页签（替代原画布）**

- **轨道**：全书启用且有正文的条目从左到右排成一行，一个 uid 一个节点，节点上方显示静态序号。排列键就是服务端真实注入排序键——`position` 升序（0=卡前 → 1=卡后）→ `group_weight` 降序 → `depth` 升序 → `uid` 升序，与 `world_book.py` 的 `format_injection` 排序完全一致。
- **向下展开**：每个节点向下画出 `requires` 出边所连的对象，逐层向下；同父的子按 uid 稳定排序，子树宽度按后代数量分配，父节点居中于子节点群。
- **灰节点（去重插入）**：同一 uid 只允许一个主节点——轨道上的出现优先，其余到达位置渲染为灰节点并标注「已插入过（路径 A → B → X），不重复插入」，可展开但整棵子树同为灰色只读视图。去重口径与服务端完全一致：`resolve_v3_scope` 的 `best` 表按**最大剩余深度**去重，**主节点 = 路径预算最强的那次到达**，灰节点 = 被它覆盖的其他到达（前端不得自算第二套）。灰节点不参与 token 统计与序号。
- **边与节点视觉**：实线箭头 = `requires` 且 `status=skeleton`（`display_tree` 主路径）；灰实线 = `requires` 且 `status=cross`（边生效但目标已被覆盖，对应 `cross_references`）；灰虚线 = `capped`（上游已到达但遍历深度用尽）；点线 = `related`（仅图示，不参与展开）；红虚线 = 位于依赖环内。节点角标显示 `position` / `depth` / 非 100 的 `group_weight`、起点徽标（`always` / `roster_any` / `manual` × `none` / `requires_closure` / `legacy_depth+N`）与问题徽标（停用 / 空正文 / 缺失）。
- **统计条与筛选**：顶部统计起点数 / 已在范围内 / 未被任何起点覆盖 / 依赖环 / 超深度边 / 隐藏节点数；筛选器支持分类、问题类型、只看起点与依赖闭包、只看本轮命中（依赖 `Prompt 预览` 结果）。点击节点在右侧属性栏看 uid、名称、分类、`position` / `depth` / `group_weight`、到达路径 breadcrumb、下游规模与问题列表。
- **只读**：不提供节点拖拽、画布平移缩放、框选、在图上连线、节点位置持久化；布局完全确定性，同一份输入永远同一张图。轨道条目 > 120 启用虚拟化；子树节点总数 > 400 时截断显示并提示「已隐藏 N 个下游节点，可用筛选或展开层级收窄」，**截断只影响显示，不影响真实候选**。
- **口径提醒**：轨道上的「先后」是**静态注入顺序键**，不是「本轮一定按此顺序全部插入」——每轮实际命中由关键词、概率与 token 预算决定；是否真的注入看 `Prompt 预览`。

**条目依赖逐层展开（`条目` 与 `分类与载入` 两处）**

- 列表行行首有折叠三角，**仅当存在 `requires` 出边时显示**（`related` 出边不算展开来源），旁挂出边数徽标；逐层缩进 16px 并有竖向导引线，默认展开 1 层。两处共用一个 `EntryDependencyTree`，展开状态互相独立，不改动列表本身的筛选与分页。
- 行内容：名称 + uid + 边关系徽标（`requires` 实线参与展开 / `related` 点线仅提示不可再展开）+ 条目状态徽标（停用 / 正文为空 / 不存在）+ `remaining`（该路径还剩几跳预算）。
- **重复到达**渲染为灰色行并标注「已在上层展开（路径：A → B → X）」，默认不再展开子树，另给「仍要展开（仅查看）」链接；**环**内边标红并标「依赖环」，服务端按最佳剩余深度终止，前端不自行截断。
- 工具条：「展开到 N 层」「折叠全部」「只看 requires（隐藏 related）」。固定说明行写明「这是**静态依赖关系**，不代表该条目本轮一定载入；实际候选看『分类与载入』，实际注入看『Prompt 预览』」。
- 展开行右侧可直接「＋加依赖 / －移除」，写入**统一草稿**，由页头一次 `PUT /api/worldbook/<id>/configuration` 保存；不做拖拽连线。

数据来源：节点视图读 `POST /api/worldbook/<id>/scope-preview`（`display_tree` / `resolved_edges` / `cross_references` / `issues` / `selection_reasons` / `active_roots`），依赖展开树读 `GET /api/worldbook/<id>/dependency-tree`（与 `display_tree` 同构）。两者都复用 `resolve_v3_scope` 的同一段 BFS（多源入队 + 按最大剩余深度去重 + 环终止），因此「条目页看到的依赖」与「分类与载入页看到的范围」永远一致。

导入策略使用草稿：预览通过后点击「保存策略」，也可「撤销草稿」。切换世界书或关闭页面时会提醒未保存策略。`分类与载入` 页签里的分类与归属动作也只修改统一草稿，右上角保存一次提交；旧书仅编辑分类不会自动启用 v3。

> **与 v3 的关系**：界面的主表述已经是 v3 的**起点**口径——起点 = `activation`（基础设定（所有会话候选） / 角色入队时选用 / 仅手动追加）× `expansion`（只含自身 / 补齐必要依赖 / 按旧深度展开 + N）。D-3 已把「固定导入 / 导入源」这套旧词汇从界面删除（分类结构不再渲染相关按钮与开关），它们**只在数据层作为 v2 兼容字段保留**：旧 `fixed_entry_uids` ↔ 起点 `always + none`、旧 `dependency_sources` ↔ 起点 `always + legacy_depth`，仅用于旧书读回与旧格式写回（`PUT /import-config`）的兼容解释。界面与后端读写的是**同一份统一草稿**，写回只替换这两类起点，`roster_any` / `manual` / `requires_closure` 这些条件起点（原先多由 AI 生成，现在由人工配置）原样保留；依赖边 ↔ `requires` 边，保存走页面的统一 `PUT /configuration`。

## 批量操作

批量操作只改**统一草稿**，因此和单点编辑共用同一条校验路径：改完由本页签右上角的「保存策略」（或工作台页头保存条）一次 `PUT /configuration` 落盘，期间可以「撤销草稿」。实现集中在 `utils/worldbookBatch.ts`（纯函数，不改入参）：`batchRoots`（批量设置 / 移除**起点**：`activation` + `expansion`，`legacy_depth` 带 0–32 深度）、`batchAddEdges` / `batchRemoveEdges`（建边 / 清边）、`batchMove`（批量归属）、`categoryEntryUids` / `knownUids`（分类条目 UID 与真实 UID 过滤）。UI 只负责收集 UID 与显示结果，不直接写盘。

**选中多个条目**（三种方式，可叠加）：

- 分类目录里每个分类行左侧的**复选框**：选中该分类及子分类下的**全部条目**（整棵子树一起选）。
- 条目归属表里每行左侧的**复选框**：逐条加入或移出批量选择，不影响侧栏的主选择。
- 条目归属表头部的「**全选当前列表**」：作用于**当前筛选后的归属表**（按当前搜索与分类筛选取 UID）。

选中的条目带对勾徽标，批量栏提示当前选中数量。批量选择会保留到这四种情况之一：点批量栏的「清除选择」、批量归属成功后（`runBatchMove` 会清空选择）、切换所选世界书、或该书重新加载后剔除已失效条目（批量依赖目标同理会被清空）。列表复选框是批量选择的唯一驱动方式。

**批量操作栏**（有选中时出现在工具栏下方）：

| 操作 | 说明 |
|---|---|
| 起点：激活方式 / 展开方式 | 下拉选择 `activation`（基础设定（所有会话候选） / 角色入队时选用 / 仅手动追加）与 `expansion`（只含自身 / 补齐必要依赖 / 按旧深度展开）；选「按旧深度展开」时出现 0–32 的深度输入框 |
| 设为起点 / 移除起点 | 批量写 / 删起点（`batchRoots`）；选「角色入队时选用」时需要在「条目与角色」里为条目选角色，否则保存会被拒绝 |
| 所选 → 目标 / 目标 → 所选 | 用下拉框选定目标后一次建立整批 `requires` 边；已存在的边与自环自动跳过并在提示里报数 |
| 清空所选依赖 | 删除所有一端落在所选条目上的依赖边 |
| 批量移入该分类 | 只改统一草稿（`batchMove`），与其它批量动作一样由页头一次 `PUT /configuration` 提交，**不调用旧的 `PUT taxonomy` 写接口** |
| 清除选择 | 清空批量选择 |

**分类级操作**：分类目录里每个分类行右侧的 `⋯` 菜单（分类属性侧栏同样有）提供「选中该分类下 N 个条目」「清空整类依赖」「聚焦并编辑该分类」——第一项把整类变成一次普通批量选择，随后的设起点 / 建边 / 批量归属都在批量栏里完成。

边界与安全：批量目标会先用真实条目 UID 过滤（未知 UID、空值、重复直接丢弃，`knownUids`）；自环边不生成；起点 `legacy_depth` 的深度裁剪到 0–32；批量归属沿用后端对角色分类的约束（角色分类的条目必须带角色关联，否则整次保存会被拒绝）。所有批量动作都不删除条目正文，也不改变载入模式。

## 候选范围

v3 书（`dependency_rules` 非空）按起点解析：

| 来源 | 进入候选的条件 |
|---|---|
| 基础设定 | 起点 `activation=always`；`expansion=none` 只含自身，`requires_closure` 补齐必要闭包 |
| 角色入队 | 起点 `activation=roster_any` 且 `character_ids` 与**实际成功加载的阵容**相交 |
| 必要依赖 | 从已激活起点沿 `requires` 出边遍历（`legacy_depth` 受 `max_depth` 限制） |
| 手动追加 | 会话创建时显式传入的 `manual_entry_uids`，只作用于该会话 |
| 全量兼容 | 会话创建时显式选择 `full_scope`，载入全部启用且有正文的条目 |
| 关联补充 | **不进入候选**，只作浏览 |

各来源取并集并按 UID 去重；停用、空正文条目不参与注入。预览会返回 `active_roots`、`resolved_edges`（含 `active` 与读时派生的 `status`：`skeleton` / `cross` / `capped` / `idle`）、`selection_reasons`、`display_tree`（含 `repeated` / `first_parent_uid` / `display_index`）、`cross_references`、`issues` 与 `draft_hash`。**v3 遍历只有服务端一处**，条目依赖展开与节点视图都读它的结果。

v2 书（未启用 v3）沿用旧语义（下表是**旧格式口径**，界面主表述已换成「起点 + `activation` / `expansion`」，见上）：

| 来源 | 进入候选的条件 |
|---|---|
| 世界观 | 条目所在分类的 `scope_type` 为 `worldview` |
| 入队角色 | `character` 分类下的条目关联了当前阵容的角色目录名 |
| 固定导入 | UID 在 `fixed_entry_uids` 中，仅包含自身，不隐式展开 |
| 依赖展开 | 从 `dependency_sources` 沿 `from_uid → to_uid` 出边遍历 |
| 旧书兼容 | `scope_mode=legacy` 时保留全部可用条目作为候选 |

**旧格式迁移是显式的**：v2 书在配置概览里会明确提示「仍使用旧版载入规则」，并把旧 `fixed_entry_uids` 等价呈现为 `always + none`、旧 `dependency_sources` 为 `always + legacy_depth`；**只有用户显式预览并点保存之后**才真正改用 v3 按需规则。已存在的 v2 会话语义不变。

每个依赖源有独立 `max_depth`，必须为 0–32 的整数：0 只包含源，1 包含一跳依赖，以此类推。自环、重复边和不存在的 UID 会被拒绝；多节点环允许存在，遍历用已访问的最佳剩余深度保证终止，并正确合并多个源。

角色关联使用角色目录名而非显示昵称；不存在的角色会在前端提示。只有匹配实际入队角色的关联才能随阵容载入。分类允许多层父子结构，子分类继承父类类型；父级缺失、分类环、重复 ID 和不兼容类型变更会被拒绝。`unclassified` 永久保留。删除分类必须明确迁移其子树条目，不会顺带删除正文。

## 会话与兼容

书数据 `schema_version` 为 2 或 3；v3 书另有 `dependency_rules`（起点）、`related_edges`、`policy_revisions`（不可变规则版本历史）。

- 普通外部酒馆文件没有本项目元数据时保持全量兼容；不根据名称猜测角色关联。预装整合包可按其可靠的生成器 UID 约定迁移。
- 旧会话首次注入时懒迁移为全量候选快照，之后新增条目不会自动扩大其范围。
- **v3 会话绑定的是完整规则版本**，不只是版本号：快照里保存当时的 `rules` / `requires_edges` / `related_edges`、解析器版本、阵容、手动追加、激活起点、候选 UID、选用原因、参与边与展示路径。书后来改了规则，会话按绑定版本重算仍得到创建时的结果；书被编辑后**不会**自动换语义。
- 会话创建会校验预览指纹 `expected_draft_hash`（覆盖规则、边、阵容、手动追加与是否全量兼容）：预览已过期时直接报错，而不是静默用另一套范围创建。
- **手动追加只作用于本会话**，不写回世界书规则；取消追加只影响这一次创建。取消追加一个「同时被必要依赖需要」的条目时，界面会明确说明它仍会被载入——**必需关系要用的条目不会因为取消追加而消失**。
- **全量兼容是显式选择**：`full_scope` 只影响本会话，不改变这本书的规则，也不会影响别的会话。
- 内容仍按**实时语义**读取：快照冻结的是规则与解析结果，不是条目正文副本；正文改动不会伪造「内容已完全快照」（原「正文改动 → AI 证据标记为过期」的口径已随 AI 构建一并移除）。
- 快照保存在会话 overlay 的 `worldbook_scope` 中；`resolved_entry_uids` 保留给原有消费者。导出会话时带上必要的规则版本。

### 会话级依赖微调

会话创建仍是纯本地操作，不调用 LLM。创建时把全局规则转换为一份独立快照；v2
书先在内存中做范围等价的 v3 映射，再把映射结果写入会话，书本身不会升级或保存。
旧会话第一次打开依赖面板时也按同样方式局部升级。

会话有效图的固定公式是：`inheritance - suppressed_edges + local_overrides`。
删除有效关系会同时删除本地覆盖并按 pair 屏蔽两种继承关系，因此刷新、角色入离队，
以及全局把同一 pair 从 requires 改成 related 后都不会复活；只有「恢复继承」会移除
屏蔽。本地关系优先于继承关系。requires 只有在来源起点采用
`requires_closure`（或本会话显式把该来源改为展开）时才会扩大候选范围；related
始终只供浏览。面板保存后展示服务端真实重算的 `resolved_entry_uids` 与原因。

「更新全局继承」分为预览和应用两步。预览绑定 `scope_revision + preview_hash`，列出
新增/删除关系与本地冲突；应用保留本地覆盖及屏蔽，冲突按 local wins 展示，不自动
改写用户选择。角色入离队的刷新在 overlay 锁内完成读改写，保留 manual/full_scope
与所有会话覆盖。

> **会话侧 AI 微调已移除（2026-09，提案 D-4）**：会话依赖面板只保留**纯本地**能力——人工增删 `requires` / `related`、屏蔽继承（`suppressed_edges`）、恢复继承、`inheritance - suppressed_edges + local_overrides` 公式与角色入离队刷新；原先「让模型分析会话候选并给出建议边」的独立任务目录、端点与入口一并删除。面板入口改到工作台 `分类与载入` 页签下。

- `SceneManager` 和 `CharacterAgent` 都按候选 UID 过滤，并继续遵守「常驻 position-0 进稳定层，触发型进动态层」的前缀缓存约束。
- 导出酒馆格式时，分类、导入策略和角色关联保存在 `extensions.arknights_tavern` 命名空间。复制与回灌保留这些元数据；其他客户端可以忽略该扩展。

## API 与实现

| API | 主要字段 / 行为 |
|---|---|
| `PUT /api/worldbook/<id>/taxonomy` | 完整 `categories`、按 UID 的 `entry_moves`、可选 `expected_revision`；校验及迁移原子应用 |
| `PUT /api/worldbook/<id>/configuration` | **统一写入**：`categories`、`entry_moves`、`entry_updates`、`scope_mode`、`roots`、`requires_edges`、`related_edges`、`expected_revision`。每书 RLock 覆盖「检查 → 提交」，版本不一致返回 409；草稿在锁内**并入**写入而非覆盖整书（v2 兼容字段 `rejected` / `edge_meta` 仍照原样透传，界面不再产生新值）。一次原子提交，不是把多次旧保存串起来 |
| `GET/PATCH /api/sessions/<session_id>/worldbook-dependencies` | 查看会话继承/覆盖/实际范围；按 CAS 新增、调整或屏蔽关系 |
| `POST .../worldbook-dependencies/restore` | 恢复单个 pair 或全部继承 |
| `POST .../inheritance-preview` / `POST .../inheritance` | 预览并显式更新本会话的全局继承版本 |
| `POST /api/worldbook/<id>/auto-classify` | 按条目元数据出分类方案；`apply=false` 只读预览，`apply=true` 写入分类树与条目归属（可选 `expected_revision`，冲突 409）。不改载入模式与依赖策略 |
| `PUT /api/worldbook/<id>/entries/<uid>` | 合并条目字段，支持 `category_id` / `character_id`，保留未提供字段及零值 |
| `PUT /api/worldbook/<id>/import-config` | v2 路径：`fixed_entry_uids`、`dependency_sources`、`dependency_edges`、`scope_mode`、可选 `expected_revision` |
| `POST /api/worldbook/<id>/scope-preview` | 接受完整草稿 / `roster_character_ids` / `manual_entry_uids` / `full_scope` / `policy_revision`；只读，返回 v3 解释字段（`resolved_edges` 含派生的 `status`，`display_tree` 含 `repeated` / `first_parent_uid` / `display_index`）与 `draft_hash`，不更新缓存/磁盘/会话 |
| `POST /api/worldbook/<id>/prompt-preview` | **新增（只读）**：单轮实际注入的文本、顺序与插入位置。请求 `mode`（`narrative` / `free`）、`input_text`、`recent_text`、`roster_character_ids`、`manual_entry_uids`、`full_scope`、`identity` / `active_char`、`seed`（默认 0）、`budget_tokens`、可选 `policy`；必须复用 `eligible_uids_for` → `collect_matches(rng=Random(seed))` → `format_injection` 同一条路径，**不写盘、不动候选缓存、不创建或修改会话、不污染全局 `random`**。返回 `order[]` / `stable_text` / `dynamic_text` / `sites[]` / `skeleton[]` / `dropped[]` / `totals` |
| `GET /api/worldbook/<id>/dependency-tree` | **新增（只读）**：`entry_uids=A,B` + 可选 `max_depth=N`，返回与 `display_tree` **同构**的依赖子树（`nodes` / `edges`（含 `status`）/ `cycles` / `issues`）；必须复用 `resolve_v3_scope` 的同一段 BFS，不新增第二套遍历 |
| `POST /api/sessions` | 现有创建参数加 `worldbook_id`、`roster_character_ids`、`manual_entry_uids`、`expected_draft_hash`、`full_scope`；201 时已完成候选快照 |

修订不一致返回 409，前端须重新加载，不能覆盖他人更新。删除条目会清理其固定项、依赖源、边引用，以及 v3 的 `related_edges` 与相关起点。

后端：`src/worldbook_scope.py` 负责纯校验与遍历（v2 与 v3 并存，v2 函数逐字保留）；`src/worldbook_classify.py` 负责条目自动分类（纯函数，只读条目元数据）；`src/world_book.py` 负责候选解析、预览、迁移、兼容、不可变规则版本与存储。

前端：`WorldBookManager` 是工作台容器（页签 `entries` / `load` / `prompt` / `nodes` / `index`，跨组件页签状态收敛为一套 `worldbookTab`）；`components/worldbook/tabs/LoadTab.tsx`（原 `WorldBookDependencyPage`）管配置概览 / 条目与角色 / 分类结构三个子视图；统一草稿与页头保存条在容器 `WorldBookManager` 里；`components/worldbook/tabs/PromptPreviewTab.tsx` 是三栏 + 骨架条 + 未插入区的 Prompt 预览；`components/worldbook/tabs/NodeViewTab.tsx` 是节点视图（虚拟化横向轨道 + 向下展开 + 灰节点 + 属性栏 + 与 `Prompt 预览` 联动）；`components/worldbook/EntryDependencyTree.tsx` 是两处列表共用的依赖展开树；`hooks/useWorldbookDraft.ts` 提供统一草稿（`draftFrom` / `rootsFromV2` / `buildSaveBody`）与两个预览钩子 `useScopePreview` / `useRosterScopePreview`（均带防抖 + 序号过时响应保护）——旧书的 `fixed_entry_uids` / `dependency_sources` 由 `rootsFromV2` 读成 `always` 起点（v2 兼容字段仍在），`buildSaveBody` 负责把草稿拼成统一保存体；`utils/worldbookNodeView.ts` / `utils/worldbookDependencyTree.ts` / `utils/worldbookPromptPreview.ts` 是三个页签的纯逻辑。图谱画布（`WorldBookGraphCanvas` 与 `utils/worldbookGraph.ts`）已整文件删除；节点视图沿用纯 SVG + DOM，不依赖额外图形库，也不改动战斗画布。

`utils/worldbookDependency.ts` **已整文件删除**（布局、节点角色分类与依赖树建模随画布一并移除）；批量策略变换等纯函数在 `utils/worldbookBatch.ts`。**遍历语义现在只有服务端一处**（`worldbook_scope.py` 的 `resolve_v3_scope`），条目依赖展开树与节点视图都读它的结果，前端不再复制第二套会话遍历。这些前端纯函数都不写盘、不改策略，只读 `WorldBookDetail` + 统一草稿（`WorldBookPolicyDraft` 仍作为按书 API 的 v2 形态保留在 `useApi.ts` 一侧）。`worldbook_classify.py` 同样不写盘：`from_dict` 的自动补齐与接口的显式应用都通过同一份方案，前者额外受「预装包 + 分类形同未分类」两个条件约束。

## 验证

统一入口仍为 `bash scripts/run_tests.sh`。范围与原子性回归在 `tests/test_worldbook_scope.py`；自动分类在 `tests/test_worldbook_classify.py`；v3 解析语义在 `tests/test_worldbook_v3_scope.py`（单角色不激活他人、被依赖带入不激活整组、共享依赖去重与离开阵容仍保留、related 不展开、环终止与交叉引用、三种展开方式与 v2 对齐、闭包不被静默截断、超限报错、manual 不自动激活、停用/空正文可解释、展示树确定性、v2→v3 映射）；统一写入 / 预览 / 创建会话在 `tests/test_worldbook_config_api.py`（原子写、409 保留草稿、非法写入不落盘、草稿并入写入、v3 解释只读、单角色与手动追加、`draft_hash` 稳定与阵容敏感、会话绑定规则版本、预览过期拒绝、全量兼容一致性、手动追加的会话作用域）。

会话依赖专项在 `tests/test_session_worldbook_dependencies.py`：继承/覆盖/屏蔽恢复、
角色刷新、schema2 局部升级、全局更新冲突、跨会话隔离、保存重载与并发门禁（会话侧
AI 微调任务相关的 stale / 取消 / 预算中断恢复 / scoped LLM 用例已随提案 §2.4 删除）。

前端纯工具与真实 React SSR 检查可单独运行两个脚本：`node scripts/test_worldbook_scope_ui.cjs`（分类树工具 / 批量起点与依赖与归属 / 候选范围预览 / 分类结构 SSR / 工作台页签骨架，以及依赖展开树与 Prompt 预览的纯函数与 SSR 断言）与 `node scripts/test_worldbook_node_view_ui.cjs`（**节点视图**：轨道排序键、灰节点去重口径、确定性布局、规模截断、六项统计、五种边视觉的纯函数与 SSR 断言）。节点视图断言单独成文件，是为了让两个前端单元不再争同一个脚本（`test_worldbook_scope_ui.cjs` 保留分类树 / 批量 / 依赖展开树 / Prompt 预览的断言）。前端构建在 `frontend/` 运行 `npm run build`。

> AI 构建的真实模型验证脚本 `scripts/verify_worldbook_builder_llm.py` 已随该功能删除（同批删除的还有 `scripts/benchmark_worldbook_builder.py` 与 `scripts/benchmark_worldbook_selective_reading.py`）。Prompt 预览与依赖展开的验收改为确定性用例：同输入两次请求**字节一致**、`dropped.reason` 九类覆盖、零写盘（请求前后书文件哈希与 mtime 不变）、依赖树与 `display_tree` 同构、灰节点去重口径与 `best` 表逐条一致。

SSR 与 stub 都不代替浏览器验收。浏览器还需验证：五个页签的切换与跳转（内容中心检索命中 → 工作台 `条目`，会话侧 → `分类与载入` / `本家索引`）、切换世界书或资料库时的页签归一、保存失败与 409 后草稿仍在、配置概览的试选阵容与范围预览联动、条目与角色的四个动作、条目页与分类与载入页两处的依赖逐层展开（灰行、环、`related` 不展开）、Prompt 预览的三栏与未插入原因分区、节点视图的轨道顺序 / 灰节点 / 筛选 / 与 `Prompt 预览` 联动，以及会话向导阵容步骤的候选树与手动追加取消。

> Windows 中文环境下 `pytest tests/` 有 4 个战斗用例会因 subprocess 按 GBK 解码中文输出而失败（`stdout is None`）。加 `PYTHONUTF8=1` 后全过；这与世界书无关，属工作区环境问题。


## 2026-09-15 返修后的执行与恢复边界（AI 构建相关条目已于 2026-09 随提案 §2.4 移除）

- 所有按书 API 读改写路径共享每书锁，包括旧条目/分类/导入策略、统一配置与导出刷新。旧接口在锁内读取最新副本；统一配置同时校验修订，失败保留草稿。
- v2 普通保存继续使用 v2；显式迁移等价保留 worldview、roster、fixed、旧深度 sources。v3 的 legacy 开关仍选用全量。会话入/离队直接使用会话内嵌规则，不依赖书的历史列表仍保留对应版本；v2 会话不会自动升级。
- 手动追加作为临时根参与同一次必要依赖遍历，产生树、原因与问题信息。related 边保存在项目扩展中；「人工锁定 / 拒绝记录 / 正式边证据」是 AI 构建时代的字段，**停写不删**——旧书里的值照常透传与载入，界面不再产生新值。
- 高级分类、归属、角色关联均可统一撤销；切书提供保存 / 放弃 / 取消。（原「按书恢复最近/活跃任务、拒绝同书重复构建、切视图不需重建付费任务」的 AI 构建口径已随之移除。）

浏览器回归：`scripts/test_worldbook_review_ui.cjs` 使用真实 Chromium 和生产 React 组件、确定性 API 响应，覆盖默认落在 `条目` 页签、空转预览必须停下来、分类结构里的分类与归属改动不调用旧写接口、保存 409 后草稿跨页签与跨子视图完整保留（且不再下发 AI 构建字段 `proposal`）、切书三选一对话框与撤销回基线、已删除接口不再被调用。需要本地 Vite web server 与 Playwright；`WB_UI_URL`、`PLAYWRIGHT_MODULE`、`WB_BROWSER` 可指定运行环境。生产 Flask/SceneManager 和真实全书结构验证分别见 `tests/test_worldbook_config_api.py`、`tests/test_worldbook_scene_scope.py`、`tests/test_worldbook_review_fixes.py`。

> 原「全书 stub 验证只证明结构 / 覆盖 / 预算与断点」「6 条样本 2 次真实调用、缓存再跑 0 次」等 AI 构建验收记录已随提案 §2.4 删除，不再是现状依据。
