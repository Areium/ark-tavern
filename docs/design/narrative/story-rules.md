# 剧情分支条件与效果

本页供世界书作者配置分支、开发者排查结算使用。条件与效果由服务端判定，模型负责描述已结算结果。

> 最近核对：2026-10-11（`story_outline.py`、`story_rules.py`、`session_overlay.py`、`blueprints/chat.py` 与现有规则用例的静态核对；未运行模型或修改会话数据）。

## 定义字段与分支

世界书的 `stat_fields` 定义字段默认值；角色 frontmatter `stats` 可覆盖初值，会话 `character_stats` 保存剧情变化。没有定义的战斗等级和属性不在叙事面板中补造。

在世界书系统条目 `story_outline_<plot_id>` 的 `json story-outline` 中，为节拍的 `branches[]` 声明规则。现有条目编辑器可编辑这份结构，当前没有可视化规则编排器。

```json
{
  "label": "核对终端与病中日志",
  "intent": "留存证据，不直接断言身份",
  "target_beat_id": "beat_investigate",
  "conditions": [
    {"kind": "item", "item_id": "items_terminal", "present": true},
    {"kind": "stat", "actor": "player", "key": "logs_saved", "op": "eq", "value": true}
  ],
  "effects": [
    {"kind": "stat", "actor": "player", "key": "clues", "op": "add", "value": 1}
  ]
}
```

示例要求书里已定义 `logs_saved` 布尔字段、`clues` 数字字段、物品和目标节拍；不是彼岸双生的实际配置。

## 条件、效果与可达性

条件全部满足才可选择。每组最多 16 项；每节拍最多 6 个标签不同的分支。物品条件 `present` 默认 true；数值 `actor` 默认 player，也可指定阵容中的角色名。数值比较支持 `eq/ne/gt/gte/lt/lte`，增减与有序比较只用于数字，未知字段或类型错误会阻止选择。数值效果支持 `set/add`；`add` 只接受有限数字并遵守字段上下限，规则不接受 NaN / Infinity 或未知字段。物品效果 `op` 可为 `add/remove`，表示共同场景中的唯一物品出现/消耗，不支持数量堆叠。

关键选择节拍设置 `choice_required: true`，避免模型完成标记或超时顺序推进替玩家作决定。务必保留至少一条可达路线，避免所有条件都无法满足。物品来自当前绑定书的 `items/<id>/index.md`，或启用且 `category_id=items` 的条目 UID；书内存在该物品不表示开局已持有。

## 结算、失败与回档

规则效果与落点先一次性结算，再交给模型描述。模型失败时资源不会自行退回，重试相同选项 ID 会继续叙述而不重复结算。需要撤回选择时使用节点图回档；已结算效果的会话不允许只剪文本历史的轮次回退。并发操作返回 409，不能靠重复发送覆盖进行中的叙述。

## 修改已有配置的影响

对世界书的修改仅影响之后创建会话的大纲副本，不自动改写已有会话。数值字段配置仍从绑定首书读取；如果在会话途中调整字段定义，面板与下一次条件重验都会使用新定义。

数值三层来源见[会话场景面板与角色数值](../session-scene-plugins.md#2-三层口径)。实现入口：[规则定义](../../../src/story_outline.py)、[规则结算](../../../src/story_rules.py)、[会话覆盖层](../../../src/session_overlay.py)、[规则 HTTP 用例](../../../tests/test_story_rules_http.py)。
