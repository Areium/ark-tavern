# 文档阅读索引

按要完成的任务选择文档。当前操作与接口以源码及专题说明为依据；提案、测量和档案保留各自的日期、版本与验证条件，不能直接当作当前产品能力。

> 最近整理：2026-10-11；主体源码核对基线：`7344cea`，节点详情与精确轮次回档另同步至主线 `0abfee7`。
> 本轮是文档整理与静态事实核对，未重跑所有历史测试、真实模型或桌面验收。

## 从这里开始

| 读者任务 | 文档 |
|---|---|
| 首次启动并完成第一段故事 | [入门教程](tutorial.md) |
| 找模块职责、数据位置和实现入口 | [系统架构](architecture.md) |
| 排查约定、环境问题和未解决边界 | [工程笔记](notes.md) |
| 追溯某次变更 | [系统更新记录](system-update-log.md) |
| 理解卡牌战斗表现的历史验收 | [第一轮表现 QA](card-combat-presentation-qa.md) |

## 专题说明

每篇分别说明现状、保留的设计目标与已知限制；不能只根据目录名称判断是否落地。设计约束也不等于已经完成对应运行验收。

| 范围 | 阅读入口 |
|---|---|
| 前端规则与 PC 验收 | [前端设计避坑清单](design/frontend-design-guidelines.md) |
| 内容管理的现有入口与设计背景 | [内容中心设计](design/content-hub-design.md) |
| 会话数值与面板扩展 | [会话场景插件](design/session-scene-plugins.md) |
| 世界书类型与组织 | [世界书库](design/worldbook/worldbook-library.md) |
| 加载、触发及范围 | [按需加载](design/worldbook/worldbook-on-demand.md)、[节点作用域加载](design/worldbook/node-scoped-worldbook-loading.md) |
| 背景与 CG | [节点演出](design/worldbook/node-presentation.md) |
| 叙述与结构化提取 | [两阶段叙述](design/narrative/two-phase-narration.md) |
| 提示词分层 | [Prompt 结构](design/narrative/prompt.md) |
| 向量记忆检索 | [RAG 检索](design/narrative/rag-retrieval.md) |
| 作者声明的选择与后果 | [剧情规则](design/narrative/story-rules.md) |
| 战斗流程与接口 | [网格战斗设计](design/combat/combat-design.md) |
| 战斗数值与成长 | [数值设计](design/combat/combat-numerical-design.md) |
| 战斗页面与交互 | [战斗 UI](design/combat/combat-ui-design.md) |
| 创建及校验战斗内容 | [BattleSpec 规格](design/combat/battle-spec.md) |
| 横版玩法 | [横版战斗](design/combat/sideview-combat.md) |

## 提案与实施边界

提案可能同时保存已落地部分和待实现目标，阅读时先看状态说明。这里的验收标准是放行条件，不代表检查已经执行。

| 主题 | 文档 |
|---|---|
| 当前 iframe 脚本玩法与原始方案 | [可安装战斗模式](proposals/combat-mode-plugins.md) |
| 后续原生插件、统一存档与信任边界 | [本地单机插件精简方案](proposals/local-plugin-minimal-plan.md) |
| 战斗数值与成长曲线演进 | [成长曲线提案](proposals/combat-value-curve-redesign.md) |
| 世界书条目界面 | [条目刷新方案](proposals/worldbook-entry-refresh.md) |
| 工作台结构、演进与剩余范围 | [工作台重构方案](proposals/worldbook-workbench-redesign.md) |
| 全项目投入方向与验收建议 | [2026-09-28 优化方向](proposals/project-optimization-directions-2026-09-28.md) |

本地插件的 `task.md` 是被 Git 忽略的本机队列。继续实施前核对权威副本、分支和工作区；它的进度不自动代表主线代码或本轮文档验证结果。

## 测量与历史档案

历史路径、API、默认值及未完成事项只表示当时状态；失效的历史源码路径以文字保留。档案不会自动生成当前待办，旧测试数量也不能计入当前验收。

| 主题 | 记录 |
|---|---|
| 每轮延迟测量 | [性能记录](perf/perf-round-latency.md) |
| 被替代的统一插件计划 | [2026-10-08 前的阶段记录](archive/unified-plugin-plan-before-local-2026-10-08.md) |
| 脚本插件 PC 验收 | [2026-10-06 QA](archive/combat-plugin-pc-qa-2026-10-06.md) |
| 横版工作交接 | [2026-09-28 交接](archive/sideview-handoff-2026-09-28.md) |
| 世界书构建与性能 | [构建性能记录](archive/worldbook-builder-performance.md)、[旧选择性阅读方案](archive/worldbook-selective-reading.md) |
| 旧战斗核心 | [核心设计](archive/combat-core-design.md)、[战斗背景提示词](archive/combat-background-prompts.md) |
| 角色卡重构 | [进度记录](archive/character-card-rewrite-progress.md) |
| 历史冗余分析 | [2026-09-12 扫描](archive/redundancy-scan-2026-09-12.md) |
| 风雪过境内容设计 | [设计记录](archive/2026-08-06-fengxue-guojing-design.md)、[实施计划](archive/2026-08-06-fengxue-guojing-plan.md) |
| 历史讲解图（HTML） | [两阶段叙述](archive/two-phase-narration.html)、[RAG 检索](archive/rag-retrieval.html)、[战斗嵌入](archive/combat-embedding.html) |

`images/` 保留教程截图，是否属于当前界面由正文及相邻图注说明。`verification/` 中的 JSON 是历史验证数据，不是写作说明或当前运行结果；本轮保留其原始内容，不因文档整理重生成数据或截图。
