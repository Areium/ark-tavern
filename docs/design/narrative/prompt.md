# Prompt 工程约定（本项目实际遵循的写法）

> 本文记录本项目提示词里**实际在用**的写法，以及明令不用的写法，供新增 / 修改提示词时对齐。
> 覆盖范围：`src/SceneManager.py`（叙述与标记提取）、`src/CharacterAgent.py`（角色扮演）、`src/character_card.py`（角色卡解析）。

## 已采用

### 1. XML / 标签分区
系统提示词拆成 `<role>` / `<core_rules>` / `<output_format>` 等唯一标签块；用户消息同样按 `<narrative>` / `<current_node>` / `<world_background>` / `<encounters>` 分区。
见 `SceneManager.py` 的 `_NARRATOR_SYSTEM`、`_NARRATOR_SYSTEM_STRUCTURED`、`_MARKER_EXTRACTOR_SYSTEM`、`_build_narration_messages`（docstring 明确「XML 标签分区用户消息」）与 `CharacterAgent` 的角色档案提示词。
作用：把「指令 / 数据 / 示例」分开，避免模型把玩家输入或世界书正文当成指令执行。

### 2. 强制 JSON 结构（不是「建议格式」）
提示词内直接给出完整 JSON 骨架 + 逐字段说明，并声明「严格输出 JSON …，禁止其他文字」；解析侧再用 `_parse_extraction_json` / `parse_structured` 做容错（剥离 ```json 包裹、截断修复）。
见 `_NARRATOR_SYSTEM_STRUCTURED` 的 `<output_format>`、`_MARKER_EXTRACTOR_SYSTEM` 的字段说明、`_build_extraction_messages`。

### 3. 关键规则首尾重申
硬规则既写在系统提示词开头的 `<core_rules>`，也在用户消息末尾再重申一次——如 `_build_extraction_messages` 结尾追加「MUST：只输出 JSON 对象…」，叙述消息结尾重申字数上限。用于对抗长上下文下的中段遗忘。

### 4. 命令式强约束（MUST / 严禁 / 禁止）
规则一律用命令式动词书写：`- MUST：…`（`SceneManager.py` 中 20 余处），负面约束用「严禁 / 禁止」（如「严禁在 JSON 文本值中使用英文双引号」「严禁编造节拍 id」）。
`CharacterAgent.py` 中另有 `NEVER：…` 的两条用法（不得自称 AI/模型、不得虚构角色卡外信息）。
弱化措辞（try / consider / please）在本项目提示词中不出现。

### 5. 少样本的替代做法
不设独立的 2–3 条 few-shot 示例块，改用**真实历史作格式示例**：结构化模式下优先取历史中已存的 JSON 片段当示例（`_build_conversation_history`），角色扮演侧直接使用角色卡自带的「对话示例」（`mes_example`，见 `character_card.py`）。

## 未采用

- **ReAct（Thought → Action → Observation）**：本项目提示词不含思维链输出范式，工具与战斗由后端流程驱动，不需要模型自述推理步骤。
- **把字面 `NEVER` 关键字当统一规范**：仅角色扮演提示词用到，叙述与提取提示词一律用中文「严禁 / 禁止」。
- **订单处理 Agent 类示例**（`query_order`、订单号校验、为订单编写的 JSON Schema）：与本项目无关，不作为模板参考。
- **外部研究结论与百分比**（Microsoft/MIT 2024、Anthropic 2023、ICLR 2024 等出处，以及「指令遵循率 +15%~25%」「比 Markdown 高 42%」「召回率 30%→85%」这类数字）：无法在本仓库复现或验证，仅作外部背景，不作为本项目的取舍依据。

## 写提示词的顺序约定

1. `<role>`：身份与职责（1–2 句）。
2. `<core_rules>`：硬规则（MUST / 严禁，越关键越靠前）。
3. 任务与流程（步骤化，只放流程与细节）。
4. `<output_format>`：输出结构（JSON / XML，强制）。
5. 用户消息末尾重申最关键约束（首尾呼应，不埋中段）。
