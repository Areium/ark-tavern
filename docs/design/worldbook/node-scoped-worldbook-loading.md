# 节点级世界书动态载入 — 实现说明

节点绑定在会话候选范围内进一步限制当前剧情能使用的条目。本页供作者查询 `lore_bindings` 格式、开发者核对冻结、注入与回档生命周期；会话级规则见[按需载入](worldbook-on-demand.md)。

> 初始实现：提交 `c062238`。最近核对：2026-10-11（主线 `7344cea` 的源码与现有用例静态核对；未运行测试或实机流程）。

## 候选、注入与默认关闭

实际候选是 **会话 v3 范围 ∩ 节点作用域**。节点绑定只能窄化，不能让未绑定书、范围外条目或系统层元数据进入提示词。无有效绑定时仍使用会话范围；缺少当前 v3 快照则候选为空，不回退全书。

| 概念 | 来源与用途 |
|---|---|
| 剧情图节点 | `plot_graph_<plot_id>` 系统条目，服务编辑器布局，不注入 |
| 战斗节点 | `combat/nodes/<id>.json`，编码后的叙事条目可由名称/节点 ID 触发 |
| 剧情树节点与作者节拍 | overlay 的树节点记录已发生剧情；`beat_state` 记录章节/节拍索引，经当前大纲反查 beat ID |
| 会话范围 | `worldbook_scopes[book_id]` 的 v3 规则与候选快照 |
| 节点作用域 | 节点 `state.lore_scope`，当前镜像为 `overlay.lore_scope_active` |

`build_overlay_resolver` 在书或 overlay 缺失、无剧情树、无 v3 范围时返回 `None`。`find_bindings` 在无绑定、损坏绑定或空 `targets` 时关闭节点绑定；损坏数据写日志，空配置不会将整书候选清零。

当前叙事与回档调用对多书组合取第一本书构造 resolver。作用域带 `book_id`，仅窄化对应书，其他书仍按各自会话范围解析。不能把多书范围快照误写成“每本书都有独立节点绑定作用域”。

## 绑定格式与作者校验

绑定是书内系统条目，采用 `arknights_tavern_lore_bindings` 围栏 JSON 与 `raw.extensions.arknights_tavern.entry_type = lore_bindings` 标记往返。编码器生成 `lore_bindings_<book_id>` UID、空触发键；条目默认非常驻，系统层判定另外保证永不注入。

```jsonc
{
  "schema_version": 1,
  "book_id": "arknights",
  "targets": {
    "tree:n_root": {"entry_uids": ["core"], "sticky": true},
    "beat:beat_arrival": {"entry_uids": ["geo"], "sticky": true},
    "chapter:plot_id#章节标题": {"entry_uids": ["arc"]},
    "combat:enc_ambush": {
      "entry_uids": ["tactic"], "sticky": false,
      "inject": "always",
      "inject_position": {"position": 1, "group_weight": 5}
    }
  },
  "dormant_uids": ["spoiler"]
}
```

| 字段 | 当前语义 |
|---|---|
| `entry_uids` | 显式引用 UID；只收录会话候选内、启用且正文非空的条目 |
| `sticky` | target 级，缺省 true；同一节点可混合 sticky 与非 sticky 绑定 |
| `inject` | 缺省 `match`，只解锁候选，仍需关键词/概率；`always` 钉入动态层，跳过匹配与掷骰，仍受启用状态、范围与预算限制 |
| `inject_position` | 可覆盖 `position`、`depth`、`group_weight`，缺省沿用条目值；当前节点覆盖祖先，近祖先覆盖远祖先 |
| `expand` | 沿有向 `related` 边 BFS，默认深度 1，结果冻结；其他 relation 当前告警后按 related 处理，不展开 requires 闭包 |
| `dormant_uids` | 书级默认休眠；继承/展开不能解禁，当前 target 显式写入 `entry_uids` 才当场解禁 |

当前节点多个 target 按 `tree → beat → chapter → combat` 处理，同一 UID 的后写覆盖前写。展开实现以该节点全部显式 UID 为根，对每个带 `expand` 的 target 求邻居；不要假定每个 target 只展开自己的 UID。遍历可穿过不在 known 集合内的邻居，但只收集 known 内条目，环由 visited 终止。

推荐使用作者命名的 beat、章节与战斗 ID，开场使用固定 `tree:n_root`。生成树节点 ID 是 `sha1(parent|label)[:10]` 派生值，作者难以预知；“不绑定生成 hash”是作者约定，当前校验器不拒绝该 target。章节用标题而非序号：大纲章节号 1 起，`chapter_idx` 0 起；改标题须同步绑定。

`validate_bindings` 检查对象/数组形状、UID 非空、存在、启用且正文非空、不能引用自身、不能引用 `always_active` 条目，以及 inject 枚举和覆盖键。`dormant_uids` 必须是数组且不能包含自身。校验器当前**不验证**章节存在/重名、target 命名、`keep_on_deviate` 冲突或书内绑定条目唯一性。作者应保持每书一条绑定；运行时遇到多条取第一条并告警，不合并。

标签快选、引用扫描建议、侧栏设定列表和路径预算告警属于编辑器设计意图，不能据本页假定已有可用 UI。若实现标签工具，点击结果须立即物化为 UID；运行时不按标签自动扩大范围。

## 生命周期：冻结、继承与回档

### 路径粘滞与窄化白名单

进入节点时载入；沿祖先路径继承各节点的 `sticky_uids`，并按相同 sticky 边界继承 pinned 与 overrides。`sticky: false` 不向后传播，但只要同一 target 在后续节点继续命中，条目仍可再次被当前节点引入。

求解关系为：

```text
allowed = (inherited ∪ explicit ∪ expanded) − dormant ∪ (explicit ∩ dormant)
pinned = (继承钉入 ∪ 当前钉入) ∩ allowed
```

每个快照的 `sticky_uids` 记录该节点新引入的 sticky 子集；后代沿完整祖先链收集，不是只取直接父节点的一份 allowed。多节点引用同一 UID 是正常并集，条目不会重复注入。

卸载通过 allowed 变小完成，不修改会话 `resolved_entry_uids`，避免破坏会话范围与回档信息。回档到引入节点之前时恢复目标快照；切到另一分支也整体恢复，不增量删除旧路径条目。`keep_on_deviate` 不自动推导 sticky；当前没有冲突告警。

### 叙事轮末时序与战斗

`chat.py` 两条叙事路径按以下顺序收尾：

1. 提取 markers，读取推进前节拍的战斗目标并判断本轮是否触发。
2. 应用节拍完成、推进/跳转，再更新节拍进度（超限也可能推进）。
3. `commit_tree_step` 保存树节点，使用推进后的 beat/chapter，另传本轮真正触发的 `combat_id_hint`。
4. resolver 求解或复用作用域，写入节点快照和当前镜像。

不能从推进后的 beat 反查战斗绑定：战斗来源属于推进前那一拍。第 N 轮生成使用此前冻结的作用域，轮末作用域供后续生成使用，不能预判未生成的分支。当前新树初始化并不调用 resolver；首次叙事提交之前还没有节点 scope，因此首轮按会话范围注入。示例中的 root 绑定作用域指根节点提交后，不是创建即已载入。

战斗回合不落叙事树节点，非 sticky 战斗条目因此可持续到战后下个叙事节点。剧情路由对战斗中回档有 423 门禁；`set_active_lore_scope` 本身只有锁、复制与保存，**没有**旧文档所称的战斗中 ValueError 守卫。

### 复用、绑定修改与旧节点

`build_resolver` 的复用键是绑定条目 `content_revision` 指纹与 `SCOPE_RESOLVER_VERSION`。两者一致就复用已有 scope，不重新展开；指纹或版本变化，后续提交会重算，包括停留或复访的已有节点。这不是“只有新节点采用新绑定”的保证。

叙事与回档的 resolver 构造失败会记录 warning 并按关闭返回 None；提交时 resolver 执行失败会记录 warning 并保持上一活跃状态；resolver 为 None 时提交会清除已有活跃作用域。不能将这些日志降级路径解释为原子冻结成功。

回档优先采用目标节点保存的 scope，不对已有 scope 重新核对指纹；没有 scope 的旧节点才在恢复状态后惰性补算并写回。树本身在历史裁剪后保留，节点 scope 随之保留；未来字段裁剪也必须保留它。

| 世界书变化 | 当前后果 |
|---|---|
| 正文改动、UID 不变 | 会话读取当前正文；范围快照不复制正文，不能保证回档时提示词逐字复现 |
| 条目删除、停用或清空 | 新求解时 known 过滤；已有 scope UID 可保留，但实际匹配仍按当前条目/启用状态处理 |
| related 边变化 | 指纹未变时旧 scope 复用；新节点求解读取构造 resolver 时的当前 related 边 |
| 绑定正文变化 | 指纹改变，后续提交重新求解；直接回档仍先恢复保存的旧 scope |

会话 v3 依赖规则快照与节点 lore 绑定是不同的冻结边界：后者目前从当前书读取绑定和 related 边，不是创建会话时永久冻结整份绑定。

## 注入、顺序与预算

`eligible_uids_for` 不做 BFS 或绑定文件 IO，只取范围交集。返回的 `EligibleSet` 携带 `forced_uids`、位置覆盖及会话启用覆盖。`collect_matches` 对钉入条目跳过关键词与概率，对位置覆盖做轻量副本，不改原书条目；`format_injection` 格式化与裁预算。

节点绑定禁止常驻条目，注入须进动态层。触发型条目即使 position=0 也进动态层；覆盖逻辑对意外落入稳定层的情况再钳制 position。稳定层只收 position=0 且常驻条目。

未显式设置 `entry_order` 时，排序键为 `(position, -group_weight, depth, uid)`；已有显式顺序时先分稳定/动态层，各层按整书顺序，默认键兜底。`group` 不实现“同组只取一个”。低 group_weight 只在默认排序条件下影响优先级，不保证节点条目总被最后裁掉。

预算大于 0 时跳过当前超限条目并继续扫描，后续较小条目仍可加入，但至少保留首条；因此 `inject: always` 不保证绕过预算。路径粘滞会累积，作者须结合预算与真实匹配检查。`with_reasons=True` 返回 `dropped_by_scope`（会话候选被节点排除）与 `missing_uids`（节点 allowed 不在会话 base 中），不能据 missing_uids 推断所有被删除或停用条目都有专项诊断。

Call 2 分支生成复用本轮动态层 `wb_after`，不重新解析节点作用域；`_recent_worldbook_text` 不含稳定层。工作台的整书 Prompt 预览也不模拟节点范围，详见[预览边界](worldbook-on-demand.md#6-当前-api)。

## 实现、验证入口与未做范围

- [求解与校验](../../../src/node_lore_scope.py)：解码、find_bindings、related BFS、resolve_scope、resolver 复用。
- [overlay](../../../src/session_overlay.py)：树节点快照、当前镜像与回档补算。
- [世界书](../../../src/world_book.py)：候选交集、匹配、排序与预算；[叙事收尾](../../../src/blueprints/chat.py)负责战斗 hint 时序。
- [纯函数用例](../../../tests/test_node_lore_scope.py)与[回档用例](../../../tests/test_node_scope_rollback.py)：已有测试入口，本次只读，未重跑。

没有增量物理卸载、`unload_at`、per-target dormant、节点二次关键词触发、组互斥或自由模式节点绑定。不要把这些排除项、编辑器预算提示或校验缺口当成已落地功能。

## 附录：雪境剧情的绑定示意

初始文档以 `fengxue_guojing` 的六章二十一拍大纲说明绑定；其中二十拍 keep_on_deviate=true、结束拍为 false。这是原文的内容记录，本次不将其作为已安装用户书的现状或验收。以下 UID 为说明用途，使用前需按目标书校验。

```jsonc
// 绑定文件：1 条世界书条目，uid = "lore_bindings_arknights"
// （自身 always_active=false、trigger_keys=[]，永不进注入）
{
  "targets": {
    "tree:n_root":                  {"entry_uids": ["uid_lore_kjerag_geo"],    "sticky": true},
    "chapter:fengxue_guojing#不欢而聚": {"entry_uids": ["uid_lore_snowdevil"], "sticky": true},
    "beat:beat_arrival":            {"entry_uids": ["uid_lore_convoy"],        "sticky": true},
    "beat:beat_reveal":             {"entry_uids": ["uid_lore_traitor_reveal"],"sticky": false},
    "combat:enc_snow_ambush":       {"entry_uids": ["uid_lore_ambush_tactic"], "sticky": false,
                                     "inject": "always", "inject_position": {"position": 1}}
  },
  "dormant_uids": ["uid_lore_ending_spoiler"]
}
```

> ⚠️ `chapter:` 的索引必须与代码**同一个口径**：`plot_flows()` 解析
> `^##\s*章节\s*(\d+)\s*[：:]\s*(.+)$`（`src/combat_nodes.py:498` 的 `_CHAPTER_RE`），
> 章节号是 **1 起**（文件里是「章节 1：不欢而聚」），
> 而 `beat_state.chapter_idx` 从 `beats` 列表下标来、是 **0 起**。
> 绑定文件里**直接用章节标题**做 key（`chapter:fengxue_guojing#不欢而聚`）避免这种坑；
> 作者应核对标题存在且不重名；当前 `validate_bindings()` 不检查标题不存在或重复。

作用域演化：

```
根节点提交（n_root）      ACT = {kjerag_geo}
  第 1 章某节点            ACT = {kjerag_geo, snowdevil}
  走到 beat_arrival        ACT = {kjerag_geo, snowdevil, convoy}
  战斗触发轮落盘的节点      ACT += {ambush_tactic}      （sticky=false，经 combat_id_hint 激活；
                                                        inject=always → 无需关键词，到达即注入）
  战斗期间                  ACT 不变                    （战斗回合不落树节点）
  战斗后下一个叙事节点       ACT -= {ambush_tactic}      ← 非 sticky 条目退出
  玩家回档到第 1 章节点     ACT = {kjerag_geo, snowdevil} ← 从节点快照整体替换
  走到 beat_reveal         ACT += {traitor_reveal}     （一次性揭示，sticky=false，
                                                        不进 sticky_uids，下一节点即消失）
  全程 ending_spoiler 永不出现，除非某 target 显式把它写进 entry_uids（当场解禁）
```
