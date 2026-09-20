# 2026-09-20 剧情重设计与功能验收报告

## 结论

**剧情设计与本轮审计已交付，项目尚不能判定为“完整剧情体验验收通过”。**

新剧情 [《灰桥回声》](../scenarios/greybridge-echoes/README.md) 包含 5 章、12 节拍、5 个任务、
2 场可避战遭遇和 3 个互斥叙事结局。现有基础测试通过，但新增验收复现了 8 项产品缺陷/功能缺口；
真实模型 18 轮仅完成 3/12 节拍，不能用 HTTP 成功或脚本化走通代替完整实玩。
另记录节奏可靠性和战斗难度两项体验问题，修复方案见下文。

本次仅新增候选剧情、测试工具、用例和文档，**没有实施运行时修复，也未向正式内容库注册候选**。
候选测试、存档导入、环境与角色修改均使用隔离数据；用户原有存档不在测试范围内。

## 版本、环境与证据口径

- 被测生产基线：`a049ae1`；工作分支：`feat/story-audit-20260920`，隔离 worktree 开发。
- Windows / PowerShell，项目现有 Python 和前端依赖；`bash` 指向缺少 `/bin/bash` 的 WSL，
  使用统一测试入口的等价 PowerShell 命令，不将启动 bash 失败记作测试通过。
- 已完成的 656 用例基线、4 个 legacy 脚本、前端构建、120 次模拟、18 轮真实模型均复用原证据，
  未重新进行整轮测试。后续只针对新增/修正的验收工具进行定向复核。
- 基线世界书测试使用当时本机 `data/worldbooks` 的隔离副本；剧情真实模型测试则从
  版本化 `data/packs` 在临时目录全新安装 `arknights`，不是用户已编辑世界书或存档。
- 持久证据：[统计与用例结果](evidence/greybridge-audit-summary.json)、
  [18 轮真实模型原始结果](evidence/greybridge-real-llm.json)。后者含文本、分支、提取标记和 token 用量，
  不含 LLM 配置/API 密钥。临时 JUnit 文件名也记录在统计文件中。

“通过”仅指表中范围；`xfail` 是**已执行并复现的失败**，不是跳过检查，更不是功能已修好。
新增用例只把专门的 `KnownProductGap` 异常作为预期失败；夹具异常、意外 TypeError 和普通断言失败仍报错。
测试开发时曾发现离线夹具误把 `get_llm()` 的 `(llm, provider)` 返回约定写为 `None`；
修正后重新验证持久化相关用例，早期失败不作为产品问题。没有用调低断言掩盖该错误。

## 已执行验证

| 层次 | 实际结果 | 能证明什么 / 不能证明什么 |
|---|---|---|
| 现有后端统一入口范围 | 656 passed，2 warnings，约 178.89 秒 | `tests/` + 5 个无外部依赖 perf 文件；不包括所有付费模型、向量服务或所有 `perf_tests/` |
| Legacy | 4/4 脚本退出 0 | API/导入/身份开场的历史脚本口径；示例配置探测有 401 日志，不是真实模型通过证据 |
| 前端 | `npm run build` 成功 | TypeScript、renderer 和 Electron bundle 构建；不是桌面 UI 已实测 |
| 节点图非浏览器检查 | `node scripts/check-node-graph.mjs` 全部通过 | 坐标变换、拖动计算、布局重置、节点工厂、错误分类、抽屉宽度和 localStorage 逻辑 |
| 新增验收 | 10 passed、8 xfailed | 确定性剧情与 API 检查；已知失败列表见 QA-01～08 |
| 战斗结构 | 两候选均校验通过 | 字段/绑定/地图/敌人可被生产加载器接受，不代表最终平衡 |
| 战斗模拟 | 2 节点 × 2 队伍 × 30 种子 = 120 次 | 真实引擎模拟，不是浏览器操作，也不是候选奖励已全链路结算 |
| 真实 LLM | 18/18 HTTP 200 且非空；3/12 节拍完成；退出 1 | 项目 `LLMBackendManager.get_llm()` 的 `deepseek-v4-flash` 实际叙述与提取；完整剧情未通过 |

Legacy 文件：`api_integration.py`、`full_import_flow.py`、`player_identity_opening.py`、`repro_card_import.py`。
最后一个脚本中的陈旧诊断文案不能自动当作现存缺陷，以当前断言和退出结果为准。

警告记录：protobuf metaclass 的 Python 3.14 兼容弃用提示；Vite CJS 弃用提示；
主 bundle 约 656 kB、超过 600 kB 提示阈值。当前不阻止构建，分别纳入依赖升级和拆包计划。

## 功能矩阵

| 功能 | 结论 | 证据与限制 |
|---|---|---|
| 剧情解析、五章十二节拍、任务列表、战斗绑定 | 通过 | 候选解析用例使用生产解析器核对完整 ID 集合 |
| 会话创建、显式空/单人/去重阵容、玩家身份排除 | 创建时通过 | 新增参数化用例；重载空阵容失败见 QA-05 |
| 开场环境 | 通过 | 地点/时段与正文配置一致；上下文边界失败见 QA-01 |
| 非流式叙述接口 | 可用但完整流程不通过 | 18 轮真实模型 + 确定性 API 用例；节拍节奏见 QA-09 |
| 12 节拍顺序推进 | 脚本化通过 | narrative / tactical 两种模式；脚本只替换 LLM 边界，不是真实模型通关 |
| 战前简报与协商避战 | 脚本化链路通过 | 两节点走真实 `negotiate` 避战路径；未伪造战斗胜利 |
| 战斗开场、结束回合、战斗中禁止叙述 | 通过 | 实际 API 和引擎；叙述返回 423 |
| 战斗暂离、恢复 | 通过 | 执行实际回合后 suspend/resume，比对状态，不只比较初始空状态 |
| 地图/地形/状态效果/卡牌/AP/成长数值 | 现有回归通过 | combat、map、terrain、deck、growth、黄金模拟与 perf 用例；非全角色平衡证明 |
| 候选战斗胜利→奖励→重复结算→继续剧情 | 未完整实测 | 现有结算单测通过，但新剧情没有执行这一整条 API 路径；不能推定急救包发放正确 |
| 任务查看与手动状态更新 | 正常路径通过 | 手动 active/completed + 导出；非法 ID 接受见 QA-06 |
| 自动任务进度、自动完成 | 不通过 / 功能缺口 | QA-02；真实模型文字完成不更新任务状态 |
| 环境/物品/角色会话覆盖 | 部分通过 | 环境与角色覆盖不串会话；实体目录物品可加入；平铺物品失败见 QA-07 |
| 剧情树生成、范围快照及一般回滚 | 现有回归通过，特定契约失败 | QA-04：回滚后分支目的地丢失，不能据其他回滚用例通过认定完整正确 |
| 叙述变体生成 | 脚本化通过 | 生成返回备选文本，不提交新轮次；未额外做真实模型变体生成 |
| 叙述变体选择/保存 | 不通过 | QA-08：按前端真实 payload 返回 500 |
| 会话导出→同库导入 | 通过 | 新 ID，保留模式、阵容、环境、任务、节拍、角色覆盖、历史、剧情树；原会话保留 |
| 跨机器无依赖存档分享 | 未验证 | 同库往返不证明剧情/世界书/媒体等依赖全部自包含 |
| 世界书导入导出、分类/作用域/依赖/选择性读取 | 现有回归通过 | 对应 worldbook 系列、lore binding、scope rollback 用例；非全书付费语义评价 |
| 角色卡导入、JSON 卡牌往返 | 现有回归通过 | `test_character_card_import`、`test_card_json_roundtrip` 及 legacy |
| LLM 错误、后端复用 | 现有回归通过 | `test_llm_client`、`test_llm_backend_reuse`；未对所有真实服务商故障做注入 |
| 单角色聊天、群聊、SSE、回忆摘要生成 | 本轮未做独立真实模型验收 | 不用非流式叙述成功替代这些入口的结果 |
| 向量记忆、embedding、全书付费评价 | 未执行 | 不在无外部依赖统一入口范围内 |
| 浏览器/Electron、主题、Spine、音效、拖放视觉 | 未执行 / 工具受阻 | 构建和非浏览器计算检查不能证明实际音画或交互正常 |

## 问题与修复方案

优先级：P1 阻碍核心体验、产生静默状态丢失或误导；P2 次要功能/兼容性/体验问题。
这是复现结果与建议清单，不是修复完成清单。

| 编号 | 级别 | 复现与影响 | 定位 / 修复方案 | 修复验收 |
|---|---|---|---|---|
| QA-01 | P1 | 新建后 `get_plot_context()` 的开场设置包含 `beat_gb_epilogue` 和后续章节，有剧透与提示膨胀风险 | `session_overlay.py:1879` 标题边界正则只匹配冒号后空白的章节标题；统一识别带正文标题的 `章节 N：标题`，不要只改这份剧情绕过 | 带标题、空标题、嵌套任务标题的边界用例；开场上下文无后章/尾声 |
| QA-02 | P1 | 叙述明确宣布 M1-1 完成后仍为 hidden；真实模型 18 轮五任务全 hidden | 任务初始化与 narration 提取/提交之间缺少自动状态链路；新增带合法 ID/转换校验的结构化任务事件，同轮事务落盘、UI 刷新，回滚同步恢复 | 自动激活/完成/失败、非法转换、重试幂等、回档与重载均一致；不能从任意一句文字直接发奖 |
| QA-03 | P1 | 最后一节执行 `advance_beat()` 后仍保留为当前节拍 | `session_overlay.py:508` 的末尾分支只重置计数；引入明确 completed/ending 状态，完成后停止默认续写，后日谈由主动操作进入 | 最后一次完成只提交一次，重载保持终态；重复继续不新增任务或重复结算 |
| QA-04 | P1 | 带 `target_beat_id=beat_gb_power` 的分支经剧情树回滚后丢失目的地 | `_attach_tree_branches()` 与树恢复的数据契约遗漏目标；序列化、快照、恢复统一保留 canonical ID/目标/来源，并兼容旧档 | 发出→选中→保存→重载→回滚后目标一致，旧档无目标仍可继续 |
| QA-05 | P1 | 显式 `roster_character_ids=[]` 创建为零人，重载补入四名初始角色 | `Session._restore_scene():220` 把空数组与旧档字段缺失合并处理；区分字段缺失和显式空集合，只给旧档做兼容兜底 | 空、单人、去重、非默认玩家身份重载一致，不偷偷补角色 |
| QA-06 | P2 | PATCH `quests/does-not-exist` 返回 200 并写入新状态 | `blueprints/environment.py:232` 仅校验状态枚举；校验任务属于绑定剧情，再检查合法转换 | 不存在 ID 返回 404，内存/磁盘无变化，正常管理操作仍可用 |
| QA-07 | P2 | `急救包.md` 被列出，`items/add` 却返回 404；实体目录形式的战术终端可用 | `DocumentManager._resolve_path():683` 只拼 `<id>/index.md`，与列表支持两布局不一致；统一 resolver 支持平铺/实体并保留路径边界与 hash 冲突保护 | list/get/edit/add/delete 两布局一致，拒绝越界；补急救包结算入包验证 |
| QA-08 | P1 | 发送前端 `{round:1,narrative:...}` 到 `narrate-update` 返回 500；界面 `.catch(() => {})` 吞错 | `chat.py:896` 读取 `text` 并只传一个参数，`Session.update_narration(round_num,narrative)` 需两个；统一 API，校验轮次/文本，失败显示且回退 UI | 选择旧轮变体只改目标轮，重载保留，其他轮不变；非法轮次返回结构化错误 |
| QA-09 | P1 | 真实模型 18 轮只完成 3/12 节拍；两个节点长时间反复，接口本身均成功 | 提取提示把自然段落结束当节拍完成，未使用明确验收条件；向提取器提供当前节拍目标/证据，校验完成原因，审查计数兜底和分支落点；结合 QA-01 缩减无关上下文 | 完整路径多次真实模型测试，记录完成集合、每节轮数、token 与错误；不靠盲目增加总轮数或跳过未完成节拍 |
| QA-10 | P2 | 四组战斗模拟胜率均 100%，血损仅 3.7%～14.4%；普通战压力偏低 | 优先改站位、波次和敌人组合；保持道路可通、可撤退；不要用全局敌人数值改动掩盖局部编排问题 | 固定种子复测 + 人工试玩；普通战胜率/血损/回合达到设计目标再审阅入库 |

QA-01、02、03 是直接状态/上下文验收，不宣称已经穷尽所有旧剧情格式或所有 LLM 回复。
QA-09 是本次模型、候选、动作与 18 轮预算下的实测结论，不能推导成“任何剧情都永远无法完成”。
协商前置条件、独立护送单位、自动结局执行器属于明确的当前能力边界，不伪装成候选已实现功能。

## 真实模型记录

调用项目真实后端 `deepseek-v4-flash`，叙述与结构化提取均非 stub；使用预装 `arknights`。
18 次 HTTP 响应均为 200 且叙述非空，回合耗时中位 **3.2655 秒**；该延迟是整轮接口耗时，不是首 token 延迟。

| 回合 | 当前节拍与结果 |
|---|---|
| 1～8 | arrival；第 8 轮标记完成后进入 triage |
| 9 | triage 完成，进入 witness |
| 10～17 | witness 长时间未完成；第 17 轮标记仍为 false，但计数兜底推进至 manifest |
| 18 | manifest 尚未完成；预算结束 |

访问 4 个不同节拍，完成 3 个，余 9 个未完成；没有到达候选战斗，没有终态，五任务仍 hidden。
实际记录用量：prompt **520,090**、completion **6,971**、合计 **527,061 tokens**。
不把这些 token 全部归因于 QA-01：还包含角色、世界书、历史和提取请求，本轮没有做分层成本归因。
没有继续重复付费尝试来掩盖未完成；下一轮应先修状态/提示契约再验证。

运行后该临时会话已清理，保留的是结果记录，不能声称可以从同一临时会话继续。
交付脚本已进一步收紧成功条件：只有完整期望节拍、期望任务完成和终态同时成立才退出 0；
仅节拍走完仍有产品缺口时退出 1。该检查是保守的全完成路径，不代替三结局分别验收。

## 战斗测试记录

固定种子基数 `20260920`；每组 30 次，`standard` / `low` 为模拟工具预设队伍。

| 节点 / 队伍 | 胜率 | 中位 / P90 回合 | 血损 | 首回合清场 | 每轮移动 AP |
|---|---:|---:|---:|---:|---:|
| gate / standard | 100% | 4 / 5 | 3.7% | 0% | 3.73 |
| gate / low | 100% | 5.5 / 6 | 12.7% | 0% | 2.35 |
| evacuation / standard | 100% | 7 / 8 | 5.4% | 0% | 3.65 |
| evacuation / low | 100% | 8 / 9 | 14.4% | 0% | 2.56 |

`pass=true` 只说明本次 CLI 阈值没有触发，不代表满足 skill 对普通战压力的全部建议。
候选 gate 预算 3.2/T1；evacuation 实际 5.8/T1，已改正早期 6.4/T2 声明。
standard 的旧 JSON 保留原声明作为历史证据；未改变地图/敌人/波次/数值，未开启阶段带缩放，
所以不为这个元数据校正重复 30 次模拟。后续真正改编排则必须重测。

## 修复实施顺序与验收门禁

1. **先恢复用户操作可信度**：QA-08 保存合同、QA-05 显式空阵容、QA-01 开场边界，随后 QA-06/07 输入与资源兼容。
2. **再建立剧情状态闭环**：QA-02/03/04 统一节拍、任务、结局和分支的落盘/重载/回滚；重试只提交一次，不重复奖励。
3. **再校正模型推进与成本**：QA-09 明确完成判据，按实际 renderer 记录各层 token；完整路径与三种结局分别真实回归。
4. **最后定内容与前端体验**：QA-10 调整编排，补候选奖励幂等链路和 GUI 验收，人工审阅后再注册剧情。

修复后的门槛不是“pytest 退出 0”：应去掉对应 xfail 并得到真实通过，保持基线回归，
完成真实模型主干和结局验证，同时解决或明确签收 GUI/向量记忆等未验证项。

## 复现命令

在仓库根目录（不是 `frontend`）执行，真实模型命令会产生用量。以下是复现说明，不代表本轮重复运行了基线。

```powershell
$env:PYTHONUTF8='1'
$env:PYTHONIOENCODING='utf-8'
python -m pytest tests/ perf_tests/test_combat_runtime_v1.py perf_tests/test_combat_data_v1.py perf_tests/test_settlement_v1.py perf_tests/test_card_json_roundtrip.py perf_tests/test_cv_budget.py -o addopts='' -q
$env:PYTHONPATH=(Join-Path (Get-Location) 'src')
Get-ChildItem tests/legacy/*.py | ForEach-Object { python $_.FullName; if ($LASTEXITCODE -ne 0) { throw $_.Name } }
python -m pytest tests/test_greybridge_acceptance.py -o addopts='' -q -rxX
python scripts/verify_story_acceptance.py --config config/llm_config.json --out .tmp/story-audit/live.json --max-rounds 18
python tools/validate_battle_spec.py docs/scenarios/greybridge-echoes/battles/enc_gb_gate.json
python tools/validate_battle_spec.py docs/scenarios/greybridge-echoes/battles/enc_gb_evacuation.json
python tools/simulate_battle.py --spec docs/scenarios/greybridge-echoes/battles/enc_gb_gate.json --runs 30 --team standard --seed-base 20260920
node scripts/check-node-graph.mjs
```

另外对 evacuation 与 low 队伍组合执行同样的模拟命令；前端构建命令 `npm run build` 的工作目录是 `frontend`。
安装本次新用例后全套计数会增加，不能继续把旧 656 计数当成新 HEAD 整套运行的结果。

## 未完成验证与工具限制

浏览器工具与本地记忆 MCP 曾被审批服务以不支持 `codex-auto-review` 的 404 拒绝；
没有改用旁路自动化、CLI 或配置修改绕过拒绝。GUI/原生 Electron 验收未执行，不能标绿。
独立子代理尝试未获得可交付审查结果，本报告依据主代理的本地检查与上述实测证据，
不声称完成了独立多人评审。没有写入全局记忆或自动接受候选规则。

项目可继续在已验证范围内开发和使用，但在 P1 状态问题、真实完整流程和 GUI 验收完成前，
不应以这份报告批准“完整剧情功能全部正常”或直接将候选作为最终版本发布。
