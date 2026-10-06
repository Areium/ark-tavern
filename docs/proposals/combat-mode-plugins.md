# 可安装战斗模式

状态：实现与真实 PC 浏览器验收通过。安装管理、脚本演练、世界书预检、正式会话和冻结存档已完成；验收修复与边界见 [2026-10-06 验收报告](../archive/combat-plugin-pc-qa-2026-10-06.md)。Electron 专有运行行为未覆盖。

## 目标与历史边界

模式包是玩法代码与通用资源，世界书是遵循玩法输入契约的内容。复制目录或安装 ZIP 后能发现新玩法，无须修改宿主源码或重建前端。现有战术、横版玩法必须保持可用；内置适配器目前只在统一目录 API 中登记，尚不能因此宣称它们已可独立导出安装。

2026-09-27 的隔离脚本实验只证明 iframe、快照和代表性玩法可行，没有正式会话/经济结算保障。本次不把实验完成状态当作项目实现证据。

## 已实现的包管理

```text
data/combat_modes/<id>/
  manifest.json
  main.js
  art/...
```

目录名须等于 manifest ID。ZIP 支持 manifest 位于根目录，或套一层完整模式目录。目录复制后刷新列表即发现；坏包出现在诊断区，不影响其他包。导入不执行任何代码。

```json
{
  "id": "custom-mode",
  "name": "自定义战斗",
  "version": "1.0.0",
  "abi": "ark-combat/1",
  "description": "模式说明",
  "entry": "main.js",
  "input": {"id": "custom-encounter", "version": 1, "required": ["enemies"]},
  "resources": ["art/token.svg"]
}
```

`entry` 为自包含 UTF-8 JavaScript ES module，默认导出 `async function(ctx)`。`input` 声明契约标识、整数版本、必需顶层字段，可选 `input.resources` 声明必需世界书资源别名；它不等价于通用 JSON Schema 类型验证。`resources` 是包内文件清单，不能与必需世界书资源别名冲突。未知 manifest 字段会报错，不能请求任意服务端权限。保留 ID：narrative、tactical、sideview。

可选 `practice: "practice.json"` 指定包内演练输入对象；安装时检查必需字段。当前演练只使用包内资源，要求世界书资源的模式不可声明 practice，须通过正式会话入口启动。

大小上限：512 个文件，单文件 8 MiB，解压后总计 32 MiB，manifest 64 KiB。拒绝链接/junction、特殊文件、路径穿越、Windows 保留名、大小写冲突和重复 JSON 键。摘要覆盖所有文件路径和原始字节。不会覆盖已安装同 ID 模式，替换前需卸载。卸载移动到 `data/combat_mode_archive/<id>-<uuid>/`，恢复时将完整归档目录改回原 ID 后放回模式目录；启停状态独立保存。

API：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/combat-modes` | 内置与本地模式、错误、ABI |
| POST | `/api/combat-modes/install` | multipart `file` ZIP 安装 |
| PUT | `/api/combat-modes/<id>/enabled` | JSON `{enabled: boolean}` |
| GET | `/api/combat-modes/<id>/export` | ZIP 下载，停用包也可导出 |
| DELETE | `/api/combat-modes/<id>` | 归档卸载，返回 `archived_to` |
| POST | `/api/combat-modes/<id>/practice` | 冻结该包及演练输入，返回运行 DTO |
| GET | `/api/combat-mode-runs` | 可继续演练及坏存档诊断 |
| GET | `/api/combat-mode-runs/<run_id>` | 读取冻结版本、输入、快照及运行 bundle |
| PUT | `/api/combat-mode-runs/<run_id>` | `{revision, snapshot, outcome?}`，保存或结束 |
| POST | `/api/combat-modes/<id>/compatibility` | `{worldbook_ids}`，只读静态预检 |

命令行（不需启动服务）：

```powershell
python tools/combat_mode.py list
python tools/combat_mode.py install C:/packages/custom-mode.zip
python tools/combat_mode.py disable custom-mode
python tools/combat_mode.py enable custom-mode
python tools/combat_mode.py export custom-mode C:/packages/export.zip
python tools/combat_mode.py uninstall custom-mode
```

可用 `--project-root <项目目录>` 指定隔离安装位置；导出不覆盖已有文件。应用内主页和管理顶栏提供“战斗模式”入口。

## 已实现的独立演练

`examples/combat-modes/stance-duel/` 是可直接复制/压缩安装的独立玩法，不替换既有战术和横版引擎。组件 `RuntimeFrame` 在 `sandbox="allow-scripts"` iframe 中加载模块，宿主不 eval 插件。`ctx` 提供 root、input、snapshot、resources、save(snapshot)、complete(outcome,snapshot)；save/complete 返回的 Promise 只有宿主成功保存后才确认。

宿主核对消息 source、随机 token、ABI、字段、序号与大小，串行处理保存，异常/失联会移除 iframe。普通消息最多 1 MiB，初始化单独限制为 48 MiB 以容纳合法包的 base64 资源。CSP 限制常见网络/表单/子框架/Worker 路径，但不能保证阻止恶意自导航或浏览器资源耗尽；运行前必须确认信任，不向插件传入密钥。

演练保存在 `data/combat_mode_runs/<run_id>/package.zip` 和 `run.json`。原子保存与 revision CAS 防止同进程多标签覆盖，冻结摘要在重新载入时核对。完成后相同结果重试返回同一状态，不同结果/后续写入拒绝。演练结果带 `verified:false, rewards:null`，不写剧情会话，不奖励经验或物品。此运行仓库服务于单进程本地 Flask，尚未提供多 worker/多进程写锁。

## 已实现的世界书静态预检

绑定书内 `combat/modes/<mode_id>.json` 示例：

```json
{
  "mode": "stance-duel",
  "interface": {"id": "stance-encounter", "version": 1},
  "encounters": {
    "enc_training": {
      "name": "训练守卫",
      "input": {"player": {"name": "玩家", "hp": 60}, "enemy": {"name": "守卫", "hp": 75}},
      "resources": {}
    }
  }
}
```

resources 为 `别名 → 书内相对文件路径`，拒绝越界/链接/资源覆盖。所有所选书的遭遇 ID 必须唯一；至少一本提供适配，其他书可只供背景知识。检查启用状态/剧情用途、接口 ID 与版本、必需输入、资源完整性、总大小和遭遇数量（最多 128）。响应失败时定位书籍与文件，成功时返回包摘要、绑定摘要和遭遇目录。不创建会话，不执行代码；正式会话创建时仍须重新校验并在事务内冻结，不能信任先前预检结果。

## 正式会话契约

- 创建请求以插件 ID 作为 `combat_mode`，必须提交 `trust_combat_plugin:true` 与预检返回的 `combat_binding_digest`。创建时重新预检，摘要过期返回 409。会话发布前冻结 `combat_plugin/package.zip` 与 `binding.json`，后续不依赖安装目录或原书资源。
- 会话 API 使用 `/api/sessions/<id>/combat-plugin`：GET 读取；POST `/start` 接收 `encounter_id`；PUT `/state` 接收 `runId/revision/snapshot/outcome?`；POST `/confirm` 接收 `runId/revision` 和 `accept:true` 或 `retreat:true`，二者互斥。写入与叙述互斥，使用 overlay 锁和 CAS。
- 运行状态为 `active → settling → completed`，主动撤退可从 active 完成。脚本自报结果仅进入 settling；宿主用户确认才写历史和续写动作。结果始终 `verified:false, accepted_by_user:true, rewards:null`，不接受脚本提供的经验、物品或角色数值。此版本不自动发放宿主经济奖励。
- `combat_plugin` 运行态、历史和完成收据一起落盘并跟随剧情节点回档；`combat_plugin_binding` 不回档。重复确认返回原收据，回档到战前后旧 runId 被拒绝。坏收据返回可诊断错误，保存失败恢复内存态。
- 导出在 overlay 锁内校验冻结绑定和运行态；导入检查 manifest/session.json 模式一致性并重验冻结文件。损坏恢复会话保留可见且报告错误，不降级模式。
- GET 叙述 SSE 与 POST 非流式回退都从冻结遭遇目录发出插件简报，不调用战术节点生成器；active/settling 阻止继续叙述。前端向导、恢复和手动入口均按插件模式路由。

## 验证与剩余门禁

`tests/test_combat_mode_session_integration.py` 覆盖创建门禁、冻结后卸载、API隔离、CAS、用户确认、幂等、回档、保存失败、损坏存档、重启恢复、篡改导入及两条真实叙述路由（LLM输出为测试替身）。包管理/演练/预检另有对应测试；脚本协议测试与示例玩法测试另跑。可复制的适配文件见 `examples/worldbook-adapters/stance-duel.json`，使用步骤见示例 README。

真实 PC 浏览器操作与具体 iframe 限制已于 2026-10-06 验收，报告记录逐项操作、修复及未覆盖边界。独立审查发现的合法包省略描述问题已通过统一目录摘要字段修复并复核。不能把审查、协议 stub、构建或 API 测试称为 Electron 运行或恶意代码安全验收；也不按 `Origin:null` 一刀切拦截 Electron 客户端。内置引擎保留宿主适配器身份，管理页可进入原完整演练，不声称可独立导出安装。

### PC 交互验收范围（已执行，具体证据与边界见报告）

仅使用隔离数据与本任务启动的服务，不重启用户正在运行的实例，不修改真实会话。

- 文件夹发现与 ZIP 安装：显示名称/版本/诊断；重复 ID 不覆盖；启停、导出、归档路径反馈准确；坏包不阻止正常包显示。
- 演练：授权前无 iframe；进攻/防御/蓄力/爆发可玩；保存后返回并恢复；结果后不能继续操作；错误与超时停止脚本；键盘可完成确认/取消。
- 正式会话：选择插件和适配书，缺适配/摘要过期阻止创建；授权后进入实际玩法；返回不结束；结果等待确认，确认后回对话；整页重载可读取已确认结果并手动续写。
- 存档：开始后停用/卸载原安装包仍能恢复冻结版本；导出导入仍能运行；旧版本写请求不覆盖新快照。
- 内置回归：管理页战术/横版“演练”进入原完整引擎；叙述模式不显示伪演练入口。
- 观察 PC 布局、焦点/弹窗/错误态、浏览器控制台与 iframe 实际隔离行为。截图与结果应绑定当前提交，不复用历史实验截图。
