# 可安装战斗模式

状态：实现中。安装管理、脚本演练与世界书静态预检代码已实现；真实浏览器验收和正式会话接入尚未完成，不是完整交付。

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

可选 `practice: "practice.json"` 指定包内演练输入对象；安装时检查必需字段。当前演练只使用包内资源，要求世界书资源的模式不可声明 practice，须通过后续正式内容入口启动。

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

## 必须完成的运行与集成设计

1. 运行 ABI 与演练代码已实现，协议/stub 单测和构建通过，仍需真实 PC 浏览器及 Electron 行为验收；不能将 stub 测试当作安全或视觉验收。
2. 不用 `Origin: null` 一刀切禁止 API：Electron 的 `file://` 渲染进程同样是 opaque origin。需要同时验证 Electron 客户端和浏览器运行隔离，不夸大安全承诺。
3. 世界书适配预检已实现；接入创建会话选择与事务时再检查接口版本、遭遇输入、全部必需资源。已有战术节点不能默认视为任意插件的有效输入。
4. 创建事务内冻结已校验的包、内容与资源，使用摘要锁定版本；不把可变安装目录当成旧存档依赖。停用/卸载/升级不应破坏已有会话。导出携带冻结内容，导入必须重新验证；坏存档不能静默转为 narrative。
5. 独立插件运行态支持开始、保存、恢复、撤退、结果与重复提交保护，不能借用战术 `session.combat`。浏览器自报胜利不是可信奖励凭据；不得接受客户端提供的成长/物品 DTO。奖励授权与验证策略必须在正式结算实现前明确。
6. 内置玩法仍需统一可操作入口，并验证完整现有玩法未被简化的示例替代。交付至少一个可实际安装运行的独立模式包及世界书适配示例。

## 当前代码接入清单与门禁

- `blueprints/sessions.py:create_session` 目前限制三种模式。插件绑定应放在 manager 发布会话前的 initializer 事务内。`session_manager.py:_restore_sessions/import_session_dir` 不经过创建 API，同样需要校验冻结绑定。
- `session_export.py` 递归携带会话目录，但 manifest 和 session.json 的模式一致性、冲突 ID 重写、冻结文件验证、导出锁需要覆盖。
- `blueprints/chat.py` 的 `_should_extract_markers`、`_apply_combat_briefing` 与 `SceneManager.py` 的提取/叙述/遭遇目录存在内置模式分支。`session_narrate` 和 `session_narrate_continue` 均需要接入。不可用模式不能让已推进节拍吞掉战斗触发；插件不要走战术节点生成器。
- `Session.to_dict/combat_resumable/combat_resume_summary` 和聊天互斥需要包含插件 active/suspended/settling。战术 complete/settlement 目前只排除 sideview，必须防止它们消费插件结果。
- `SessionOverlay` 整体持久化不代表剧情回档：顶层运行态不会自动加入 `_tree_state_snapshot`。运行态、奖励、收据需要一致的回档策略，测试恢复后重领奖励风险。
- 定向测试覆盖包管理/API/CLI/冻结演练/世界书预检；脚本引擎单测和协议 stub 测试另跑。最终仍需实际浏览器运行、正式会话/存档/剧情、完整异常重试/并发、全套测试、最终构建和独立审查。
