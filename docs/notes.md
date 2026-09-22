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
