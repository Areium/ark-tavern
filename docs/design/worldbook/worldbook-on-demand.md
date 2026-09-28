# 世界书按需载入（当前契约）

本文记录 Ark Tavern 当前使用的内部世界书与会话范围契约。历史迁移方案不再是运行时能力；
内部文件和会话快照只接受 schema v3。SillyTavern Lorebook v1/v2 与角色卡仍是受支持的
外部导入格式，导入时会立即归一化为本文所述结构。

## 1. 数据边界

- 内部世界书必须同时满足 `schema_version: 3` 与 `scope_mode: "selective"`。
- 每本书保存 `dependency_rules.roots`、顶层 `dependency_edges`（必要依赖）和
  `related_edges`（仅供浏览）。
- 会话只保存 `worldbook_ids[]` 与 `worldbook_scopes{}`；首本书是顺序派生值，不另存单数字段。
- 不支持旧内部 schema、旧会话范围、全量兼容开关、有限深度展开或隐式默认世界书。
- 无绑定书的会话不注入任何世界书内容。

仓库内分发包必须直接符合当前 schema。检测到本机同名安装副本不符合当前 schema 时，
示例页提供显式的「备份并修复」：先写入 `*.unsupported-schema-*.bak`，再从当前分发包重装。

## 2. 分类与载入规则

分类只负责组织，不决定条目是否进入候选。候选由起点和有向依赖图决定。

每个起点包含：

- `entry_uid`：书内有效条目 UID；同一 UID 只能有一个持久化起点。
- `activation`：
  - `always`：所有绑定该书的会话都激活；
  - `roster_any`：阵容命中 `character_ids[]` 时激活；
  - `manual`：仅在本次会话显式追加该 UID 时激活。
- `expansion`：
  - `none`：只纳入起点自身；
  - `requires_closure`：沿必要依赖求完整闭包。

`requires` 边参与闭包；`related` 边只用于工作台浏览。解析器必须：

- 对多起点与多路径去重，保留稳定主路径和交叉引用；
- 正确终止环；
- 在闭包超过保护上限时返回 `closure_too_large`，不得静默截断；
- 把停用、正文为空和缺失条目写入可解释的问题列表；
- 只把启用、有正文且非系统层的候选交给实际注入。

## 3. 外部导入

`parse_lorebook` 继续识别：

- SillyTavern Lorebook v1；
- SillyTavern Lorebook v2；
- Character Card v1/v2 中的内嵌世界书；
- 支持的 JSONL 聊天备份。

标准 SillyTavern 数据没有本项目规则扩展时，每个导入条目生成 `always + none` 起点，
因此仍由条目自己的关键词、常驻、概率、位置与预算语义决定是否真正注入。只有扩展明确声明
`schema_version: 3` 时才回灌本项目的分类、起点和依赖图；其它内部版本字段不参与兼容解释。

导出保持 SillyTavern v1 主体，并在 `extensions.arknights_tavern` 中携带当前项目扩展，
用于 Ark Tavern 之间的当前格式往返。

## 4. 会话快照

创建会话时，每本绑定书各自生成 v3 快照并存入 `worldbook_scopes[book_id]`。快照包含：

- 内容与规则修订；
- 创建时使用的完整规则与必要/关联边；
- 阵容和手动追加 UID；
- 已解析 UID、参与边、选择原因、展示树与问题列表；
- 会话局部依赖覆盖与继承基线。

角色入队、离队或换主控后，基于该快照中的当前规则刷新范围；不会读取历史 schema 或扩大为全书。
会话依赖编辑只改会话局部覆盖，不回写全局书。

## 5. 注入纪律

候选范围只是第一道过滤，实际单轮注入仍遵循 Lorebook 的关键词和预算语义：

1. `eligible_uids_for` 读取会话对应书的 v3 快照；
2. `collect_matches` 在候选内执行常驻、关键词、选择性、概率、大小写、全词与分组规则；
3. `format_injection` 按位置生成稳定层与动态层文本；
4. 系统层条目永不进入候选、顺序或 token 统计。

常驻 position-0 条目进入稳定层；触发型条目一律进入动态层，以保持前缀缓存稳定。

## 6. 当前 API

| API | 用途 |
|---|---|
| `PUT /api/worldbook/<id>/configuration` | 原子保存分类、角色关联、起点与两类边，带修订冲突检查 |
| `POST /api/worldbook/<id>/scope-preview` | 只读解析候选范围与草稿指纹 |
| `POST /api/worldbook/<id>/prompt-preview` | 只读运行一轮真实匹配与预算，返回注入文本、顺序和丢弃原因 |
| `GET /api/worldbook/<id>/dependency-tree` | 返回完整必要闭包、稳定主路径、交叉引用、环和问题列表 |
| `PUT /api/sessions/<session_id>/worldbooks` | 用 `worldbook_ids[]` 更新多书绑定并返回 `worldbook_scopes{}` |
| `POST /api/sessions` | 用 `worldbook_ids[]`、`manual_entry_uids_by_book{}` 与 `expected_draft_hashes{}` 创建会话 |

已移除的旧写入口不提供别名或 410 占位路由。

## 7. 修改与验证

修改规则契约时至少验证：

- 当前 v3 书的读取、保存、复制、导出和再导入；
- SillyTavern Lorebook v1/v2 与 Character Card 导入；
- `none`、`requires_closure`、多起点、菱形、环、闭包超限和 related 不展开；
- 多书会话的独立快照、阵容刷新和局部覆盖；
- Prompt 预览与真实注入使用同一候选口径；
- 后端 pytest、前端 TypeScript/Vite 构建与相关纯函数脚本。
