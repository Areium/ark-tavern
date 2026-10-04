# 可安装战斗模式

状态：实现中。安装管理已实现，脚本运行与会话接入尚未交付；不要将此文档当作完整现状说明。

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

`entry` 为打包后的 UTF-8 JavaScript；运行时加载约定将在运行阶段落实后补齐。`input` 当前仅声明契约标识、整数版本、必需顶层字段，不等价于通用 JSON Schema 类型验证。`resources` 是包内文件清单。未知 manifest 字段会报错，不能请求任意服务端权限。保留 ID：narrative、tactical、sideview。

大小上限：512 个文件，单文件 8 MiB，解压后总计 32 MiB，manifest 64 KiB。拒绝链接/junction、特殊文件、路径穿越、Windows 保留名、大小写冲突和重复 JSON 键。摘要覆盖所有文件路径和原始字节。不会覆盖已安装同 ID 模式，替换前需卸载。卸载移动到 `data/combat_mode_archive/<id>-<uuid>/`，恢复时将完整归档目录改回原 ID 后放回模式目录；启停状态独立保存。

API：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/combat-modes` | 内置与本地模式、错误、ABI |
| POST | `/api/combat-modes/install` | multipart `file` ZIP 安装 |
| PUT | `/api/combat-modes/<id>/enabled` | JSON `{enabled: boolean}` |
| GET | `/api/combat-modes/<id>/export` | ZIP 下载，停用包也可导出 |
| DELETE | `/api/combat-modes/<id>` | 归档卸载，返回 `archived_to` |

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

## 必须完成的运行与集成设计

1. 浏览器脚本仅运行在受限 iframe，使用宿主声明的消息 ABI：初始化输入/资源、快照、结果、错误。消息校验 source、run ID、类型及大小；不能把消息当任意宿主方法名执行。需要超时与退出操作。CSP 阻止联网、表单与未声明资源，不开放父 DOM。
2. 不用 `Origin: null` 一刀切禁止 API：Electron 的 `file://` 渲染进程同样是 opaque origin。需要同时验证 Electron 客户端和浏览器运行隔离，不夸大安全承诺。
3. 世界书提供模式适配文件，创建会话前检查接口版本、遭遇输入、全部必需资源；报错定位到具体书/遭遇/字段。已有战术节点不能默认视为任意插件的有效输入。
4. 创建事务内冻结已校验的包、内容与资源，使用摘要锁定版本；不把可变安装目录当成旧存档依赖。停用/卸载/升级不应破坏已有会话。导出携带冻结内容，导入必须重新验证；坏存档不能静默转为 narrative。
5. 独立插件运行态支持开始、保存、恢复、撤退、结果与重复提交保护，不能借用战术 `session.combat`。浏览器自报胜利不是可信奖励凭据；不得接受客户端提供的成长/物品 DTO。奖励授权与验证策略必须在正式结算实现前明确。
6. 内置玩法仍需统一可操作入口，并验证完整现有玩法未被简化的示例替代。交付至少一个可实际安装运行的独立模式包及世界书适配示例。

## 当前代码接入清单与门禁

- `blueprints/sessions.py:create_session` 目前限制三种模式。插件绑定应放在 manager 发布会话前的 initializer 事务内。`session_manager.py:_restore_sessions/import_session_dir` 不经过创建 API，同样需要校验冻结绑定。
- `session_export.py` 递归携带会话目录，但 manifest 和 session.json 的模式一致性、冲突 ID 重写、冻结文件验证、导出锁需要覆盖。
- `blueprints/chat.py` 的 `_should_extract_markers`、`_apply_combat_briefing` 与 `SceneManager.py` 的提取/叙述/遭遇目录存在内置模式分支。`session_narrate` 和 `session_narrate_continue` 均需要接入。不可用模式不能让已推进节拍吞掉战斗触发；插件不要走战术节点生成器。
- `Session.to_dict/combat_resumable/combat_resume_summary` 和聊天互斥需要包含插件 active/suspended/settling。战术 complete/settlement 目前只排除 sideview，必须防止它们消费插件结果。
- `SessionOverlay` 整体持久化不代表剧情回档：顶层运行态不会自动加入 `_tree_state_snapshot`。运行态、奖励、收据需要一致的回档策略，测试恢复后重领奖励风险。
- 定向测试覆盖包管理/API/CLI；最终还需实际脚本运行、会话/存档/剧情、异常重试/并发、全套测试、前端构建、PC 浏览器验收和独立审查。
