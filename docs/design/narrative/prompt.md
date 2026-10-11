# Prompt 工程约定（本项目实际遵循的写法）

修改叙述、标记提取或角色扮演提示词时，先确定本次调用负责什么，再按本页组织指令与数据。提示词约束须与解析、校验和错误处理配套，不能把模型遵循指令当成系统保证。

> 最近核对：2026-10-11（静态阅读 `SceneManager.py`、`CharacterAgent.py`、`character_card.py` 的提示词与解析入口；未调用真实模型）。

## 写提示词的顺序约定

1. `<role>`：用 1–2 句说明身份与职责。
2. `<core_rules>`：关键硬规则靠前，用 MUST、严禁或禁止明确动作与边界。
3. 任务与流程：只放本次调用需要的步骤、条件和数据。
4. `<output_format>`：需要结构化结果时给出 JSON 骨架与字段说明，明确禁止格式外文字。
5. 用户消息末尾重申最关键的约束，例如提取只输出 JSON、叙述的总字数上限。

纯文本叙述不因这一顺序而改成 JSON。调用之间的职责划分见[两阶段叙述](two-phase-narration.md)。

必须遵守的规则采用命令式，不用 `try`、`consider`、`please` 等措辞弱化边界；具体使用 MUST 或中文约束不强求统一。

## 已采用

| 写法 | 当前使用位置与作用 | 修改时的边界 |
|---|---|---|
| XML 标签分区 | 系统提示词用 `<role>`、`<core_rules>`、`<output_format>`；用户消息用 `<narrative>`、`<current_node>`、`<world_background>`、`<encounters>` 等区分职责、指令与数据。角色档案也有独立分区。 | 标签有助于区分玩家输入、世界书正文与指令，但不构成提示词注入隔离保证。 |
| JSON 骨架与字段说明 | `_NARRATOR_SYSTEM_STRUCTURED`、`_MARKER_EXTRACTOR_SYSTEM` 直接规定输出结构，而非建议模型自由发挥。 | 解析侧仍需处理代码围栏、JSON 对象定位及字段归一化；合法节拍 ID 由程序校验。 |
| 关键规则首尾重申 | 系统核心规则与用户消息末尾同时强调 JSON 输出纪律或字数限制，降低长上下文中关键规则被忽略的风险。 | 重申不代替解析、预算与失败处理；不宣称一定遵守。 |
| 命令式约束 | 叙述与提取使用 MUST、严禁、禁止；角色扮演也使用 NEVER，限制自称 AI/模型及虚构角色卡外信息。 | 不把某个英文关键字作为统一规范；明确主体、动作和条件比关键字本身更重要。 |
| 真实历史与角色卡示例 | `_build_conversation_history(structured=True)` 优先使用已保存 JSON 片段；角色卡的 `mes_example` 提供对话示例。 | 当前未设置独立的 2–3 条 few-shot 模板块；示例应符合本次调用的真实格式。 |

提取解析失败会返回 `error`/`degraded`，空响应或截断有一次重试。正文结构化解析和系统标记提取是不同入口，不要给它们统一宣称某种“三级修复”。

## 未采用

- **ReAct 输出范式**：当前提示词不要求模型输出 Thought → Action → Observation；工具调用和战斗推进由程序流程管理。
- **字面 NEVER 作为统一规范**：它仅出现在部分角色扮演规则中，叙述和提取使用中文约束及 MUST。
- **订单处理 Agent 模板**：`query_order`、订单号校验和订单 JSON Schema 与本项目任务无关。
- **未经仓库验证的外部效果数字**：Microsoft/MIT 2024、Anthropic 2023、ICLR 2024 等外部材料，以及“指令遵循率 +15%~25%”“比 Markdown 高 42%”“召回率 30%→85%”，不作为本项目已验证的收益或取舍依据。

## 实现入口

- [SceneManager](../../../src/SceneManager.py)：叙述系统提示词、`_build_narration_messages`、`_build_extraction_messages`、`_parse_extraction_json` 与 `parse_structured`。
- [CharacterAgent](../../../src/CharacterAgent.py)：角色档案、对话规则与工具循环。
- [角色卡解析](../../../src/character_card.py)：角色设定和 `mes_example` 的来源。
