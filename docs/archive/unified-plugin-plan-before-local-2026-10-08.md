# 战斗模式统一插件化实施计划

更新日期：2026-10-08（Asia/Shanghai）

当前决策：2026-10-08 用户确认采用“版本独立安装、使用新版本必须新建会话、先删除依赖会话再卸载”，详见 §35；本轮已开始代码实施，最新范围与验收见 §36。§1–§15 为现行目标，§16–§34 保留历史实施证据，其旧版本保留/升级/卸载要求不再作为续做依据。

最近代码状态：以 c58c8db 的完整检查点发布为基线，在 D:/Code/arknights-tavern-version-installs（feat/plugin-version-installs）完成版本独立安装阶段提交 1e46306，见 §36。§34 为此前验收证据；原 WIP 保留，未 merge/push，完整 P0–P7 仍未完成。



## 1. 目标与完成定义

将叙事战斗、回合战术、横版动作改为真正的可安装、可停用、可卸载插件。应用首次初始化时默认安装并启用官方三种模式；官方插件与外部插件共用包管理、注册、会话绑定和生命周期。

插件不仅提供战斗脚本，还可以提供完整玩法引擎、前端视图、编辑器、配置、资源、内容 Schema 和结果校验。宿主只负责通用能力，不继续按三种玩法 ID 编写业务分支。

完成必须同时满足：

- [ ] 三种官方模式各有可独立导出、安装的完整插件包；不是调用宿主固定引擎的空壳。
- [ ] 安装第四种模式不修改宿主源码、不重建宿主前端、不运行安装脚本。
- [ ] 插件能替换整个战斗内容区，并扩展会话、消息、世界书编辑与独立页面。
- [ ] 全部战斗插件卸载后，应用仍能启动、管理内容、创建无战斗插件会话和正常对话。
- [ ] 同 ID 不同版本独立安装、启停与卸载；使用新版本必须新建会话，不迁移或改绑旧存档。
- [ ] 卸载精确版本前列出依赖会话；用户先单独删除这些会话，实际引用归零且实例关闭后才允许卸载，不隐式删档。
- [ ] 插件出错、资源缺失、存档损坏、接口不兼容均可诊断，不静默换模式或丢弃进度。
- [ ] PC 浏览器和 Electron 分别完成真实验收；构建、协议测试不能替代运行验收。

## 2. 当前基线与问题定位

以下为最初编写时的历史基线，当前代码状态见 §34，后续目标以 §35 与已修订正文为准。

编写时核对主工作区为 `D:\Code\arknights-tavern`，`main` / `362bf5c`。原 `task.md` 为 14 字节空行，受 `.gitignore` 忽略。`docs/design/frontend-design-guidelines.md` 与 `docs/system-update-log.md` 已有其他修改，本轮不触碰。

当前实现可复用的部分：包路径与 ZIP 校验、内容摘要、安装归档、世界书预检、会话冻结、revision CAS、幂等确认、剧情回档、iframe 消息检查。

当前不足及入口：

| 位置 | 现状 | 目标 |
|---|---|---|
| `src/combat_mode_packages.py` | `BUILTIN_IDS` 阻止内置模式按安装包管理 | 所有模式由注册记录与权限决定，不按 ID 给予生命周期特权 |
| `src/blueprints/combat_modes.py` | 静态追加三种内置模式并固定启用 | 从统一注册表查询实际安装、授权和启用状态 |
| `src/blueprints/sessions.py`、`src/session_manager.py`、`src/session_export.py` | 内置、横版、外部插件绑定与恢复分叉 | 统一模式锁、运行信封、快照与导入导出 |
| `src/SceneManager.py`、`src/blueprints/chat.py` | 提示词、遭遇提取与简报按具体模式判断 | 按已绑定能力提供提示片段、结构化提取和遭遇服务 |
| `src/blueprints/combat.py`、`src/blueprints/sideview.py` | 玩法实现及专属路由在宿主内 | 玩法放插件，宿主只提供运行与能力网关 |
| `frontend/src/App.tsx`、`components/session/CreateSessionWizard.tsx` | 组件路由、模式卡片和默认值硬编码 | 注册表驱动模式选择、页面挂载与配置表单 |
| `frontend/src/features/combatModes/RuntimeFrame.tsx` | 动态脚本仅在专用战斗容器运行 | 复用消息边界，扩展为可挂载到多个受控区域的运行器 |
| `frontend/src/plugins/index.ts`、`plugins/scenePanels.tsx` | 场景插件构建期导入，Context 暴露完整 API | 统一运行期注册；外部插件只拿范围化能力，不拿完整 REST 客户端 |
| `frontend/electron/main.ts`、`preload.ts` | 已有桥接能力，但不是完整插件权限体系 | 明确 frame/sender 校验、导航策略、资源访问与安全模式 |

历史实现已记录 PC 浏览器验收通过，Electron 专有行为未覆盖；该记录只作现状证据，不代表本计划中的新架构已验收。参考 `docs/proposals/combat-mode-plugins.md` 与 `docs/archive/combat-plugin-pc-qa-2026-10-06.md`。

## 3. 范围与基本决策

### 3.1 本次包含

1. 统一插件包、版本存储、注册、授权、启停、卸载、默认安装与恢复。
2. 三种官方玩法的真实拆包，保留当前完整玩法、演练、保存与恢复能力。
3. 受控前端扩展点、普通隔离视图和高信任模块运行方式。
4. 会话固定模式、世界书适配、资源冻结、运行状态、结算与回档。
5. 当前相关旧路径清理、作者工具、诊断与 PC/Electron 验收。

### 3.2 本次不包含

- 插件商店、账号、远程同步、自动更新、联网下载依赖、任意安装脚本。
- 跨插件版本存档迁移、旧状态 Schema 兼容、运行中升级/切回、卸载后从存档副本运行插件。
- 存档内嵌或自动安装可执行插件包；导入必须预先安装精确版本和依赖，不提供兼容适配层。
- 任意 Python/Node 原生扩展的安全沙箱、恶意代码绝对隔离或反作弊保证。
- 把角色、世界书、基础聊天等全部宿主功能一起拆成可卸载插件。
- 重写战术或横版的核心玩法、添加新关卡、重新平衡敌人与数值。
- 手机窄屏适配；当前仅面向 PC。
- 未经确认迁移、覆盖或清理真实历史存档。

### 3.3 已确定原则

- 保留模式 ID `narrative`、`tactical`、`sideview`，避免无意义改名；它们只是官方包标识，不拥有特殊生命周期。
- V1 一个战斗插件提供一种模式，插件 ID 与模式 ID 一致；依赖可为资源包或共享库，不提前引入多模式包复杂度。
- `combat_mode` 创建时固定，取插件 ID 或显式 `null`；`modeLock` 固定精确版本与摘要。`null` 表示无结构化战斗插件，不是叙事战斗的别名。
- `pluginId + version` 是独立安装项，摘要用于完整性与同版本冲突校验；1.0 与 2.0 可并存，不覆盖、不自动改绑。新版本必须新建会话，旧会话只有在原版本仍已安装、启用并获授权时才能运行。
- 卸载以精确版本为单位；依赖会话未删除、依赖包未处理或实例未关闭时拒绝。卸载操作不代替用户删除存档，不保留“已卸载但存档仍可执行”的旁路。
- 叙事战斗可卸载，基础叙事、对话与世界书不可因此消失。自然语言仍可描述冲突，但不会暗中调用已卸载的战斗规则。
- 默认安装只发生于明确的新数据目录初始化。卸载或停用意图不能被启动扫描、应用升级或默认值补齐覆盖。
- 插件控制自己的玩法与 UI；宿主拥有最终数据提交权、恢复入口和权限决定权。
- 不把三种玩法强行统一为同一种状态结构或执行引擎，只统一外部契约。

## 4. 模块边界与目标目录

### 4.1 宿主职责

宿主保留会话与剧情树、世界书与资源访问、LLM 调用与密钥、权限、包管理、版本锁、持久化事务、角色公共数据、结果提交、前端布局框架和故障恢复。

宿主可以提供通用随机数、受控模型请求、事件流和数据事务能力，但不得以“通用服务”为名继续内置卡牌规则、横版碰撞或某种战斗的胜利条件。

### 4.2 插件职责

| 官方插件 | 插件内职责 | 宿主边界 |
|---|---|---|
| 叙事战斗 | 冲突处理模板、战斗行动与可选检定、叙事战斗状态、结果生成、消息与侧栏视图 | 模型调用和密钥留宿主；基础对话流程不搬走；不要把当前全局社交/探索检定全部挪入战斗包 |
| 回合战术 | 棋盘、回合、卡牌、敌方 AI、战斗属性算法、战术快照、节点编辑与完整演练 | 公共角色读取、资源授权、剧情结果提交走 SDK |
| 横版动作 | 实时输入、碰撞与模拟、关卡、PixiJS 演出、检查点、结果校验、关卡编辑 | 浏览器本地驱动帧循环；只在检查点/结果时与宿主同步 |

### 4.3 目标目录（待新增，不表示已存在）

```text
src/plugins/                    # 通用后端宿主
  packages.py                   # 包校验、导出、内容摘要
  registry.py                   # 精确版本安装/启用/依赖/授权/会话引用
  lifecycle.py                  # 独立安装、激活、停止、卸载与恢复
  bindings.py                   # 世界书适配预检与会话锁
  runtime.py                    # 通用运行信封与状态机
  capabilities.py               # 范围化能力网关
  worker.py                     # 可信 Python 进程协议与生命周期
  settlement.py                 # 通用结果提交与收据
frontend/src/features/plugins/  # 注册表、插槽、加载器、消息桥、管理 UI
plugin_sdk/                     # Python SDK 与协议源
frontend/plugin-sdk/            # TypeScript SDK 与作者构建入口
plugins-src/narrative/          # 官方包源码、Schema、资源与测试
plugins-src/tactical/
plugins-src/sideview/
resources/default-plugins/      # 发布时生成的官方离线包与受信目录
data/plugins/inbox/             # 用户复制目录或 ZIP 的发现入口，不原地执行
data/plugin_store/sha256/       # 按摘要保存的不可变包与验证后的资源
data/plugin_registry.sqlite3    # 注册、授权、引用、操作日志、初始化记录
```

路径集中通过项目数据根解析，支持隔离数据目录，不在模块导入时创建真实目录。官方前端构建与宿主前端构建分离；运行期只加载插件产物，宿主不可静态 import 官方玩法源码。

首版使用 Python 标准库 SQLite 管理注册表与操作记录，不为这项功能新增数据库服务。会话继续采用宿主现有存储；不能声称 SQLite 与会话文件天然处于同一事务，跨存储一致性按第 8 节实现。

## 5. 包格式、版本与发布规则

### 5.1 新契约

包格式 `ark-plugin/1`；战斗运行接口 `ark-combat-runtime/1`；二者版本分开。包版本使用 SemVer 作为版本标识，不承诺不同版本的状态兼容；内容身份同时绑定 `id + version + digest`。不把应用版本、SDK 版本、内容 Schema 版本混成一个数字。

清单示例（仅定义目标结构，P0 须据此落成严格 Schema）：

```json
{
  "format": "ark-plugin/1",
  "id": "tactical",
  "name": "回合战术",
  "version": "1.0.0",
  "hostApi": "^1.0.0",
  "ui": {"runtime": "trusted-ui", "entry": "ui/main.js", "styles": ["ui/main.css"]},
  "engine": {"runtime": "trusted-python", "entry": "engine/main.py"},
  "combat": {
    "api": "ark-combat-runtime/1",
    "contentPolicy": "required",
    "inputSchema": "schemas/encounter.json",
    "stateSchema": "schemas/state.json",
    "resultSchema": "schemas/result.json"
  },
  "permissions": ["session.read", "worldbook.bound.read", "plugin.state.write", "combat.result.propose"],
  "dependencies": [],
  "contributes": [
    {"id": "battle", "slot": "combat.main", "scope": "session", "view": "battle"},
    {"id": "node-editor", "slot": "worldbook.editor", "scope": "worldbook", "view": "node-editor"}
  ]
}
```

- `contentPolicy` 为 `none | optional | required`。叙事战斗默认 `optional`，不能因为零世界书就无法创建；战术/横版需要完整遭遇输入或包内显式默认内容。
- UI 与引擎执行等级分别声明，由宿主授权决定能否激活，不能通过清单自行提权。
- `contributes` 声明视图 ID；入口导出对应视图工厂与激活/释放方法，不能在列目录时执行模块来发现视图。
- Schema 使用固定 JSON Schema 草案，禁止远程 `$ref`，限制大小、深度与校验资源消耗；选择依赖前先检查项目现有实现，新增依赖需说明理由。
- 未知执行能力、未知必需字段、重复贡献 ID、冲突依赖和不支持的接口版本必须报错，不静默忽略。

### 5.2 包完整性与依赖

- 延续路径穿越、链接/junction、Windows 保留名、重复 JSON 键、大小写冲突、解压大小及压缩炸弹检查。
- 内容摘要覆盖排序后的规范相对路径与原始文件字节；不以 ZIP 压缩结果作为唯一内容身份。签名材料与 payload 摘要分开，避免自引用。
- 同 ID 同版本同摘要重复安装为幂等成功；同 ID 同版本不同摘要为冲突，不覆盖。
- 多版本是独立安装项；新建会话显式选择精确版本，不选择“最新版”来替代旧会话绑定。依赖在安装时固定精确版本与摘要，运行时不重新解析或自动升级。
- 依赖使用依赖图校验，拒绝循环；缺依赖给出完整链路，不联网补装。
- 依赖库只按声明入口导入，不因被依赖自动注册全局 UI；共享库不能越过调用者的能力范围。
- 安装仅做静态验证与入库，不 import Python、不执行 JS、不运行 pip/npm 或安装生命周期脚本。
- 先保留现有包大小防线；P0 测量三种官方产物后制定宿主级大小档位与硬上限。插件不能自行调大配额，不能直接取消限制。
- 源目录复制到 inbox 后先验证、再复制到不可变存储；编辑源目录不会影响已安装版本或存档。开发热更只用于隔离开发数据。

### 5.3 官方身份

官方身份由随应用发布的受信目录绑定精确包摘要确认；外部声称 `official` 或使用同名 ID 不产生信任。官方 ID 的发行归属可以受保护，但停用、卸载、导出仍走统一流程。

首版不依赖在线签名服务。官方目录外的新版本按外部包处理并明确提示来源变化；不得默默继承旧版本的高信任授权。

## 6. 前端扩展协议

### 6.1 首批扩展点

| slot | 数量/策略 | 默认作用域 | 用途 |
|---|---|---|---|
| `session.create.options` | 按所选模式唯一提供者 | 创建向导 | 模式配置，宿主仍掌握身份/世界书/创建提交 |
| `combat.main` | 当前会话绑定唯一提供者 | 会话 | 完整战斗页，可用 React/Canvas/PixiJS |
| `session.toolbar` | 多项有序追加 | 会话 | 战斗动作与入口 |
| `session.sidepanel` | 多项追加或显式替换指定面板 | 会话 | 状态、装备、队伍等 |
| `message.renderer` | 按消息类型命名空间唯一提供者 | 会话 | 简报、检定、结果消息 |
| `worldbook.editor` | 多页追加或显式替换匹配类型编辑器 | 世界书 | 节点、地图、关卡编辑 |
| `app.page` | 插件命名空间路由 | 应用 | 演练、卡组、工具页 |
| `settings.section` | 多项追加 | 应用或会话 | 按键、表现、模式设置 |

内部贡献键使用 `pluginId@version:contributionId`；路由使用 `/plugins/<pluginId>/<version>/<pageId>`。版本身份由 SDK 注入，作者只定义包内 contributionId/pageId。排序为宿主分组、用户显式顺序、稳定键，不按加载时序覆盖。替换必须声明目标、兼容接口和 `ui.replace:<slot>` 权限；多方争抢时要求选择，不能让“最后加载者获胜”。

全局启用不代表在所有会话挂载。会话扩展必须来自该会话绑定且仍已安装、启用、获授权的版本；管理页逐版本展示，独立页面显式选择版本，不使用默认版本切换机制。内部贡献键/路由须包含版本身份（由 SDK 注入），避免同 ID 的两个安装版本冲突；插件作者只声明包内贡献 ID。

### 6.2 插件 SDK

前端提供 `activate(context)`、`mount(viewId, element, props)`、`deactivate()`；挂载返回 disposer。Context 提供范围化命令、事件订阅、资源句柄、自身状态读写、宿主主题只读信息与取消信号。

- 外部插件不获得宿主 store、完整 `useApi`、原始会话目录或其他插件 Context。
- 命令和事件必须有命名空间、Schema、范围与上限；宿主不接受任意 JavaScript 回调作为跨边界协议。
- 资源、事件、快捷键、音频、requestAnimationFrame、计时器由 SDK 统一登记并随实例停止清理，作者不手写重复的生命周期账本。
- 插件作者只实现当前包版本的玩法、视图、动作、快照/恢复和结果逻辑；不编写旧版本迁移或兼容分支。宿主与 SDK 封装版本绑定、epoch/revision、租约、凭据、幂等与事务恢复，不把宿主协调器实现负担转交作者。
- 插件弹层挂在自己的 overlay root；同上下文模块不能依靠直接 portal 到 body 作为公共契约。
- 插件内自由布局；宿主区域遵循 `docs/design/frontend-design-guidelines.md`：无标题副文案、无 Emoji 功能图标、统一 SVG、按钮无渐变、保留焦点与错误说明。
- 战斗内容区继续不参与宿主换肤；不手改皮肤生成覆盖块。仅 PC 桌面尺寸验收。
- 宿主保留返回、停止、授权、错误与恢复 UI；插件不能替换这些区域或拦截全部退出快捷键。

### 6.3 两种 UI 运行方式

普通外部插件使用 `sandboxed-ui`：由宿主挂载 iframe 到声明 slot，完整战斗页也可由其占据；面板较多时复用会话级控制通道，实例互相隔离。不以“只能一个小窗口”限制插件产品能力。

高信任模块使用 `trusted-ui`：运行期加载预编译 ES module 与样式，在宿主组件环境中渲染。SDK/React 外部依赖清单固定，其他依赖由包自带，禁止访问宿主内部模块路径。不同版本产生不同模块 URL；发生无法可靠热卸载的情况要求保存后重载宿主。

`trusted-ui` 与宿主同上下文，无法承诺对恶意代码强制最小权限；授权 UI 必须明示这一点。Shadow DOM、CSS scope、ErrorBoundary 只解决样式/故障问题，不是安全沙箱。

## 7. 执行环境与权限

### 7.1 运行器

- `browser`：普通脚本玩法在受限视图内运行，保存与结果经宿主桥接；横版等实时模拟可在其被授权的前端环境中驱动，不逐帧请求后端。
- `trusted-python`：用于抽出的现有战术逻辑、叙事规则或可信结果校验器。宿主管理专用进程，通过受限结构化 RPC 交互，不能在 Flask 导入插件并注册任意 Blueprint。
- 宿主调用统一 `validateInput / createRun / dispatch / snapshot / restore / proposeResult / dispose` 接口；不要求每种引擎都接收实时帧或棋盘命令。
- Python 插件使用宿主公布的运行环境和 SDK 版本，依赖显式声明；首版不支持任意本地扩展编译或运行期 pip 安装。实际缺依赖则拒绝激活并定位原因。
- 进程管理必须在 Windows 可靠回收子进程及后代；启动隐藏窗口，不影响用户桌面。

### 7.2 能力模型

普通实例授权绑定 `pluginId + digest + instanceId + sessionId + epoch + capability`，用短期不透明凭证鉴权；客户端传入的 ID 不作为身份依据。每次写入由后端复核授权、实例状态和会话锁。

首批能力：`session.read`、`worldbook.bound.read`、`assets.bound.read`、`plugin.state.write`、`llm.request`、`combat.result.propose`、`ui.replace:<slot>`。外部网络和文件系统默认不开放；本次不提供任意 shell、任意 URL 代理或通用 SQL 能力。

- 插件私有状态命名空间由宿主注入，不让调用者自由指定其他插件命名空间。
- 读取世界书只限绑定内容；编辑世界书走用户当前打开对象的编辑凭证、Schema 校验和 `_hash`/revision 冲突检测，不能任意写路径。
- 公共角色数值与奖励只能通过宿主结果事务更新；插件状态写权限不等于角色写权限。
- LLM 凭证与服务商选择留宿主；插件只提交受控请求。超时/取消按 LLMError 处理，不变成剧情回复。
- 模型任务使用 request ID 和已完成结果收据；网络中断导致完成状态不明时显式标记，不能承诺第三方调用天然 exactly-once 或自动无费用重试。

### 7.3 安全边界与撤销

普通容器保留 `sandbox="allow-scripts"`、消息 source/token/版本/序号/大小检查与 CSP；资源 MIME、导航、弹窗、下载和 Electron frame 行为分别验证。不能单靠 CORS 或 `Origin:null` 作权限判断。

Electron IPC 验证 sender、frame 与操作参数；只接受宿主窗口的白名单操作。若支持打开目录，使用宿主发出的目录句柄而非插件任意路径。

可信 Python 子进程隔离的是生命周期和故障，不是操作系统权限。高信任包可造成与本地代码类似的风险，非官方包必须逐版本明确授权；不能宣传为可安全运行任意代码。

撤销普通实例：先持久化拒绝规则、停止接受命令，再销毁视图、资源和 worker。撤销同上下文高信任 UI：完成能安全完成的保存后，进入无该插件的宿主重载；不能把调用 `deactivate()` 当作彻底移除所有代码。无法保存时说明最近检查点，不能无限等待插件配合。恶意代码已经造成的系统副作用不在撤销可恢复保证内。

## 8. 安装生命周期、版本引用与默认安装

### 8.1 持久化记录

注册表按 `pluginId + version` 保存摘要、启用状态、来源、授权、精确依赖、会话引用、活动实例、初始化与操作日志。删除运行期默认版本切换职责；可用性由安装、启用、授权、当前宿主接口和依赖共同判断，不用一个 `enabled` 代替全部状态。

同一数据根只允许一个写宿主；第二个 Flask 实例应明确拒绝占用。会话创建、导入、删除和卸载共用宿主准入与持久引用检查，防止“检查无依赖后又新建会话”的竞态。不同隔离数据根可并行运行。

### 8.2 操作语义

| 操作 | 新会话与入口 | 既有会话 | 文件和数据 |
|---|---|---|---|
| 安装/启用精确版本 | 静态校验、授权与依赖满足后可选 | 只允许恢复原来绑定的同版本 | 不覆盖其他版本或存档 |
| 停用精确版本 | 移除该版本入口，禁止新建 | 保存/暂停并关闭实例；重新启用前不执行 | 保留安装包和存档，不提供存档专属运行旁路 |
| 安装新版本 | 作为另一安装项，使用它必须新建会话 | 不改绑、不转换、不重放旧状态 | 旧版本仍是正常安装项，直到用户显式卸载 |
| 撤销信任 | 禁止相关摘要激活 | 停止相关实例，保留只读管理/导出 | 不自动删档；重新启用不等于重新授权 |
| 删除会话 | 走宿主独立删除操作，明确用户确认 | 先停止实例并处理未完成事务，再删除存档 | 持久删除完成后释放版本依赖；失败仍阻止卸载 |
| 卸载精确版本 | 预览依赖；实际执行前重新检查 | 必须先单独删除全部依赖会话 | 依赖包与演练占用也须先处理，实例关闭后删除安装项和包文件 |

卸载入口列出依赖会话的名称/ID、版本、依赖包和运行实例，并提供会话管理入口。有依赖返回 `ACTIVE_REFERENCES`；关闭或隐藏会话不等于删除。卸载不得隐式删除存档，不自动转存为可执行冻结副本，也不级联卸载其他包。

本地已导出的离线备份不作为常驻安装引用；卸载后再次导入该备份必须重新安装原精确版本和依赖。无法取得原包时不承诺恢复，不改用新版本。

### 8.3 默认安装

- 在全新数据目录首次初始化时，从受信离线目录经统一校验安装并启用三种官方包的明确版本；官方目录按摘要提供预置信任。
- 为每个默认项记录成功/失败/用户停用/用户卸载状态，失败可诊断重试，但不能覆盖用户决定。
- “默认安装”只指首次初始化的发行清单，不是运行时默认版本指针；不能因包目录为空就再次初始化。
- 应用升级只刷新发行目录，不自动安装新版本、重新启用旧项或修改会话绑定。
- “恢复默认插件”先预览精确安装/启用项，不删除第三方包、存档或覆盖用户设置。
- 官方玩法包不是世界书内容包，不改变启动时不自动安装世界书的约束。

### 8.4 崩溃一致性

安装沿用“临时目录验证 → 操作日志 → 发布不可变内容 → 提交注册状态”；授权后才执行。新版本安装失败只清理本次未完成安装，不需要恢复旧版本指针或迁移用户数据。

会话创建/导入先验证本机精确安装项及依赖，在同一准入规则下登记引用，再发布存档。`modeLock` 记录版本和摘要；会话不复制可执行包，世界书输入/资源冻结按 §9 保留。启动恢复处理未完成发布或引用登记，不发布引用缺失安装项的会话。

卸载在写准入下重新检查会话/依赖包/演练/活动实例与未完成操作；无占用才进入卸载日志，先禁止新绑定再移除文件与注册记录。中断可恢复，不能留下“仍可运行却缺文件”的安装项，也不能把待恢复删除当作已解除引用。

保留必要的持久引用与活动实例检查；不再设计卸载后的存档专属包、独立执行资格或长期保留包垃圾回收层。内容存储若共享相同摘要字节，仅在没有其他正常安装项引用时删除。

## 9. 世界书、会话锁与运行契约

### 9.1 内容适配

保留世界书侧 `combat/modes/<pluginId>.json` 作为适配入口，新内容按插件 Schema 验证。模式包负责玩法接口，世界书负责遭遇输入、奖励规则与资源映射；SillyTavern 外部导入导出保持兼容。

预检包含包/依赖/宿主 API、授权需求、内容策略、输入类型、资源引用、剧情遭遇引用、配置、阵容字段和大小限制。多书遭遇使用 `bookId:localEncounterId` 作为解析后的唯一键；短引用必须在来源书中解析，无法消歧就报错。

返回按 `bookId + file + jsonPath + errorCode` 定位的错误，以及预检摘要。摘要覆盖所选包/依赖、适配内容、配置和冻结资源；创建时重新计算，变化返回 409。权限仍在创建和运行时重新校验，不因摘要相同就复用旧授权。

冻结范围是世界书提供的玩法输入和资源，不复制可执行插件包；包内资源从仍已安装的精确版本读取。世界书内容冻结与插件版本兼容是两件事，本次保留前者，不把整本世界书的所有叙事内容锁死。后来编辑世界书不改变已有会话的战斗输入；若剧情新引入未冻结遭遇，明确报不兼容，不偷偷读取最新版适配。

### 9.2 会话锁

会话保存 `combat_mode`、`modeLock` 和统一战斗运行状态。`modeLock` 记录精确包/依赖版本及摘要、当前宿主接口要求、状态 Schema 标识、配置摘要与冻结内容/资源索引；只记录包引用，不保存可执行包副本。授权独立保存在本机，不信任存档里的授权布尔值。

绑定在会话创建时固定；更换任何插件或依赖版本必须新建会话，不能通过改写锁文件、导入或“另存为”迁移旧战斗状态。作者只负责当前版本自己的快照恢复，不实现跨版本 Schema 转换。

同一版本内的剧情回档继续保留：运行态、战斗历史、角色变化与完成收据随节点一起恢复，包绑定不变。回档生成新执行 epoch、拒绝旧实例写入，属于宿主可靠性职责，不是版本兼容功能。

导出只包含会话数据、版本需求清单、冻结世界书内容与必要资源，不内嵌可执行插件包。导入前必须已安装清单中的精确版本及匹配摘要的依赖，并通过当前接口、Schema 和本机授权检查；缺失、摘要不符或不支持即明确拒绝，不自动安装、换版或继承外机信任。检查失败不发布半个会话。

会话运行要求绑定版本仍已安装、启用并获授权。缺包、停用、接口不支持、环境缺失、损坏或撤信任时，保留会话只读管理/导出/删除入口，阻止插件执行，不回退到叙事或最新版。只校验当前支持的宿主接口，不维护旧宿主/旧插件兼容适配层。

### 9.3 统一运行信封

```text
runId, sessionId|null, pluginId, packageDigest, bindingDigest,
epoch, revision, status, encounterRef, stateSchemaVersion,
snapshot, resultProposal, completionReceipt, timestamps
```

状态机：`created -> active <-> suspended -> settling -> completed`；`active -> settling` 亦合法。失败作为可诊断 `faulted` 状态，保留最近检查点；只能经恢复操作进入 suspended/active，或由宿主执行受控放弃。

- 创建与执行命令均带幂等键；写入检查 `runId + epoch + revision`。重复同请求返回原结果，不同请求冲突返回 409。
- 回档撤销所有旧实例授权并生成新的执行 epoch；不能仅回退 revision 后接受旧标签页的写入。
- 关闭视图不代表胜利/撤退；先保存并暂停。暂停、待结算期间阻止会造成剧情越过未完成战斗的推进。
- 战术在动作/回合边界保存；横版以关卡检查点和主动保存为主，固定点同步不等于每帧请求；叙事战斗以行动确认边界保存。
- `snapshot` 是插件私有 Schema，宿主只校验、持久化和按需交给对应校验器，不把所有状态硬凑成棋盘结构。
- 演练复用同一运行器，`sessionId=null`、独立存储、独立角色副本；即使提交结果也不能写真实会话或发奖励。
- 强制终止必须显示最近成功保存时间，避免承诺保留未确认内存态。

### 9.4 叙事衔接

用能力提供者替换模式分支：`prompt.contribution`、`encounter.catalog`、`combat.trigger.extract`、`combat.briefing`、`combat.result.describe`。只有当前会话锁定提供者可影响该会话，不把所有已启用模式一起注入。

固定玩法规则进入稳定层，当前战斗状态进入动态层；常驻 position-0 世界书与触发型世界书仍遵守既有分层。插件不能重排或覆盖宿主完整系统提示词。

LLM 输出与插件输出都视为待验证数据，不能直接触发宿主命令。涉及战斗阻塞、结果或状态一致性的 hook 失败必须显式阻断，不能沿用“记录 warning 后继续剧情”的吞错路径。流式与非流式叙述必须走相同门禁。

## 10. 结果、奖励与跨存储提交

插件只能提出结果：胜败/撤退、允许的统计、证据、叙事摘要和效果请求。宿主区分 `client_reported`、`user_accepted` 与 `host_validated`；官方来源不自动等于胜利已验证。

- 客户端自报结果默认不自动领取公共奖励；用户确认不将其改标成“规则已验证”。
- 公共奖励根据会话锁内的奖励规则、可信校验结论与宿主政策计算，不能接受插件直接给出的经验、物品或角色值。
- 若产品允许对未验证结果发放奖励，必须是另行授权的清晰策略，不在本次默认开启。
- 可信引擎可提交带状态/动作摘要的证据，由绑定校验器验证。横版快照合法性和最短耗时检查不等于完整反作弊；验证级别如实记录。
- 插件私有数值可以在自身状态中更新；映射到公共角色和物品时仍走宿主结算。
- 通用提交应复用现有 `combat_settlement.py` 中可复用的原子写入能力；玩法奖励公式与玩法属性成长留插件，不能为了统一而丢失既有战术/横版效果。

提交事务单位为：最终结果、角色/物品变更、战斗历史、剧情继续动作与完成收据。统一以 `runId + epoch + proposalDigest` 关联。先持久化意图日志，再按宿主事务能力提交各项；崩溃恢复根据收据重放未完成步骤或回滚未发布更改，禁止只完成一半就向前端返回成功。

重复确认返回同一收据；失败保留 settling 可重试；回档整体撤回该剧情分支的结算效果，旧 epoch 消息永久失效。不能仅在内存里加锁就宣称跨文件事务已经原子。

## 11. API 与错误契约

以下为新接口目标；P0 固化请求/响应 Schema 后前后端按同一契约开发。

| 接口 | 职责 |
|---|---|
| `GET /api/plugins` | 版本、来源、启用/授权/兼容状态、引用与诊断 |
| `POST /api/plugins/install` | 有界 ZIP 静态安装，返回版本与权限需求 |
| `POST /api/plugins/discover` | 扫描配置好的 inbox，验证并导入；不接受任意绝对路径 |
| `PUT /api/plugins/<id>/versions/<version>/enabled` | 按精确安装项启停，配合 registryRevision，不跳过授权 |
| `POST /api/plugins/<id>/grants` | 宿主用户确认后授予指定摘要权限，非插件可调用能力 |
| `POST /api/plugins/<id>/revoke` | 撤销指定版本或全部版本信任，停止实例并阻止复活 |
| `POST /api/plugins/<id>/versions/<version>/uninstall-preview` | 列出阻止卸载的依赖会话、包与实例；不删除任何存档 |
| `DELETE /api/plugins/<id>/versions/<version>` | 写准入下重验依赖；会话未删除或实例未关闭则拒绝，通过后删除安装项 |
| `GET /api/plugins/<id>/versions/<version>/export` | 导出完整包；停用不影响导出 |
| `POST /api/plugins/defaults/restore` | 根据确认的预览恢复默认插件 |
| `POST /api/combat-modes/<id>/compatibility` | 必填精确版本，校验当前接口与内容并返回摘要；不做跨版本兼容转换 |
| `POST /api/sessions` | 接受 combat_mode、精确版本与预检摘要，固定绑定并登记安装引用；null 无版本 |
| `GET /api/sessions/<id>/combat` | 统一运行状态，不泄露包外文件路径 |
| `POST /api/sessions/<id>/combat/runs` | 创建战斗，模式由会话锁确定 |
| `POST /api/combat-runs/<runId>/commands` | 受限命令与 epoch/revision/CAS |
| `PUT /api/combat-runs/<runId>/snapshot` | 保存检查点；服务器权威引擎拒绝客户端覆盖权威状态 |
| `POST /api/combat-runs/<runId>/result` | 结果提案，不直接发奖 |
| `POST /api/combat-runs/<runId>/confirm` | 宿主用户确认与结算，不作为插件自授权能力 |
| `POST /api/combat-runs/<runId>/suspend`、`resume` | 明确暂停与恢复 |
| `POST /api/plugins/<id>/practice-runs` | 显式选择精确版本创建隔离演练，运行期间阻止卸载 |
| `GET /api/combat-runs/<runId>/events` | 带事件序号的运行状态流，可重连取完整状态 |

统一错误体：`code, message, details, retryable, operationId`。至少覆盖 `PLUGIN_NOT_INSTALLED`、`PLUGIN_DISABLED`、`TRUST_REQUIRED`、`TRUST_REVOKED`、`HOST_API_INCOMPATIBLE`、`DEPENDENCY_MISSING`、`BINDING_STALE`、`STATE_CONFLICT`、`SNAPSHOT_INVALID`、`RUNTIME_FAILED`、`ACTIVE_REFERENCES`、`LEGACY_FORMAT_UNSUPPORTED`。

权限错误、缺失资源、CAS 冲突、执行故障分别表达；不把所有错误转换成 500 或模型回复。CORS、Electron opaque origin 与用户确认接口分别设计，不使用一个 `trust:true` 请求字段代替宿主授权系统。

## 12. 分阶段任务与门槛

任务默认未完成。先执行 §35 的策略收敛与旧实现清理，再按依赖推进后续阶段。每阶段记录实际提交、测试命令、结果、证据位置和未覆盖项；不能用上一版测试报告给本轮勾选。

### P0：契约冻结与拆包风险验证

- [ ] 阅读当前架构、前端规范、战斗规范，重新核对 Git/并发/数据根；从 main 建隔离 feature worktree。
- [ ] 盘点三种玩法的代码、资源、依赖、玩法测试、编辑器、导出格式与宿主调用，形成所有权清单。
- [ ] 按版本独立安装规则修订 manifest、SDK、UI slot、命令、状态机、内容、结果和错误 JSON Schema；包内 ID 不要求作者手工拼版本。
- [ ] 明确作者只实现当前版本逻辑；版本锁、epoch、租约、凭据、幂等与恢复由宿主/SDK 封装，不新增旧状态迁移接口。
- [ ] 明确无战斗插件、零世界书、默认初始化、历史数据目录的行为。
- [ ] 验证动态前端模块在 Vite/PC 浏览器/Electron file 场景可加载、可诊断、可重载；资源不能依赖开发服务器特殊路径。
- [ ] 验证战术 Python 最小闭环能够在独立进程经 SDK 完成一次状态读写，不依赖任意宿主对象或运行期 pip。
- [ ] 量化包体、依赖与实时运行基线，确定配额、心跳、操作超时和性能预算。
- [ ] 使用隔离新数据与重建夹具落实“不迁移旧档”的决定；真实历史数据不自动转换或删除，未来删除由用户在明确列出对象后单独确认。

门槛：协议能表达三种现有玩法；真实拆包技术路径可行。若必须改变信任范围、安装依赖或公共产品规则，先报告，不能以临时宿主特例绕过。

### P1：包存储、注册与安装闭环

- [ ] 实现逐版本不可变安装项、精确依赖、启用/权限记录和写宿主互斥，移除默认版本切换职责。
- [ ] 实现文件夹发现、ZIP 安装、包导出、逐版本启停与卸载预览；先单独删除依赖会话，再重验引用并卸载，不保留卸载后的包副本。
- [ ] 覆盖预览后新建会话、删除失败、活动实例与未完成事务占用；相关依赖未解除时可靠拒绝卸载。
- [ ] 实现默认安装日志、卸载意图保留、显式恢复默认插件。
- [ ] 实现安装崩溃恢复、同版本冲突和坏包诊断。
- [ ] 新增独立最小示例包，不依赖三种官方模式即可通过安装流程。

门槛：安装全程不执行包代码；重启后状态一致；重复安装、恶意包、依赖缺失与并发操作可诊断；不需要重建前端。

### P2：前端扩展、能力网关与运行器

- [ ] 实现可撤销注册表、各 slot、作用域、冲突规则、宿主恢复栏。
- [ ] 实现 sandboxed-ui 与 trusted-ui 加载器、版本化资源 URL、生命周期清理及安全模式重载。
- [ ] 实现范围化能力与实例授权，移除外部面板完整 API 权限。
- [ ] 实现可信 Python RPC、超时、取消、日志、Windows 进程回收。
- [ ] 实现 Electron 导航/frame/IPC 策略；不得暴露插件任意路径或 shell。
- [ ] 最小插件演示独立页面、战斗区、侧栏和一个编辑扩展，启停后无残留。

门槛：权限未授予不执行；撤销后旧实例请求全部失败；宿主可停止、返回与恢复；高信任重载行为在真实 Electron 验证。

### P3：统一会话、内容绑定与运行状态

- [ ] 实现完整 Schema 预检、内容策略、来源书消歧与摘要过期检查。
- [ ] 实现 modeLock 精确安装引用、世界书内容/资源冻结、创建提交日志；移除会话内可执行包副本，导入前检查已安装的精确版本/摘要与本机授权。
- [ ] 实现统一 run 状态机、epoch/revision、快照、暂停、恢复、故障处理和独立演练。
- [ ] 将创建向导、App 路由、简报、叙述、手动入口与恢复入口改成注册表/能力驱动。
- [ ] 接入受控提示片段与结构化事件，流式/非流式共用执行门禁。
- [ ] 覆盖无模式、空内容、不同版本独立新建会话、旧会话禁止改绑、依赖会话阻止卸载、回档旧消息和损坏存档。

门槛：最小第四种模式无需宿主专用分支即可完成“创建会话—开始—保存—重载—结束—回剧情”。

### P4：三种官方模式真实拆包

- [ ] 先拆叙事战斗：保留基础叙事；把冲突处理能力、必要消息和配置放入插件，不强制新增回合 UI 或改变原体验。
- [ ] 再拆横版：迁移模拟、输入、表现、资源、关卡、检查点和校验器；保证实时循环与恢复行为。
- [ ] 再拆战术：迁移规则、战斗状态、AI、卡牌、地图、前端战斗组件与节点编辑，逐个切断宿主玩法依赖。
- [ ] 将双方共用的真实通用能力抽到 SDK；专属算法不得以共享模块名留在宿主。
- [ ] 为每个官方包生成独立产物、包内测试与最小演练；明确演练资源不自动装入用户世界书。
- [ ] 在没有另外两种模式的隔离数据目录分别安装与运行，验证每个包的依赖声明完整。

门槛：宿主构建无官方玩法静态导入；去掉任意包只影响其声明功能；安装包不依赖源码目录；三种模式功能保持。

### P5：统一结果提交与剧情一致性

- [ ] 提取通用结算提交器，玩法计算留对应插件，公共数据更新留宿主。
- [ ] 实现结果可信等级、奖励策略、提案摘要、用户确认与幂等收据。
- [ ] 实现跨文件提交日志与故障恢复，覆盖保存失败、崩溃和重复请求。
- [ ] 统一战斗运行、角色/物品变化、历史与收据的剧情回档。
- [ ] 验证自报结果不能直接发奖、撤退不伪装胜利、演练不写真实会话。

门槛：三种模式与第四种示例均能完成结果闭环；失败可重试且无半结算、重复奖励或旧 epoch 写入。

### P6：旧路径清理、作者工具与分发

- [ ] 删除宿主业务中的 BUILTIN_IDS 特权、硬编码模式组件路由与新旧双运行路径。
- [ ] 将现有构建期自定义场景面板转换为明确包或开发示例；基础内置面板仍是宿主组件，不扩大为全面插件化。
- [ ] 新 API 切换完成后删除被替代的旧专属接口、旧 schema/测试/脚本与无用途兼容逻辑。
- [ ] 清理旧计划的默认版本升级/回退、会话携带可执行包、卸载后继续运行/专属激活及对应测试文档；保留精确引用、世界书内容冻结和同版本回档。
- [ ] SDK/模板封装版本身份与可靠性协议；以当前版本保存/恢复示例验收作者流程，不要求迁移脚本。
- [ ] 将原 `ark-combat/1` 示例改为新契约；旧包给出明确不支持错误，不维持双解析分支。
- [ ] 提供验证、构建、打包、安装、导出、演练 CLI 与模板，分别说明 UI/引擎权限和内容适配。
- [ ] 更新 README、架构、插件契约和 `docs/notes.md`，记录已清理位置与仍有消费者的范围。
- [ ] 官方离线包纳入发布构建；离线安装不调用 npm/pip，不依赖作者本机绝对路径。

门槛：第四种模式作者可按文档完成发布；宿主不存在必须同步改动的模式枚举或特殊 ID 分支。测试夹具、官方发行清单中出现三个 ID 不算业务硬编码。

### P7：最终验证、合并与交付

- [ ] 完成第 13 节验收矩阵和性能对比，失败项修复后重测。
- [ ] 按 `bash scripts/run_tests.sh` 跑全量；无可用 bash 时按 `docs/notes.md` 使用等价入口。
- [ ] 执行宿主构建、三种官方包独立构建/测试、协议测试、CLI 与导出导入测试。
- [ ] 检查 node_modules 包文件和 .bin；如测试损坏依赖，按项目规范恢复并再次构建。
- [ ] 完成当前提交的真实 PC 浏览器与 Electron 验收，不用历史截图或协议 stub 代替。
- [ ] 精确路径提交，确认并发停止后合并 main；未完成门槛不得宣称完成或擅自合并。
- [ ] 删除已合并分支/工作树前保存需要的任务与证据，清理必须可恢复且范围明确。

## 13. 验收矩阵

| 编号 | 场景 | 必须观察到的结果 |
|---|---|---|
| A01 | 全新隔离数据首次启动 | 三种官方包经同一校验流程安装启用；未导入世界书内容包 |
| A02 | 停用/卸载官方包后重启与升级 | 用户决定保持，不自动恢复 |
| A03 | 删除依赖会话后卸载全部战斗插件 | 基础对话、无插件会话、世界书管理可用；没有隐藏叙事战斗回退 |
| A04 | 分别仅安装一种官方包 | 完整玩法、资源、演练、保存/恢复均可用 |
| A05 | 安装第四种模式 | 无宿主源码修改、无宿主重建，前端扩展与正式会话均可用 |
| A06 | 坏 ZIP、路径穿越、链接、大小写冲突、超限、远程 Schema | 静态拒绝并定位错误；不执行代码、不损坏其他包 |
| A07 | 重复安装、版本冲突、缺依赖、循环依赖 | 幂等或明确冲突；不覆盖、不联网补装 |
| A08 | 新版本独立安装/创建会话/删除/卸载阶段崩溃 | 操作可恢复，无半安装或悬空引用；旧安装版本和未授权删除的会话不受影响 |
| A09 | 预检后改世界书/包/配置 | 创建返回摘要过期；不能用旧确认冻结新内容 |
| A10 | 1.0 与 2.0 独立安装并各自新建会话 | 各自使用精确版本；旧会话不能改绑或导入到 2.0，不转换状态，不串贡献 |
| A11 | 带依赖会话卸载精确版本，再单独删档后重试 | 先列出依赖并拒绝；删除成功、引用归零且实例关闭才可卸载；不保留可执行副本，不影响其他版本 |
| A12 | 导出/导入仅含数据与版本需求的存档 | 无可执行包；缺精确安装项、摘要不符或未授权则明确拒绝，不自动安装/换版，不发布半个会话 |
| A13 | 跨实例写入、旧 revision、回档旧 epoch | 请求拒绝，不覆盖新状态；已确认结果重复提交幂等 |
| A14 | 客户端伪造奖励或胜利 | 不接受任意角色/奖励值，可信等级记录真实 |
| A15 | 结算保存失败、断连、回档、重试 | 无半结算、重复物品、重复经验或剧情越过未完成战斗 |
| A16 | 停用时有活动全局/会话实例 | 保存/暂停并停止，重新启用前不执行；保留存档，无存档专属执行旁路 |
| A17 | 撤销普通与高信任插件信任 | 普通实例销毁；高信任视图重载、进程停止；旧凭证无效 |
| A18 | 插件报错、卡死、资源耗尽探针 | 宿主可停止或通过安全模式重启；保留检查点；不声称消除全部恶意代码风险 |
| A19 | UI slot 冲突、实例关闭与卸载 | 按精确版本隔离贡献；冲突可诊断，无监听/快捷键/音频残留；不要求运行中跨版本热切换 |
| A20 | PC 浏览器 1366×768 / 1920×1080 | 模式选择、管理、战斗、编辑器与弹层布局可操作，焦点/键盘/错误态清楚 |
| A21 | Electron 开发与打包环境 | 动态模块、资源、下载落盘、file 来源、preload、导航、worker 停止分别实测 |
| A22 | 无插件/仅叙事/横版/战术性能 | 启动只读清单、不全量加载玩法；帧率、内存、检查点延迟与 P0 基线比较 |
| A23 | 世界书外部互操作 | SillyTavern 导入导出与关键词注入语义保持；旧内部格式清理不伤外部契约 |
| A24 | LLM 取消、失败、未知完成状态 | 结构化错误与可诊断任务状态，不生成伪模型回复或自动不透明重试 |
| A25 | 卸载预览后新增会话/删除失败/演练或依赖包占用 | 执行时重新检查并拒绝；不能根据过期预览删包，不能隐式删档或级联卸载 |
| A26 | 作者修改源码并发布新版本 | 既有安装项和存档不变；同版本不同摘要拒绝，作者无需提供旧状态迁移代码 |
| A27 | 编辑世界书资源与同版本剧情回档 | 冻结内容不漂移；运行态与公共效果一致恢复，旧 epoch 拒绝，保留必要可靠性 |

浏览器/Electron 验收仅操作隔离数据和本任务服务，不重启用户正在运行的服务。需要重启或接触真实数据时先确认已保存工作及操作范围。截图、控制台、运行日志、测试报告绑定提交与包摘要；缺少某类环境就明确列为未覆盖，不用其他检查替代。

## 14. 旧数据决策门与清理纪律

本项目只面向当前内部契约，目标发布不保留长期双读、双写或旧模式旁路。旧包/存档不兼容应明确诊断，不通过默认值偷偷恢复成其他模式。

实施前必须清点：当前三种内置存档、外部 `ark-combat/1` 冻结会话、演练、世界书适配、包归档与用户自定义场景面板。只清点元数据，不执行未知代码。

开发阶段使用新契约隔离数据，真实旧数据保持原状。按用户确认的规则，正式新版本使用新建会话；当前计划不开发一次性或长期存档转换工具，不以导入、改锁或默认值实现迁移。现存旧结构夹具在隔离数据中重建，真实历史存档的删除仍由用户单独操作和确认，本轮文档更新不授权转换或删除。

旧代码清理只针对已被新实现替代且无消费者的路径，逐项记录位置、替代项、测试与影响；不要为清理战斗插件而删除其他宿主功能。需要保留消费者时先完成切换，不能为了验收数字机械删除。

## 15. 执行协作与进度记录

- 实现前加载 workspace-concurrency-guard，做两次 Git 快照；共享环境使用隔离 worktree，保留其他人的修改。
- 主代理负责公共契约、数据事务、权限与集成。仅当子任务独立且能减少等待时并行；前后端在 P0 契约冻结后才能分配不重叠写范围。
- 对模型/工具不可用记录限制并接手，不为了角色数量重复派发；独立审查只复核高风险结论与验收缺口。
- 默认 1–3 个子代理，全局最多 4 个；子任务自包含，明确文件所有权、排除范围与验证方法。
- 只按精确路径暂存，不使用 `git add -A`、`git clean` 或破坏性重置。`task.md` 当前被忽略，不能把本地更新声称为已提交。
- 实现中的公共契约更改、扩大权限、引入依赖、历史数据转换或超出范围时先报告并确认。
- 如确需修改战斗节点、敌人或地图内容，另按 combat-designer 校验与试跑；本计划默认只拆包，不改战斗内容。

### 早期进度快照（历史记录，最新代码状态见 §34，当前决策见 §35）

- [x] 基于当前代码确认内置模式、动态脚本与编译期面板的差异。
- [x] 将统一插件化方案细化为本实施计划。
- [x] 获得开始实现的授权并进入 P0。
- [x] 已提交统一注册/冻结绑定、run 存储、Python 执行与宿主 HTTP/会话 UI 等基础（详见隔离工作区计划中的阶段记录）。
- [x] 已提交 browser 执行 owner、沙箱协调、产品控制、运行事件流和冻结叙事 provider。
- [x] 本轮严格双阶段叙事草稿生成专项：59 passed；代码尚未提交，不等于叙事整轮接线完成。
- [ ] 已有会话五文件更新日志完成验证与独立审查。
- [ ] 会话草稿隔离、统一读写排斥、恢复门禁和两种叙事 HTTP 入口接线。
- [ ] P0–P7 全部实现与验收完成。

### 历史证据与现行目标的关系

以下早期进度及 §16–§34 是当时真实实施记录，保留原文与测试数字，不追溯改写为新策略已完成。涉及旧默认版本、冻结代码、卸载后运行、内嵌包导入的要求已被 §35 替代；无关的功能与可靠性目标继续有效。

### 后续里程碑记录模板

每次完成阶段追加：日期、阶段/任务 ID、分支/提交、改动路径、测试命令与结果、浏览器/Electron 证据、未覆盖项、下一步。没有实际执行的测试不得标为通过；原有已完成插件版本的证据不得复用为本方案完成证据。

## 16. 最新工作检查点（2026-10-07 09:29）

本次先按用户要求保存进度，不继续扩大实现。目标仍是完整 P0–P7，不缩为单独的叙事模块；下列未完成项不得勾选为完成。

### 16.1 工作区与数据边界

- 实现目录：`D:\Code\arknights-tavern-unified-plugins`。
- 分支：`feat/unified-combat-plugins`；当前 HEAD：`cb7b77a`。
- 主目录：`D:\Code\arknights-tavern`，`main` / `c916817`。除本次明确要求更新的忽略文件 `task.md` 外，本轮未修改主目录。
- 保留主目录已有 WIP：`docs/design/frontend-design-guidelines.md`、`docs/system-update-log.md`；不暂存、不回滚。
- `frontend/node_modules` 是指向主目录依赖的 junction，禁止通过它删除/重装依赖。
- 不读写真实存档、不迁移世界书、不重启用户服务；本阶段未 push、未合并 main。
- 本 `task.md` 被 `.gitignore` 忽略，只是本地进度记录，不声称已随 Git 提交。
- 主目录现有完整方案已在本次实际读取确认，不能继续沿用历史摘要中“task.md 为空”的判断。

### 16.2 最近已提交成果（不要重复实现）

| 提交 | 交付范围 |
|---|---|
| `46eee48` / `688c6a7` | 宿主鉴权运行控制与冻结会话插件视图 |
| `f0a6bcf` / `1b28af5` | browser 沙箱执行桥与持久 owner/checkpoint |
| `93d4429` / `21c5014` | browser HTTP、UI/engine 同身份、产品侧执行/保存/挂起/恢复协调 |
| `6a44e46` | 持久运行事件流、客户端订阅与跨窗口状态协调 |
| `cb7b77a` | 五类冻结叙事 provider 的独立 trusted-python worker、只读能力、授权与回收 |

`cb7b77a` 的 provider 每次使用独立进程/session lease，只执行精确冻结代码与依赖；不创建 run/head、不控制 gameplay owner，不提供 state/result/LLM 写能力。异常、取消、超时、授权或 run-head 变化均拒绝结果；进程树退出未获证明时保留清理所有权。持久授权代际防止 revoke→regrant 复活旧结果。

上一里程碑记录的验证仅适用于该提交：后端联合 **826 passed, 1 skipped**（189.09 秒），其中 provider 新增 43 项；管理客户端 22 项、四份 Schema 投影、SDK 严格 tsc、生产/Electron 构建通过。跳过项是 Windows 符号链接权限限制。它们不是本轮未提交代码的验证结果。

此前 browser 测试壳已有真实 IAB/iframe/HTTP/SQLite 运行证据，详见隔离计划与 `docs/design/plugins/browser-runtime.md`；不等于完整 App/Electron 或叙事入口验收。

### 16.3 当前未提交改动（8 个文件）

以下路径均相对于实现目录，目前无暂存、无新提交：

| 文件 | 当前实现与状态 |
|---|---|
| `plugin_sdk/schemas/protocol.schema.json` | 新增 narrativeText/EncounterRef/Catalogue/Prompt/Trigger/Briefing/Extraction 的严格宿主契约 |
| `frontend/plugin-sdk/protocol.generated.ts` | 已随上述契约生成；本轮尚未重跑完整投影/前端构建检查 |
| `src/SceneManager.py` | 消息构建器支持 plugin_prompt；稳定/动态层分开，consume_plot_context=False 禁止提前消费开场 |
| `src/plugins/narrative_context.py` | 冻结 provider 语义适配、未完成战斗阻塞、授权/run-head 票据、遭遇目录/触发/简报校验 |
| `src/plugins/narrative_generation.py` | 共用 Call 1→严格 Call 2→trigger→briefing；仅产出 provisional 事件和 prepared 草稿，不落盘 |
| `tests/test_plugin_narrative_generation_v1.py` | 真实冻结 provider + 受控模型，最终 **59 passed** |
| `src/session_updates.py` | 已有会话五文件可恢复更新日志的未验收实现；子代理因配额中断，无最终交付结论 |
| `tests/test_session_updates.py` | 更新日志测试已落盘，含真实子进程 os._exit 故障场景；主代理尚未运行或确认结果 |

本轮叙事草稿细节：

- 冻结 `defaultInput: null` 不再误判为拥有默认遭遇；触发引用必须完整限定且属于冻结目录，作者短引用必须携带来源书。
- stable/extraction provider 不接收逐轮上下文；dynamic 接收动作/环境和上个已完成 run。
- 模型响应必须有明确的正常 finish_reason；空白、超长、截断、非法 usage、流式文本与最终文本不一致均结构化失败。
- Call 2 只接受完整严格 JSON，不宽松剥围栏、不默认空提取、不自动重试；分支目标必须由宿主列出，禁止生成作者效果/奖励。
- 两阶段之间支持宿主回调，第二阶段使用回调的新注入，不重复错用第一阶段注入。普通 HookPipeline 接入隔离草稿仍待完成。
- 模型桥最多 4 个实际在途线程，队列 32 项；响应/提示/事件有界。取消或超时后，槽位直到真实线程退出才释放，迟到结果没有落盘回调。
- `commit_guard` 只做决定前检查，不在不可撤销提交后因取消抛出“未发生”假象；它本身不是文件事务，也不能替代会话读写锁。
- selected 会话的旧 chat 门禁仍保留；不把已准备草稿当成已提交叙事成功。

### 16.4 本轮实际测试与未覆盖边界

在实现目录运行：

```powershell
python -m pytest -q -o addopts= tests/test_plugin_narrative_generation_v1.py
```

最终结果：**59 passed in 86.06s**，进程已正常退出。

覆盖：两种传输共用生成顺序、冻结引用/目录/默认输入、未完成战斗门禁、开场不消费、Prompt 前缀分层、Call 2 严格失败、阶段回调失败、关键 provider 失败、取消/超时/迟到线程配额、stream 文本一致性、授权/身份/run-head/发布变化等。

首轮曾为 53 passed / 1 failed：测试直接修改授权时钟触犯 SQLite 的 authorization≤sequence 约束，未进入待测检查。已改为真实 lifecycle revoke→grant 后重跑，以上 59 项是修正及补测后的结果。

尚未验证：更新日志完整测试、独立代码审查、本轮相关联合回归/完整后端、Schema 投影/SDK/前端构建、本阶段真实浏览器或 Electron 叙事流程。不得复用上一提交的通过数字填补这些缺口。

### 16.5 更新日志设计与恢复接线前提

`SessionUpdates(session_root)` 仅允许更新这五个文件：

```text
overrides.json
memories.json
plot_log.md
plot_state.md
node_history.json
```

禁止写 `session.json`、`.creation.json`、冻结 combat_binding、资源或替换整个会话目录。日志在 `session_root.parent/session_updates/<operationId>/`，以原始字节 SHA256 CAS、发布身份及安全路径检查约束。

公共方法：snapshot、prepare、commit(check)、abort、recover、pending_sessions、receipt。8 MiB/单文件、32 MiB/完整快照、最多 10000 操作日志、1 MiB/日志；一会话只能有一个待定操作。

`prepared` 未决定；`committing` 是不可撤销决定，决定后即使取消/撤权也只能继续安装已授权固定字节，不能停在半轮。提交收据先于 payload 清理；清理失败不能伪装为已回滚；重放收据不能覆盖后续进度。未知/损坏内容保留并封闭相关会话，不能归属的日志必须明确阻止恢复加载。

该模块要求调用者持有数据根写锁并排斥所有会话读写/内存访问。它不提供应用层排斥；Windows 目录同步为 no-op，不承诺断电持久性。下一步须核对中断准备、逐文件安装、收据/清理失败及真实进程崩溃恢复，不能仅因文件已存在认定完成。

### 16.6 续做顺序

1. 重验工作区与差异；两名子代理已关闭，可由主代理接管 `session_updates.py` 与其测试。
2. 审查并运行 `python -m pytest -q -o addopts= -rs tests/test_session_updates.py`，修复后做独立审查；原审查未完成，不能记作通过。
3. 实现显式 Session 草稿隔离和内存发布。不要 deepcopy/重新构造完整 Session，不临时重定向 live overlay.data_dir，不共享可变 CharacterAgent/缓存/环境。保留活对象身份和锁。
4. 作者选择效果先结算，草稿基线必须在其后。生成失败保留作者效果、receipt 和 pending choice；重试不重复扣除，成功才清 pending，不自动退款。
5. 将全部相关会话读写纳入共同排斥；恢复未完成更新之前禁止加载、读出或导出混合存档。注意 registry→manager→storage/overlay 锁顺序，不在持有 overlay 时反向拿 manager。
6. 接入共用生成/提交协调器，再逐个开放 `/narrate` 与 `/narrate-continue`。未覆盖的 selected 路由继续门禁，SSE 文本只是 provisional，持久提交确认前不得发 done 成功。
7. 对无模式社交/探索、世界书分层、作者分支、取消/CAS/崩溃做回归，重跑协议投影/构建，独立审查后精确路径提交并更新隔离计划。混合换行先按仓库要求规范 CRLF。
8. 继续完整目标中的其他 slots/scopes、结算/奖励/回档、独立演练、导入导出、三种官方玩法实质拆包、旧消费者清理、PC/Electron/性能与最终集成门禁。

已发现的旧流程排斥缺口：environment 的环境/任务、sessions 自定义提示/世界书依赖（部分 GET 会保存 scope）、scene 角色覆盖、stage plugin-data、memories 回忆重生成、worldbook 会话绑定。已有 narration_guard 不覆盖全部这些路径，不能只靠 narration_count/current-node CAS 保证完整一轮。

### 16.7 子代理与当前执行状态

- 更新日志实现：McClintock，`01a113d6-07c6-7112-be80-94a430a9c736`，独占上述两个更新日志文件，代码/测试已部分交付到磁盘，但无最终结论。
- 叙事草稿独立审查：Carson，`01a113e0-cb6a-7a91-be47-3ecc59dfcc67`，只读范围为本轮叙事/Schema/SceneManager 改动，未返回审查结果。
- 两者均以 `403 Forbidden: user quota is not enough` 中断，已关闭；未更换第三方服务、未修改模型/连接配置。原 Sol 角色在此前有实际不可用证据，本轮使用用户规则允许的 Astra fallback，也遇到上述配额限制。
- 当前没有本轮遗留的运行中测试、服务或 spawned-agent。新代码保持未提交，本次只保存检查点，不声称整项完成。

## 17. 本轮持续进度（2026-10-07 10:29，实施中）

### 17.1 已提交里程碑

- [x] 严格两阶段生成、冻结 provider 语义投影、显式 Session 草稿和可恢复五文件更新基础。
  隔离分支 `feat/unified-combat-plugins`，提交 `c0fed4c`，12 个精确路径。
- 更新日志独立审查找到并修复：收据原子替换前崩溃留下的自身日志临时文件阻塞恢复。
  仅验证同操作规范日志的完整/前缀字节，正式日志独自决定；新增 3 类真实进程退出。
- 草稿独立审查找到并修复：prepare 后可变身份导致跨会话写入；覆盖层接口绕过角色/阵容限制。
  Prepared 固定全部目标与基线，比较所有非叙事 overlay 字段，既有对象/角色/锁身份保持。
- 严格生成审查修复：`stop` 正文携带工具调用仍被接受；选项提示未明确未来行动任务。
  两处均已补测并独立复查关闭。
- `test_session_draft.py` 最终 **29 passed**；更新日志新增专项 **10 passed**；生成桥接修正后
  限定回归 **17 passed**。更新日志+修正前生成联合 **160 passed, 11 skipped**（406.19 秒）；
  跳过项为 Windows 符号链接权限，不计作通过。
- 四份 Schema 投影、SDK 严格类型检查、生产构建（含 Electron main/preload）通过。
  构建不是 Electron 原生验收；仅既有 Vite CJS/chunk 提示。

### 17.2 正在接线的共同排斥与恢复（未提交）

- [x] SessionAccess 核心：短锁、fail-fast 准入、sid/global/exclusive、同 owner 子 lease、
  跨线程幂等释放、ContextVar 与独立 recovery fence；**21 passed**，独立复查通过。
- [ ] HTTP/Manager/后台服务整体放行。当前已经落盘但仍在验证：
  `session_http_access.py`、`session_manager.py`、`app.py`、普通会话 blueprints、
  `plugins/runs.py`/`session_runtime.py` 与导入导出边界；相关旧测试夹具同步当前准入契约。
- HTTP 每个请求的凭据放 Request.environ；不能放可能被 stream_with_context 共享的 g。
  每次 next 单独绑定，不能把 owner ContextVar 泄漏到向客户端发送 token 的时间段。
- 未开始迭代即 close 也须关闭原 iterable；创建先鉴权再准入；导入必须在持久 copy 前取得
  全局 lease。上述独立审查发现正在补回归。底层导出现在显式要求匹配的 manager lease。
- 启动先恢复更新日志，再构造 Session；known pending 封闭相关 sid，未知归属封闭全部。
  释放响应不等于解除 recovery fence。真实创建的恢复错误现已修正为 423，而非 400 schema。
- 当前验证：普通业务/故事规则/候选/HTTP 核心 **47 passed**；导入导出与创建存储 **49 passed**；
  runtime/browser HTTP/事件/宿主生命周期联合 **115 passed**（279.12 秒）。
- `test_session_access_integration.py` 新增 22 项：此前 **21 passed, 1 failed**；唯一失败为创建
  恢复错误映射，已修正并单独 **1 passed**，正在跑完整新增集成与 HTTP 专项，尚不填通过总数。

### 17.3 全量回归的真实结果

执行统一入口的 Windows 等价命令：

```powershell
python -m pytest -q -o addopts= tests/ perf_tests/test_combat_runtime_v1.py perf_tests/test_settlement_v1.py
```

结果：**6 failed, 2633 passed, 16 skipped in 1948.01s**（32 分 28 秒）。不能记作全部通过。
运行期间后续排斥接线仍演进，因此也不是最终 HEAD 验收。

- 5 项 `test_plugin_engine_operations_v1.py::test_finish_commits_one_snapshot_status_and_receipt_in_one_sqlite_transaction`
  （start/dispatch/checkpoint/suspend/propose）：SQLite trace 计数为 4，预期 1。需核对新增事件
  trigger 是否重复报告原 SQL，不能直接认定引擎执行了四次，也不能随意放宽断言。
- 1 项 `test_plugin_python_runtime_v1.py::test_timeout_faults_stops_and_requires_explicit_recovery`：
  返回 RUNTIME_TIMEOUT 时 `execution.worker.closed` 为 False，需分辨收尾竞争与真正未回收。
- verifier 正在独立限定复跑和分析；主代理不重复这 6 项，未降低时间/关闭断言。

### 17.4 并行开发与后续门槛

- 用户明确要求加大并行，并允许复杂重要后端使用 Astra high；已按独立文件边界派发。
- 重要协调器：Astra high，仅负责新增 `plugins/narrative_rounds.py` 与其测试；主代理拥有
  公共契约、HTTP、运行/文件桥和最终整合。恢复集成测试、全量失败诊断、独立审查分开进行。
- [ ] selected 共用叙事准备/提交协调器及独立审查。
- [ ] 持久 pending encounter → 创建 run → 结果收据/结算桥。当前五文件与 SQLite run 不在同一
  事务；没有安全桥时 triggered=true 必须在持久决定前明确拒绝，不能提交后丢失战斗。
- [ ] 记忆摘要、偏离 Call 3 的草稿语义；不直接调用会修改 live 或吞错的旧流程。
- [ ] 最终普通/selected HTTP 接线、流式 done 仅在持久成功之后、取消/CAS/崩溃及真实运行验收。
- [ ] 其他 slots/scopes、奖励/回档、演练、统一导入导出、三种官方玩法实质拆包、旧消费者清理、
  PC/Electron/性能与 P6/P7 总门禁，全部仍属于原完整目标。

工作区仍是 `D:\Code\arknights-tavern-unified-plugins`。主目录 `main/c916817` 及两份原文档 WIP
未改变；仅按用户要求更新这个忽略的 task.md。没有 push、合并、重启用户服务、读写真存档或
更换第三方模型服务。node_modules junction 未动。本节是持续进度，后续里程碑继续更新。

## 18. 已提交排斥与协调器里程碑（2026-10-07 11:05）

- [x] 共同准入、普通 HTTP、Manager、retained run 短事务/RPC、启动恢复、导入导出早期门禁。
- [x] selected 内部两阶段准备/提交协调器；作者效果失败重试、严格草稿、决定前检查、
  决定后固定恢复、未知日志全局封闭、safe aborted 自身 fence 释放。
- [x] selected 宿主只保留 social/exploration 检定；atmosphere（含 [] 清除）不丢失。
- [x] 原六项全量失败修复并独立复核：TEMP audit 真实一次 envelope 更新；RPC 明确截止与
  预检截止分开，健康 owner 不被误杀。原六项加新 preflight **7 passed**。
- 提交：`322eda4 feat: fence session access and commit frozen narrative rounds`，39 个精确路径，
  主工作区仍 `main/c916817` 与原两份文档 WIP，无 merge/push。
- 最终相关后端联合：**693 passed, 11 skipped in 987.68s**。完整协调器文件：
  **31 passed in 558.10s**。status/固定 manifest 描述：**2 passed**。独立审查全部已确认发现关闭。
- 跳过仍为 Windows 符号链接权限。此次组合不是全量、真实浏览器或 Electron 验收；
  原全量 **2633 passed / 6 failed / 16 skipped** 保留为历史，不改成不存在的全量通过。

当前在做下一依赖：`plugins/settlement.py` 及其测试，Astra high 独占这两个新文件，主代理
负责公共 Schema、Authority、Manager/HTTP、pending 和最终整合。此基础先支持明确的
用户接受/撤退、不发公共奖励；不标 host_validated，不静默丢弃 effectRequests。
文件 committing 是唯一不可撤销决定，SQLite companion 只能随它补齐完成收据；
启动不得重跑 provider/模型/验证器或重新消费确认凭据。

仍未完成、不得勾选：

- [ ] pending encounter 与稳定创建收据、旧/new run 区分、完成收据及下一轮消费闭环。
- [ ] selected `/narrate`、`/narrate-continue` 及前端简报/创建/确认重载恢复。当前触发仍在提交前拒绝。
- [ ] 记忆摘要/deviation Call 3、完整奖励/可信校验/成长和回档 epoch 桥。
- [ ] P4 官方实质拆包、其它 slots/scopes、演练、统一导入导出、旧路径清理与 P6/P7。

注意阶段名：P4 是官方玩法拆包，P5 是叙事衔接/统一结算；当前为解除 P3 依赖提前实现
P5 的通用完成基础，不等于 P5 整体完成。本文 §16/§17 是历史检查点，以本节和后续更新为准。


## 19. 持久简报与确认接线（2026-10-07 11:57，实施中）

- [x] 严格 pendingEncounter / consumedCombat / 确认预览与意图 Schema；生成 SDK 投影。
- [x] pending 从已发布 overrides 读取；固定创建请求与 create receipt/head/epoch/binding 校验，
  始终区分上一 run 与本次新 run。限定测试 **24 passed / 1 skipped**；跳过为 Windows 符号链接权限。
- [x] 创建请求 pendingId 必填；手动创建显式 null，不保留缺字段兼容。上下文阶段投影已接线。
- [ ] 跨存储结算基础。首版33项通过，但独立审查实证发现两项 P1：最终 SQL 收据预算检查过晚，
  显式 abort 的日志损坏异常未建立 fence。Astra high 正修复及补边界回归，不能标为验收通过。
- [ ] 真实 HostAuthority / Manager启动补偿 / HTTP 完成收据接线；新增真实集成测试由独立代理负责。
- [x] 正式删除入口检查未完成更新，terminal settlement companion 随 SQL 删除清理；
  原绑定删除限定 **9 passed**。合法结算后删除/重启专项仍待验证，不能放宽损坏日志恢复。
- [x] 前端持久简报/稳定创建/结果接受或撤退/确认未知状态刷新流程落盘。
  组件与客户端限定 **89 tests passed**，tsc通过；尚未提交。
- 前轮 pending 界面已用真实组件、mock管理边界完成五档PC尺寸/键盘检查；本轮新增确认UI
  浏览器工具不可用，无新增视觉证据，不沿用旧截图计作通过。确认fixture保留供主代理检查。
- [ ] selected HTTP仍关闭。开放前须先鉴权再Session文件/provider I/O，使用携带宿主凭据的
  fetch SSE，严格Origin/CORS；不把token放URL或插件上下文。
- [ ] 完成结果下一轮消费/新pending生成已写入内部协调器草稿，尚未开启 ready 标志或端到端验收。
- 记忆摘要/deviation Call3、公共奖励/可信校验/回档、P4实质拆包、其他slots/scopes、演练、
  统一导入导出、PC/Electron总门禁仍未完成。P3/P5和完整P0–P7不勾选。

主目录仍 main/c916817 与原两份文档WIP。没有merge/push、用户服务重启或真存档写入。


## 20. 结算审查与真实确认恢复（2026-10-07 12:11）

- [x] 首版结算两项P1修复并独立复核关闭：文件准备前/确认消费前预演真实终态SQL配额；
  abort统一异常分类/fence。Astra high完整 **43 passed**，reviewer新增限定 **10 passed**。
- [x] 真实HostAuthority/HTTP/Manager补偿集成首轮 **24 passed**。run是宿主测试helper生成，
  不等同真实引擎/provider/LLM执行验收。
- [x] 独立复核发现的删除风险已修：完整封闭metadata+正式file decision+对应SQL终态/receipt；
  历史aborted仅验证自身未confirm，允许后来真实成功的request推进同run，不比较旧expectedRun。
  reviewer真实临时HTTP/SQLite/五文件+Host/Manager重启三分支全部验证：两类损坏保留并fence，
  合法A失败/abort→B成功可删除/重启无残留。正在把关键反例落为永久回归。
- [x] context中head/run/pending改为一短事务读取；reviewer真实线程交错验证一致，pending专项7项通过。
- [x] 主代理已用最终确认组件fixture补验五档PC尺寸，无横向溢出；Tab焦点/ESC取消/撤退成功/
  confirm响应丢失后显式刷新仍禁重复确认；console warn/error为空。管理接口mock，未验Electron。
  共享neutral按钮hover规则已修，但完整主题及原生模式仍待总门禁。
- [ ] selected narrate/narrate-continue入口已写auth-before-lease/文件/provider、exactOrigin及专用CORS，
  共用协调器commit之后才发送controls/pending/done；ready标志仍未正式开启，专项HTTP/闭环测试在跑。
- [ ] 第一方私有凭据fetch SSE、严格流帧/EOF未知状态、ChatPanel全部推进路径pending门禁正在开发。
- [ ] 新受保护叙事历史API恢复真实提交文本：story/free历史保存完整文本与唯一stream_id；
  frontend按streamId识别丢done是否已提交，不从轮数猜成功，尚在集成验收。
- 组合回归过程中曾观察 **47 passed / 1 failed / 1 skipped**；失败是旧fixture仍断言发现未知损坏日志后
  可get_session，与新增globalfence契约不符，已同步为明确恢复错误并待复跑。该历史不改写为全通过。
- P3/P5/完整P0–P7仍未完成；记忆摘要/deviation Call3、奖励/回档、P4官方拆包、其他扩展点/
  演练/统一导入导出与最终PC/Electron门禁继续保留。


## 21. 叙事闭环与后处理验证（2026-10-07 12:34，未提交）

- [x] selected真实HTTP专项 **24 passed**：真实冻结provider+脚本模型、跨reload稳定创建、
  用户确认、失败保留pending/未消费、下一成功消费一次、新pending不能被旧completed解锁。
  run推进用realStore，尚非真实combatengine/外部LLM/Electron。
- [x] App真实factory CORS与作者来源明确消歧 **13 passed**；selected旧回忆regenerate在模型前拒绝。
- [x] 记忆/偏离纯草稿后处理最终 **33 passed**，严格Schema/config/取消/真实worker槽回收。
  首轮Windows faulthandler/native access violation记为历史异常，不冒充通过；调整测试重复初始化后整组重跑通过。
- [x] 本轮叙事/草稿/HTTP已有联合 **111 passed in 678.85s**；它运行期间后续后处理/完整history
  接线仍演进，所以不是最终HEAD门禁。
- [x] 前端与客户端六组联合 **143 passed**；四Schema投影与tsc通过。
- [ ] 独立后端审查新发现三项边界正在修：合法>1MiB完整history误被RPC预算拒绝；旧损坏history
  未在author/model前拒绝；criticalprovider未收到整轮剩余timeout。新增专用historyvalidator，
  不放宽全RPC预算；准备/发布前验证全history，provider传播剩余预算，专项回归和复审待完。
- [ ] 前端独立复现正常done后的权威刷新丢检定文本与每条usage。正在把宿主真实检定/本轮usage
  纳入持久history并恢复展示；未确认草稿不保留，reasoning继续临时展示。
- [ ] ChatPanel新版mock边界fixture已实测pending禁所有推进、进入统一战斗、完成返回后重读解锁；
  五尺寸/其他错误状态检查仍补验，不能把mock组件等同完整真实产品。
- selected正式ready仍未开启；自由群聊、统一回档/编辑/变体、完整奖励、P4实质拆包及其他P0–P7待办保留。

主目录仍main/c916817与原两份文档WIP；无merge/push/真存档/用户服务修改。临时UI服务由主代理持有
供本轮验收，结束时收回。完整阶段仍未完成，后续继续按验收结果更新。


## 22. 正式叙事桥与第四模式真实运行（2026-10-07 13:10）

- [x] 新history全文件最终 **25 passed / 0 skipped / 80.50s**；>1MiB合法完整读取，8MiB与
  per-row RPC边界、500000nodes、closed序列/唯一stream/typedroll/usage及旧损坏前置拒绝全部覆盖。
- [x] 后端独立复核3项关闭：合法约1.1MiB五row完整200；旧缺stream423且author/model/provider0；
  真实provider收到整轮剩余timeout，400ms场景超时拒绝并回收，50ms过期不新启动。
  清理尾部使实测总耗时约735ms，不把400ms期限说成所有进程清理已在400ms内。
- [x] 前端独立P2关闭，定向11pass；最终相关联合 **149 passed**，修复检定/usage权威重读，
  其它RPC全局预算未放宽。后续纯文案/SVG清理已限测88pass。
- [x] 四Schema投影、tsc、生产构建及Electron main/preload构建通过；仅既有CJS/chunk提示。
  构建仍不等于Electron原生验收。
- [x] SessionManager拥有完整settlement时正式ready；selected narrate/narrate-continue可经
  Host Bearer与exactOrigin执行持久草稿/简报，null模式基础路径保留。无桥服务仍failclosed。
- [ ] 当前HEAD后端十二组联合正在运行，不提前填通过数字；原历史111pass仍保留为有限版本证据。
- [x] 独立第四模式route-challenge完整包落盘：browser七方法引擎、五纯native hooks、独立schemas、
  默认内容和沙箱UI；包内3引擎+7UI **10 passed**，schema/原生纯投影静态检查通过。
- [ ] 新端到端夹具已实际启动：真实app factory/API/SQLite/provider/browser引擎及产品ChatPanel/
  SessionCombatView/确认弹窗，仅导航壳和模型为fixture。已实际生成持久简报、固定创建新run、
  加载并启动真实沙箱UI，局部前进1步且宿主revision仍1；保存/重载/完成/回剧情正在继续。
- 新包不静态编入宿主，不改宿主具体模式ID分支，不执行pip，不发公共奖励。临时数据及精确
  loopback origin与用户服务隔离；不是外部LLM或完整App/Electron总验收。
- 原变化组件中观察到的Emoji/Unicode按钮图标已换统一SVG，开始剧情busy时禁用；真实当前
  夹具先前加载旧资产，最终样式仍要补构建/视觉复核。

仍未完成：P3其它边界/演练/统一导入导出，自由群聊与统一回档/变体；P4三官方实质拆包；
P5完整奖励/可信校验/成长；其它slots/scopes及P6/P7全部门禁。没有merge/push或真存档写入。


## 23. 当前联合与真实第四模式验收（2026-10-07 13:46）

- [x] 当前核心后端十二文件联合 **304 passed, 1 skipped in 1584.06s**；Windows符号链接skip不计通过。
- [x] 完整history **25 passed / 80.50s**；前端合并149pass，纯文案/SVG调整后限定88pass；
  生产/SDK/Electron main-preload构建与Schema投影通过。
- [ ] 新完整后端tests/ + 两perf文件正在跑，已出现2项失败尚未到最终trace，不能标全量通过。
  此完整run启动在静态Schema缓存优化之前，最后缓存修复另有限定证据。
- [x] 真实第一次fixture已保存/暂停/页面reload恢复；20分钟fixture到期后入口关闭，不能说已完成整链。
- [x] 第二fixture第一次startup失败在loadPackage时限附近发生：无complete，实际frame销毁并close，
  run faulted；此故障保留为真实记录，不自动重试原操作。
- [x] 只读性能分析确认每UI.file路径5次binding校验，每次重做整包14份Schema；修复为精确
  bounded JSON静态合法性成功缓存，LRU256/最多16MiB；每次文件/摘要/授权/owner仍复验，
  RPC/heartbeat/dispose期限不扩大。独立安全review通过，3cache+contracts/packages **275pass/1skip**。
  单独新进程read_folder冷0.1504s，重复完整读取0.0437/0.0428s（22files），仅本机受限计时。
- [x] 优化后全新第三fixture真实startup成功；已实测本地前进1段hostrev仍1、保存rev2、
  保存返回暂停rev3、页面reload后同pending/run恢复rev4，UI保留1/3旧进度；随后绕行1次、
  前进到3/3终点，按钮正确禁用。5PC尺寸host与frame无横向溢出，键盘Tab焦点solid可见。
- [ ] 提案/用户确认/receipt/下一剧情消费仍在当前真实fixture继续验收；不与前两fixture混称同一完成链。
- [ ] P4只读映射发现发布catalog当前为空，没有真实官方产物，原shell仅测试构造；官方narrative
  当前是普通叙述+属性检定，显式combat.py则共用战术棋盘，不得整份搬作叙事包。
- [ ] 保留原聊天体验的P4前置：action/message/sidebar消费器、受控LLM能力与固定动态角色投影。
  llm.request目前仅枚举、未接服务；新设计明确禁止把get_llm健康completion/底层自动retry当单次收费。
  Astra已给只读契约/账本/purpose/authority/预算方案，未实施或标P4完成。

主仓及node_modules junction不变；未merge/push、未改真存档、未连接外部LLM。临时夹具只绑定精确loopback。

## 24. 真实确认闭环与全量失败处理（2026-10-07 14:24）

- [x] 第三隔离fixture完成同一实际run整链：真实七方法browser引擎、checkpoint/暂停/reload恢复、
  proposal rev5、真实HostAuthority用户确认完成rev6，assurance=user_accepted，effectRequests为空。
  返回产品ChatPanel后真实selected SSE推进到第二轮；只读API确认pending=null、run=completed、
  history=[1,2]。模型为脚本fixture、导航为小壳；不等同完整App、外部LLM或Electron。
- [x] 五PC尺寸宿主/frame无横向溢出，Tab焦点可见，console warn/error为空；1280×720子frame
  需要纵向滚动，操作按钮仍可到达，不声称所有按钮首屏可见。每条权威history usage保留。
- [x] 完整后端最终 **2921 passed / 17 skipped / 3 failed / 2821.06s**，不是通过门禁。
  该run早于静态Schema缓存；缓存另有275pass/1skip与独立3pass证据，旧失败计数不改写。
- [x] 独立诊断证明两个startup失败在0.4秒总期限内尚未进入worker；真实错误case改5秒并新增
  恰好一个实际进程且清理完整的断言，挂起case仍0.4秒、原错误码不放宽；限定4pass。
- [x] HTTP失败是生产并发风险：普通静态read持registry约422ms，活跃RPC的100ms授权轮询
  误报WRITER_BUSY并fault，撤权事务尚未发生。修复worker与外层runtime在原deadline内可取消
  地重试忙锁，必须重新通过完整授权才执行；不扩大期限、不把忙当授权。新增四分支永久回归，
  worker/runtime/HTTP/provider最终四组 **180 passed / 235.58s**，403撤权断言保留。
  独立复审指出最后fresh授权返回时可能已过期/停止；worker/runtime/CapabilityOperation均补
  授权后最终检查，永久回归覆盖迟到与取消。复审实际staging四分支及限定10pass关闭P1。
  中间联合因该修复主动中止，不计通过；最终180pass为修复后重跑。
- [ ] 后续仍为受控LLM账本与generic action/message/sidebar、官方三包实质拆包、完整奖励/
  可信校验/成长/回档、演练与统一导入导出、其它slots/scopes及PC/Electron最终门禁。

主仓两份原WIP保持；当前main已由其他会话推进到7ac6689（窗口与世界书呈现），准备仅在隔离
分支吸收，不覆盖主目录。无push/真存档写入，两处本轮临时验收服务已停止、监听已释放。

## 25. 吸收并行主线与演出草稿组合（2026-10-07 14:39，合并待提交）

- [x] 本轮叙事/简报/无奖励确认/第四模式/忙锁最终门禁已保存本地 **f61a728**。
- [x] 仅隔离分支吸收main7ac6689的窗口控制和世界书背景/CG呈现；8处冲突已解除，
  主目录原两份WIP未触碰。不是把feature合并回main，也未push。
- [x] 保留统一创建的真实storage/binding/roster预检，在initializer与匹配检查后、新建stage
  发布前初始化presentation；selected不能误入旧session_binding，restore不重新初始化图片。
- [x] 发现并修复交叉问题：每轮presentation.runtime/frames进入现有overrides五文件事务；
  plot_id/book_id/nodes/assets/baseline及未知扩展字段仍受保护，不扩大journal集合。
  草稿完整36pass；合成selected真实冻结provider两transport2pass，帧随成功发布、静态绑定不变。
- [x] 四个冲突fixture保留当前SessionManager/API，补演出替身，38pass。scene-media与内容8pass：
  精确lease导出保留图片，纯frame URL投影按消费会话绑定、原图片可读；当前统一import显式
  拒绝且无写入，不能冒充导入闭环通过。导入仍P3待办，旧用例不恢复内部旧ABI。
- [x] Electron main保留sandbox/导航/随机凭据/可信文档IPC；preload七明确方法仅mainFrame暴露。
  内存安全测试37pass（含事件准确解绑），窗口controller独立脚本通过；生产与Electron
  main/preload构建通过，未据此声称原生窗口总验收完成。
- [ ] 六组presentation/draft/selectedHTTP/creation/coordinator联合收尾；其早期一次失败是main
  新export fixture缺lease，随后已按当前import门禁补足上面的8pass限定检查。独立组合复审在跑。

剩余P0–P7按前述继续，尤其LLM账本/action/message/sidebar/三官方包、奖励/回档与统一import。

- 后续组合六文件返回167pass/1旧export fixture失败，修正fixture后的scene/content8pass、
  新selected合成断言2pass、最终前端六组149pass；不把旧失败联合改写成全通过。
- 主main随后推进423c675（舞台流式阅读），包含ChatPanel/StageView/SceneManager/chat，
  未纳入本次固定7ac6689整合点；下一整合需要逐段保留selected凭据/草稿提交/推进门禁。

- 独立整合复审关闭：presentation7项+selected双transport2项+Electron37项和window脚本
  通过。未验真实图片的selected创建、原生file://或完整回档，不扩写为这些门禁已通过。

## 26. 舞台流式阅读与统一叙事组合（2026-10-07 14:52，未提交）

- [x] 固定main7ac6689整合已保存本地 **3b9ddab**。开始仅隔离分支吸收main423c675，
  真实冲突限ChatPanel与chat；主目录不写回、不push，仍保留其WIP。
- [x] legacy舞台meta/text_complete/done与锚定preview脚本合并；保持Hook注入只进提取dynamic
  context，不将宿主提示拼进权威正文。新main对应fixture已改成明确这个契约，限定15pass。
- [x] selected继续专用Bearer/exactOrigin/strict parser；_call已严格保证流式正文与模型final正文
  一致，文本256KiB上限。成功commit后发小text_complete{stream_id,text_bytes}确认原token，
  不把全部正文塞进一帧；HTTP每token按4096Unicode字符分块并逐块鉴权，64KiB frame/8MiB
  stream预算不扩大。onTextComplete构造canonical全文，仅有效done交付正式控制。
- [x] parser39pass：200000UTF8bytes大正文、正文缺边界/重复/错长度/旧字段/marker后token
  拒绝，丢done仍未知；舞台reading11pass、旧SSE生命周期35pass。
- [ ] 前端specialist负责ChatPanel generation/preview锚点与权威重读组合，保持selected全部
  推进/epoch/navigation/auth fences，不丢done猜成功。初步28pass，导航cleanup边界继续补测。
- [ ] 真实HTTP/原剧情四组联合及独立传输复审在跑；新增大callback/failedCall2正文边界回归。
  生产构建、组件最终验证与必要浏览器补验待完成。P3/P4/P5与完整P0–P7未完成。

## 27. 舞台组合复审关闭与真实丢帧恢复（2026-10-07 15:43，已本地提交）

- [x] 三组实际HTTP/provider/legacy舞台最终 **87 passed / 191.22s**；provider完整44pass。
  新精确256KiB/上限+1/Call2失败/commit顺序五项后续 **5pass / 33.82s**。
  旧四组48pass/2fail（逐字符夹具超时、旧Hook正文假设）保留为历史；参数化全文ID导致
  fixture错误也保留，不冒充当前namedcase/单callback边界通过。
- [x] 独立P2最大正文关闭：仅combat.trigger.extract的编码input封套768KiB，narrative仍
  256KiB UTF8；普通input/output/capability仍256KiB、RPC仍1MiB。先finite/Unicode/编码
  验证后独立正文/包Schema验证。真正262144bytes模型成功，上限+1拒绝且无保存。
  独立4pass关闭；其它容量未放宽，不缓存授权或实例值。
- [x] 前端六组162pass（早于最后scope修复），client39pass再覆盖精确max/max+1及8MiB
  reasoning实际总流；组件最后30pass、reading13pass、typed check与生产/main-preload构建通过。
  其它SSE生命周期35pass与SSRstage脚本通过（已同步当前JSON模块interop，不改依赖）。
- [x] 独立两P2关闭，5项复核：matchingstream partial462→canonical966，exact→prefix→suffix
  映射保证第三页及完整余文，重复文本不跳末尾；真实effectcleanup按完整WeakMap流scope
  ownership，只关自己的旧流，不能取消新nav/conn/epoch/session流。未匹配恢复诊断移除
  生成/预览身份，保留错误日志，不能成为权威正文。
- [x] 真实临时app/provider/脚本模型浏览器：正常preview第三页→commit/权威刷新保持位置。
  待战斗后原阅读页被choicesDisabled误锁，已改为分页仅受无内容/编辑立绘限制；新行动/
  选项仍严格门禁。修复后能读到末页，End只改阅读页，ROUND仍1。禁行动时文案为已读完。
- [x] 全新丢帧fixture只交付462字符前缀，真实后端继续执行并commit，故意丢所有控制/done。
  实际UI从第三页3/4的临时预览，按matchingstreamId重读真正829字符，恢复为第三页3/6，
  全文余页可读；并非按轮数猜成功、无自动写重试。只读API确认历史轮1/真实streamId。
  这项传输故障是显式fixture，API/SQLite/provider与产品client/stage真实，模型仍脚本。
- [x] 修复后五PC DOM无横向溢出、第三页稳定、分页aria-disabled=false；最小视口截图正文
  存在纵向scroll可读，最大视口dialog实际rect完整位于内容区；console warn/error为空。
  没有宣称四主题、Electron/file://或三原生模式总验收。

P3/P5与完整P0–P7仍未完成：受控LLM账本/generic action/message/sidebar，官方三包实质拆包，
奖励/可信校验/成长/回档，演练/统一import-export与其它slots及最终原生验收继续保留。

- 本轮阶段提交f61a728、窗口/演出整合3b9ddab、舞台组合c7f16b4、主线测试资料吸收
  02de4c4；feature工作区干净。最终前端七组176pass、最后构建通过。主main/f5ae3ca仍有
  两份原文档WIP，未触碰；没有合并回main或push。所有本轮临时服务已停止/到期，最新
  Cua验收tab已关闭，viewport恢复。native/真实LLM/完整P0–P7仍未完成。

## 28. 受控行动模型请求与持久账本（2026-10-07 17:24）

### 2026-10-07 17:24：受控 Python 行动模型能力与请求账本

- 实现提交 **48e40f0**，分支 feat/unified-combat-plugins。只接正式 Python dispatch；
  host scope固定用途/身份/冻结绑定/run/epoch/action/deadline，UI和纯叙事hooks仍无LLM权限。
- 单次POST、无健康completion/retry/fallback/redirect，实际client URL/认证与固定adapter
  一起捕获。独立审查复现的旧凭证/新URL风险及client构造期间取消仍POST均已关闭；
  最后独立构造器seam取消/到期均0 POST，未扩大RPC期限。
- SQLite先预留再外部IO；重复成功返回原结果，pending/failed/unknown不重发；重启pending
  记unknown。每action2次/run16次、保守256KiB单位预算、最多4在途，取消/失败不返还。
  有效usage可在迟到取消后保留，缺失usage为null；这不是货币预算或供应商计费上限。
  IO未结束时shutdown保留registry/writer。协议/SDK/文档同步，清理旧“LLM尚未接”口径。
- 最终两新文件 **75 passed / 66.37s**，含真实Python worker行动一次调用和初始化拒绝、
  实际SQLite/租约/重启、预算、迟到取消、revoke→regrant、并发、45个MockTransport检查。
  核心六文件联合 **258 passed / 384.42s**；该run早于最后构造器3用例/初始化1用例，
  最新75pass覆盖这些最终增量。registry/HTTP/creation/narrativeHTTP/appCORS/backendReuse
  六文件 **296 passed / 294.59s**。初轮25pass/1重启夹具double-open失败已修且最新回归通过。
- 四份Schema投影、SDK严格tsc、生产及Electron main/preload构建通过，只有既有Vite
  CJS/chunk提示。本轮没有重跑全量后端、浏览器/Electron运行或真实LLM，不能替代P7。
- 详细契约见 docs/design/plugins/controlled-llm.md。主main/dbeafef代码、真实存档/服务
  和依赖junction未改；只同步用户忽略的task.md进度。不合并、不推送。
- [x] 受控LLM账本与Python dispatch基础能力。
- [ ] 下一依赖仍为generic action/message/sidebar消费器与固定动态角色投影，随后官方
  narrative实质包；本阶段未开放叙事action能力，也未完成P3/P4/P5或完整P0–P7。

## 29. 会话三槽、动态角色与真实验收（2026-10-07 19:08）

### 2026-10-07 19:08：会话action/message/sidebar与动态角色投影

- 实现提交 **59c9402**，隔离分支 feat/unified-combat-plugins。正式ChatView三槽消费冻结包，
  readonly discovery、独立session iframe/lease、scope commands和metadata epoch首次初始化。
  static发现与metadata open允许普通并发读，真正公共角色capture/private action用exclusive。
- runtimeRoster只叠加会话覆盖到冻结身份/字段/初值，按id不按display name；角色与玩家明确
  分离。只dynamic prompt拿本轮draft投影，stable/extraction与原claim/restore输入未变。
- optional session.messages真实native provider，类型必须冻结声明/namespace匹配，id跟stream；
  history、最终draft.prepare和下一轮同binding校验，随五文件整轮commit，错误不部分发布。
- 前端三槽窗口共享12实例池、visible-only renderer、实际frame销毁且close ACK才释放；
  lost/unknown保留，确定未发送使用host-only对象身份证明，匹配真实恢复ACK释放占位。
  成功私有动作仅通知第一方权威重读，禁止写重试；replace目标仍明确blocked。
- 独立审查关闭历史未知type、合法typed消息最终prepare缺binding、无界历史实例、未发送
  微任务退出永久占位等问题；最终独立窄复核4pass。真实registry→runtime内部字段边界、
  launcher双consumer单飞、舞台typed行污染和窄气泡等均有永久回归。
- 最终前端五组 **151 passed**；后端消息/角色/draft/history/CORS五组 **113 passed**，
  surface/contracts/packages/CORS四组 **297 passed**（含真实UI私有保存/暂停/恢复）。
  四份投影、严格SDK tsc与生产/Electron main-preload构建通过。早期联合243/1fixture
  缺新必填pluginMessages保留历史，fixture修复后限定1pass及最终相关组均通过。
- 旧1.0.0真实同run261a910eb5ad4709a2e82d2518ad1723最终completed/rev7/user_accepted，
  显式宿主确认未奖励，下一真实剧情history[1,2]、pending=null；原根重启后仍保留。
  三可见槽3→隐藏记录2→内置侧栏1→退出0，滚动只挂可见消息。原工具栏一次恢复点击
  无可见变化未称通过，随后第一方权威恢复成功，不自动重发原写。
- 新1.0.1独立视觉session仅第一轮：四主题×五PC20组合无横向溢出，frame背景/文本可读、
  bubble480px、键盘focus跨frame返回宿主；成功run console warn/error为空。该证据不拼
  进旧run结算。完整记录见docs/design/plugins/session-surfaces-browser-qa.md。
- 两最终fixture退出后API复核0实例，服务正常停止/监听释放。原临时完整root保留；复制根
  因journal绝对根校验被拒且保留，未绕过，不声明迁移或统一import通过。无真LLM/真存档
  /用户服务访问，本轮未改main代码、未merge/push，node_modules junction未改。

### 下一依赖：官方narrative实质拆包前置（仍未实现）

- 当前没有独立narrative引擎/HP回合模型，基础SceneManager模板不搬；旧combat_start的
  narrative路径实际共用战术，不能用空壳包调用该宿主链。社交/探索检定继续留宿主。
- 战斗词/作者combat stat_check/冲突结果提示应迁包，保留现有d20自然20/1、等级/DC、
  环境与条件语义。当前旧检定取scene.active NPC的metadata.attributes，不是任意公共stats；
  不得偷换为玩家或把公共字段硬映成八属性。设计并冻结必要metadata/明确active actor，
  增加受控动态环境/条件/public roster引擎只读能力，不改变原restore初始化输入基线。
- 受控LLM已仅dispatch有combat.action预算窗口；官方包若无既存LLM实例必须从明确宿主
  配置创建唯一请求的临时transport，禁止get_llm健康completion/retry/fallback收费旁路。
- 未完成run仍阻普通叙述，须明确通用行动确认→checkpoint/结果→叙事衔接；不得hook偷跑
  dispatch。现结算仍拒绝非空effects，旧检定公共condition/history要有通用受验证、幂等、
  可回档效果提交后才能等价迁出，不能只写私有snapshot冒充完整迁移。
- plugins-src/与resources/default-plugins尚无真实三包/catalog发行产物。做好以上边界再
  实质narrative，随后sideview/tactical；最终奖励/成长/回档、演练/统一import-export、其它
  scopes/trusted-ui/replace与P7仍属于同一完整任务。完整P0–P7保持未完成。

## 30. 冻结玩法资料与动作状态观察（2026-10-07 20:09）

- 实现提交 **c83ef67**，隔离分支 feat/unified-combat-plugins。公开角色 attributes/gameplay
  从同次YAML投影独立characterData，纳入冻结摘要，可选包characterDataSchema验证；
  无公开数据不硬映公共stats，不读正文/完整metadata，不给旧实验快照补读旁路。
- characters.bound.read只读冻结数据；session.gameplay.read仅真实Python dispatch/propose，
  声明+授权后持有真实exclusive lease，读当前环境/选中条件/history/动态roster，active仅
  scene actor。初始化/恢复原ABI不变，纯hook/UI没有动态观察/公共写权限。
- 动作准备事务insert-only观察账本绑定instance/epoch/run/request/binding/body/摘要，
  重复已完成动作先返回原收据不recapture，读返回分离副本；对应收据删除真实FK级联。
  独立审查两P2关闭：UTF8观察字节纳入原64MiB预算并在prepare回检；重哈希改字段来源
  仍拒绝。最后复核均关闭，无新增发现；没有把观察摘要当规则验证。
- overlay条件输入/getter深拷贝、setter整段RLock；节点快照必含character_states，树和
  author恢复均替换，拒绝缺失/错误类型。统一run/epoch回档仍未完成。
- 原SSE只在exclusive WRITER_BUSY按原期限/取消/鉴权等待；不传旧值、不重启写操作。
- 角色资料21pass、helper最终55pass、真实HTTP→SessionManager→worker最终7pass、
  状态快照5pass；helper/native最后联合 **62 passed /54.31s**覆盖最后两审查修复。
  原runtime/HTTP/UI/provider/bindings/SSE七组 **333 passed /979.20s**（开始早于两修复）；
  新SSE三分支3pass、原树/author回档21pass。早期native四处expect502夹具实际403
  CAPABILITY_DENIED修正后通过，不降低生产授权。四投影/严格SDK tsc/生产及Electron
  main-preload构建通过；一次frontend路径重复的投影命令失败，仓库根正确命令重跑通过。
- 契约见docs/design/plugins/gameplay-context.md，相关旧文档口径同步。无本轮新增浏览器/
  Electron运行/真模型证据，真实存档/服务未改；主main/dbeafef两快照稳定、代码未改。
  不合并、不推送，完整P0–P7保持未完成。

下一依赖仍在同一完整任务：从明确宿主配置创建唯一请求临时transport（无get_llm健康
completion/fallback），独立规则验证及固定公共condition/history幂等结算/回档；之后官方
narrative实质包/行动→结果→叙事衔接，再sideview/tactical、演练/import-export/其它槽与P7。
非空effects门禁保持，不能只删拒绝检查；trusted-python执行授权不等于公共效果授权。

## 31. 临时模型transport、宿主随机收据与固定结算镜像（2026-10-07 20:29）

- **b8e64a9**：现成cache继续固定真实client/adapter；无可用cache单次严格读取实际宿主
  配置，128KiB/UTF8/duplicate/nonfinite门禁，不用get_config容错默认/ENV，不构造legacy
  LLM/health completion/get_llm。纯adapter+临时HTTP client，singlePOST/no retry/redirect/
  fallback，deadline/取消门禁同旧路径。云key/url任一非空才要求完整云配置；两空仅用
  完整显式local，默认cloud_model不单独选cloud。这个产品local形状P2已独立复核关闭。
  旧45+新43共 **88 passed**，含真实worker→MockTransport→durable回放；无真实供应商调用。
- **1745dbd**：PreparedSettlement before/after固定有界bytes；检查baseline，publish解码
  fresh对象。准备回调保留dict或后续live overlay不能改固定镜像；file决定→SQL finalize→
  registered memory/recover顺序未变。全 **44 passed /234.29s**，独立审查无新增发现。
- **1b55c91**：generic random.sample仅声明+授权的Python dispatch；真实pending action/
  owner/CAS/epoch/binding/授权代际，跨thread承接host parent lease，不绕exclusive writer。
  host secrets整数均匀采样，不内置d20/玩法公式。事务提交后交付，固定action/check唯一
  键禁止改ID重掷；4/action、64/run、100k全局，proof与canonical action UTF8字节计入
  原64MiB。取消/撤权/再授权期间rollback，提交后引擎失败保留，不自动重掷。
- host-only completed证据重验原canonical action、done engine-dispatch、真实owner/摘要；
  pending/error/重启故障动作不能变成规则验证，真实删除FK级联清理。宿主命令fingerprint
  ownerId=null、owner另存，按现契约；不要误用旧推断的ownerId=instance算法。
- random最终32/helper+8真实HTTP/worker+7既有gameplay native，联合 **47 passed /234.87s**，
  含exclusive parent跨thread、command replay/恢复不重掷、failed/reroll保留且不可验证、
  undeclared/4错phase、删除。独立2窄测覆盖exclusive与revoke/regrant。早期hash口径错误
  suite中止，首例修复1pass；首次native7pass/1错误propose测试路由404改用真实/result后
  最终8通过。历史失败不算最终通过，未放宽权限。
- 原LLM请求账本/正式session HTTP/协议联合 **116 passed /139.25s**；四Schema投影、
  实际frontend依赖tsc严格SDK、production/Electron main-preload构建通过。root npx tsc
  曾命中非TypeScript包提示，改用实际frontend/node_modules/typescript/bin/tsc后通过。
  不改依赖junction，无本轮新增浏览器/原生运行/真模型验收。
- 文档controlled-llm.md、random-receipts.md已同步；隔离feature代码已保存，主main/dbeafef
  两快照稳定/代码未改，真实用户存档/服务未触碰，不merge/push，完整P0–P7未完成。

### 下一项：独立规则验证与公共条件/history效果（设计边界，尚未实现）

- 现manifest没有validator/policy声明，content.rewardRules的host_validated只是作者声明；
  result.ruleId跨绑定多书可能重名，不能first-win，需明确source/ruleRef。不能把运行
  trusted-python grant当公共效果授权，也不能仅多起一个进程就称可信。
- 按现计划引入独立result-validator profile、精确摘要/政策与效果范围的额外宿主授权、
  冻结validation/rule locks。验证器无LLM/写状态/重新掷骰，只用确定动作、宿主观察、
  random收据与冻结规则重算；宿主限制canonical效果种类/角色/数量。
- d20属性/DC/环境/条件公式留官方包，不在宿主加入模式ID/HP特例；验证器必须要求
  唯一预期check/区间/动作来源，拒绝从其它action/check选有利样本。只验证condition/
  history时不得把整个narrative胜利从user_accepted升级host_validated。
- 在SessionUpdates不可逆决定前固定verification/canonical effects/after；recover只
  验固定镜像，不跑validator/model/引擎/确认/骰子。公共效果幂等、完整资源snapshot与
  新epoch回档须一同完成；当前非空effects仍全部拒绝，不删除安全门禁冒充实现。
- 完成后实质narrative与action→checkpoint/result→叙事衔接；再官方sideview/tactical、
  奖励成长、演练、统一import-export、其它scopes/trusted-ui/replace和P7，范围不缩减。

## 32. 独立规则校验与完整效果镜像证明（2026-10-07 21:12）

- 实现提交 **a107902**，隔离feat/unified-combat-plugins。combat.validation声明精确
  trusted-python入口/Schema/rules/policy/kinds/maxEffects，combat.effects.validate为独立
  权限。browser engine搭native validator仍必须授权trusted-python；管理页显示声明政策/
  效果种类/上限，不把运行授权或官方来源当胜负验证。
- content必填validationLock/ruleLocks，锁包/entry字节/规则JSON/政策/范围；frozen从精确
  包和冻结adapters重建比对，源书改变不漂移。跨book同id qualified ruleRef保留独立，
  result改ruleRef/actionRefs/evidence，旧direct ruleId仅拒绝测试保留，不增加兼容路径。
- 新canonical gameplay action与receipt/观察同prepare事务保存并计入64MiB、FK级联；
  verifier输入必须done dispatch、body/hash/owner/完成revision、精确观察和每个random
  receipt匹配。未知/failed/pending/伪造输入在spawn前拒绝，无模型/重执行/重掷骰。
- PluginHost.validation与新result-validator profile真实独立worker：只verifyResult/dispose，
  全部host capability（即便引擎已有grant）拒绝。768KiB输入、64KiB输出、4实例、60s上限；
  typed输出限定frozen actor/kind/count/current round，拒绝assurance；固定bytes report/input
  仅给host，不写public overlay/files/run completion。局部效果校验不升级整体胜负可信级。
- cleanup先撤实例能力、真实tree.closed后ACKlease；失败保留owner/租约，显式shutdown
  可重试。关闭后仍核cancel/deadline/generation/head/run；revoke→regrant不能复活报告。
  native初组 **21 passed /271.28s**，追加late/真实close/cleanup失败 **7 passed /80.42s**；
  初始两次binding request夹具签名错误修正为实际roster关键字，最终以上组通过。
- effect_images为pure机械前置：detached apply conditions/history+固定history entry，有限
  proof存完整before/after/effects/entry canonical摘要、受影响actor原值与存在flags。
  reverse完整before后再forward完整after闭环，抓无关字段和选中actor内额外变更；
  缺失/空值严格分离，条件64/检定20/history1024/overlay8MiB/proof256KiB。**23 passed**，
  独立设计与实际静态审查无发现；不是文件事务或公共授权。
- 静态新规则 **38 passed**；既有bindings/frozen/contracts/packages **446 passed**；新增
  action记录后的gameplay/random native **15 passed /122.12s**；worker/原结算HTTP
  **92 passed /120.17s**。前端授权相关 **43 passed**、四投影/严格SDK tsc/生产及Electron
  main-preload构建通过。未重跑全量后端、不等同native Electron/P7。
- 新scripts/validator_admin_qa_package.py真实临时产品组件+Blueprint只读fixture，两包注册、
  API调用0/实例0，59046/51545监听释放。Browser/IAB/Chrome工具均不可用，无viewport/
  screenshot证据；修正fixture显式owner.close后新临时根正常清理。首次残留根
  C:\Users\areium\AppData\Local\Temp\ark-validator-admin-qa-5vztnub4删除被自动审批拒绝
  （blocked by policy），保留原目录，没有其它删除方式。docs/notes.md记录这条实际限制。
- 文档result-validation.md、architecture及相关protocol/bindings同步。main/dbeafef两次
  稳定、代码未改；仅守hash同步忽略task.md。无真用户data/config/model/service触及，
  未merge/push，完整P0–P7保持未完成。

### 下一步必须真实接公共提交/确认/回档，不缩成只读报告成功

- 当前HTTP confirmation/preview/settlement全部仍拒绝非空effects；VerifiedEffects与
  effect_images未接SessionUpdates，这不是P5或官方narrative完整迁移。先把确定报告/
  镜像proof绑定preview→用户确认token→fixed SQL companion→file committing唯一决定→
  SQL finalize，再覆盖真实condition/history提交、幂等、file已决定SQL未完成恢复正例。
- before/after canonical hash和raw manifests并列不自动证明同源，prepare须实际读取并固定
  关系；pending恢复读决定after做reverse+forward，historical committed replay不能要求
  当前live仍旧after，更不能再应用效果。companion还需严格限定report/proof/assurance字段。
- 现preview schema仅run/epoch/revision/proposalDigest/allowed；adminApi显式拒绝非空allowed，
  checkConfirmedRun锁user_accepted + accept/retreat-no-effects，SessionCombatView固定未奖励
  文案；开放效果时必须同时同步proof摘要/用户所见效果/确认intent绑定与前端消费。
- 统一rollback必须新host coordinator：当前nodes没有SQL run checkpoint，_load要求run.epoch
  ==head.epoch；只更新head或直接开放旧rollback会坏。需固定目标公共/私有checkpoint及
  新epoch，恢复不启动engine；null绑定基础回档保留。之后实质official narrative及明确
  action→checkpoint/result→叙事衔接，再sideview/tactical、奖励成长、演练/import-export/
  其它scopes/trusted-ui/replace及P7，范围不缩水。旧临时快照未迁移，未来QA要新建。

## 33. 真实公共效果确认与可恢复提交（2026-10-07 22:15）

- 实现 **5b8a354**，隔离feat/unified-combat-plugins。default/accept preview真实调用独立
  verifier，保存fixed input/report；精确proposal/generation/public snapshot重用一次结果，
  validfalse也缓存，corrupt不执行代码修复。报告含authorizationGeneration，regrant换digest。
- preview显示canonical effects/frozen actor名ID/policy；确认intent/token/request必填并绑定
  verificationDigest，receipt必填verificationDigest/effectsDigest。assurance三enum协议保留，
  本阶段派生仅user_accepted + accept/accept-effects-validated/retreat-no-effects，不把
  条件/history验证升级整场胜负。缺新字段旧请求拒绝，无内部旧格式fallback。
- 独立GET confirmation?decision=retreat只读权威提案摘要，完全不执行validator/null digest/
  empty effects，拒绝/失败后仍能退出不提交效果。before_request只给此GET单一decision
  accept|retreat白名单，duplicate/未知/其它参数与凭据仍拒绝；不是放宽全路由query门禁。
- 中央typed integer域先Schema验证再int规范，preview/effectsDigest同list；frontend以固定
  ASCII keys+safe integer/UTF8/WebCrypto SHA256核effects，不猜任意JSON float proposal摘要。
  before/after两次decision预览及digest/effects/actor label/policy变化重新确认，写无自动retry。
- 缓存最多32/run、100k全局；真实report、canonical actions、observations/random、settlement
  companion UTF8bytes一并进原64MiB。SAVEPOINT在fileprepare之前模拟companion+finalRun+
  receipt全部预算，token消费前再检；SQLite JSON1本地实测可用，不扩大RPC/会话容量。
- RootStore nested transaction保留真实parent.exclusive，不降为共享或升级无独占parent。
  实际pipeline最初query被旧总栅栏400、随后嵌套scope423，都从真实HTTP定位并修正，
  新正例通过；没有降低Gameplay capture的真实lease要求。
- Settlement.prepare只load精确报告与current input，不跑validator；baseline disk/live相符，
  pure镜像mechanical apply remove/add/check+固定history，仅overrides改变。strict companion
  绑report/proof/raw manifest/canonical before-after/receipt。唯一file committing决定后static
  证明→SQL finalize→registered memory，不重确认/校验/模型/随机。历史replay不覆盖新进度。
- 最终效果文件 **20 passed /181.20s**：实际HTTP/native/verifier/cache/token/submit，条件
  remove/add/check一起提交、文件/内存一致、无关字段保留、回放/独立退/expired/unknown/
  corrupt/regrant/int float/预算/query；真实os._exit73在file committed SQLprepared后重启
  固定恢复，另raw观察fault seam匹配fake aftermanifest+rehash后拒逆/正闭环语义篡改。
  该seam初版wrong-entry早失败的证据缺口已修、独立复读关闭，不将其冒充真实文件提交。
  最后真实delete FK清理追加在主正例，**1 passed /18.59s**（整20开始早于此增量）。
- 结算旧/new初联合 **74 passed /237.14s**；后加恢复等分支 **6 passed /59.94s**，最后
  20覆盖这些最终逻辑。相关叙事/HTTP **68 passed /199.42s**；Schema78/pending25/生成器6
  /frontend140通过；四投影/严格SDK tsc/production及Electron main-preload构建通过。
  初旧联合66pass/2旧预览口径fixturefail已修，exact budget5/旧nonempty HTTP1窄测通过，
  没把旧失败/旧query代码中止run算通过。SDK oneOf→union修复有真正strict TS编译断言。
- 独立review未见production P1/P2，但没有将静态审查当完整runtime通过。Browser仍只有
  unavailable/fetch失败，一次复检后未启新服务，无viewport/screenshot/Electron运行证据，
  不能计P7。旧5vztnub4临时根原样保留，本轮无删除尝试/新拒绝，不重复旁路清理。
- 当前worktree clean，main/dbeafef两快照稳定/代码未改，守hash同步忽略task.md；无真实
  用户data/config/model/service触及，不merge/push。AMH get_context本cwd返回empty未用记录；
  sync/maintenance/candidates bounded观察未返回，未重复/改配置/提交或发布候选。

### 下一依赖：统一节点运行检查点与新epoch回档（完整任务保持）

- 公共conditions/history确认已真实接线；XP/物品/属性成长/完整胜负校验仍需后续扩展批准
  效果类型与规则，不把当前三kind当最终P5完成。官方三包、演练/导入导出/其它槽/P7未完成。
- 现在节点snapshot无SQL run checkpoint，RunStore._load要求run.epoch==head.epoch，pending
  Encounter还校验overlay epoch/previousRun/create receipt。必须新host rollback coordinator，
  固定目标公共+私有运行checkpoint、pending分配策略、旧owner/UI回收证明与新epoch；不能
  只改head、重写旧completionReceipt epoch或解除旧rollback栅栏调用分步旧方法。
- 为已完成run到下一叙事节点建立明确冻结run checkpoint引用，回档只从目标冻结证据恢复，
  不从当前run猜历史、不启动engine或重放model/骰子/确认。统一协调要按file committing
  唯一决定+SQLcompanion恢复；null绑定基础回档继续保留。
- 再实质official narrative d20自然1/20、NPC attributes/环境/条件语义与action→result→
  叙事衔接；之后sideview/tactical、完整奖励/成长、演练/import-export/其它scopes/trusted-ui/
  replace与PC/Electron真验收。完整P0–P7保持未完成，下一轮从这些实际源码/证据继续。

## 34. 检查点发布前置与隔离验收（2026-10-08）

### 工作区与本轮状态

- 当前续做源：`D:/Code/arknights-tavern-checkpoint-acceptance`，
  `feat/plugin-story-checkpoint-acceptance`，基于原隔离分支 `43c8687`。
- 本轮实现已本地提交：`c58c8db`；未合并 main、未推送远端。
- 入场发现原 unified-plugins 树有 12 个未提交修改/新文件，但 task.md 仍写 clean。
  本轮将该 WIP 完整快照到新工作树继续；原代码及主 main/dbeafef 未覆盖、未合并或推送。
- [x] 叙事完成边界冻结完整五文件、有限内存投影与 completed run（或 null），并固定 round/tree/author 目标。
- [x] SQLite 检查点对象及 companion 在文件 committing 决定前准备；发布/启动恢复追随唯一文件决定。
- [x] 恢复不执行模型/provider/validator/玩法；历史重放不覆盖新进度；正式删除清理关联对象。
- [x] 修复合法长历史被 RPC 50000 节点限额误拒绝：完整文件使用既有 8MiB/500000 节点口径，RPC 不变。
- [x] 独立审查发现并修复 P1：检查点失败不得覆盖已有结算栅栏，成功也不得解除它。
  新 owner-scoped SessionAccess 栅栏与普通栅栏并存；任何一个未解决都禁止准入。
- [ ] 新 epoch 回档 coordinator 仍未实现，不把上述前置标为完整 P3/P5 或回档完成。

### 验收证据与边界

- 检查点存储/完整文件解析/角色数据恢复/会话草稿：**139 passed /22.78s**。
- 叙事 rounds/HTTP/pending/postprocess 联合：**117 项，退出码 0**。此轮在 scope 修复前启动；
  scope 修复后的真实完整 HTTP 结算→后续剧情→冻结 completed run 正例另行复跑通过。
- 最终准入核心/检查点发布/真实 HTTP 正例：**45 passed /177.78s**。包括全局/会话外部栅栏先存在、
  两种解除顺序、多个 scope、配额失败、长历史、历史后续进度不被覆盖。
- 真实子进程 `os._exit(74)` 三场景：SQL companion prepared/文件 prepared、首个文件安装后的
  committing、五文件 committed 但 SQL 未完成；重启只按固定决定恢复，三项均通过。
- 会话准入集成/结算/删除/统一创建：**149 passed /210.89s**。
- 独立 Astra/high 复审关闭上述 P1，未发现新增 P1/P2，限定范围允许本地提交；
  原 Sol reviewer 实际返回模型不支持 404 后按既定回退规则替换，并非双份通过。
- 先前测试夹具曾因 ScriptedModel 使用累计调用索引而耗尽；已改为追加预设响应并最终通过。
  长历史旧实现失败已先复现再修复；没有把旧失败计入通过。
- 本轮无前端/Electron 源码改动，不重用旧截图冒充当前验收；未新增浏览器、Electron 原生或真 LLM 证据，
  未跑全量后端/官方三包独立构建，P7 保持未完成。真实用户数据、模型配置与运行服务未触碰。

### 下一依赖

1. 从 committed checkpoint 精确选目标，固定目标公共/私有状态；新 epoch 与旧 run/receipt 的
   历史证据必须分开建模，不得只改 head 或重写旧 completionReceipt.epoch。
2. 协调旧 worker/UI owner 实际回收、pending 新标识/创建收据、五文件唯一决定与 SQL rollback
   companion；恢复不得启动模型/引擎/骰子；null 绑定基础回档保留。
3. 再继续官方 narrative 实质规则/动作结算，随后 sideview/tactical、完整奖励、演练/import-export、
   其它 slots/scopes/trusted-ui/replace 及 PC/Electron 真验收。完整 P0–P7 未缩减。

## 35. 版本独立安装与卸载前删档（2026-10-08，用户确认；实施进度见 §36）

### 决策与范围

用户目标是降低插件作者负担，尽量不做插件版本兼容：1.0 和 2.0 作为独立安装项，使用 2.0 必须新建会话；卸载 1.0 前检查依赖并由用户先删除对应会话。此前“卸载后仍可运行冻结副本”的目标撤销。

决策记录阶段只更新计划，不修改插件代码、真实数据、配置或运行服务；本节不授权当前代理删除任何真实会话或安装包。§1–§15 已同步为现行规则；§16–§34 保留历史证据，新策略不能引用旧验收数字宣布完成。当时主工作区与 checkpoint-acceptance 工作区的同内容 task.md 同步此决策；原 unified-plugins WIP 不覆盖。后续获准实施的当前工作区与结果见 §36。

### 必须保留与明确取消

- 保留：精确版本/摘要校验、当前宿主接口检查、权限边界、同版本保存恢复与剧情回档、公共效果校验、幂等结算、崩溃恢复，以及世界书玩法内容/资源冻结。
- 取消：跨版本状态迁移、旧 Schema 兼容层、默认版本升级/切回协调、会话内可执行包副本、卸载后存档专属激活、携带包的存档导入与长期卸载保留包回收层。
- 引用仅服务于“有依赖就禁止卸载”和操作中恢复；不能因简化而移除创建/导入/删除/卸载之间的持久引用与竞态保护。
- 作者实现当前版本玩法及快照，不手工管理宿主 epoch、租约、授权凭据、收据与事务日志；宿主/SDK 提供封装。共享库依赖仍需声明，不要求作者维护跨版本兼容矩阵。
- 默认安装发行清单仍保留；运行时默认版本切换取消。启用、授权、卸载均能定位精确安装项，不把 2.0 的安装或启用操作应用到 1.0。
- 会话导出不包含可执行包；导入前要求精确版本及依赖已安装并获本机授权，不能把旧状态装入新版本。外部备份不阻止卸载，但再次导入需要重新取得原包。
- 不取消其它已批准的官方三包、完整玩法、UI 扩展、演练、公共效果及 PC/Electron 验收范围。

### 下一轮实施顺序与完成条件

1. [x] 从当前实现树 c58c8db 核对最新代码/WIP，盘点与新策略冲突的 registry/lifecycle、binding/frozen、UI discovery、导入导出和 SDK 契约；记录消费者后修改，不删除仍有用途的内容快照。
2. [x] 将安装/启停/选择/贡献身份改为逐版本；移除 default-version 升级探测与切回接线需求。完成 1.0/2.0 并存、分别新建会话、禁止旧档改绑。代码与自动化证据见 §36；真实浏览器/Electron 验收另列，不据此勾选 P7。
3. [ ] 用精确安装引用替代会话内可执行包；修改包/资源解析与会话导出导入，缺包明确拒绝。精确引用和完整静态导出已落地（§36–§37），完整导入协调仍待实现，本项不整体勾选。既有隔离旧格式夹具改为重建，不开发迁移旁路；真实数据保持原状。
4. [ ] 接通卸载预览、独立确认删除会话、删除完成后释放引用、卸载重验及恢复；覆盖新增引用竞态、失败删除、实例/演练/依赖包占用，不隐式删档。
5. [ ] 封装作者 SDK，并同步 API/Schema/管理界面/模板/文档与旧测试；以 §13 A10–A12、A16、A25–A27 验证本次收敛，不能仅修改文字或放开旧门禁。
6. [ ] 继续同版本统一节点回档 coordinator：保留 §34 的完整检查点、旧 owner 实际回收、新 epoch 与文件/SQL 决定一致性要求。减少跨版本兼容不等于取消同版本回档。
7. [ ] 完成官方 narrative 实质拆包和完整流程，再推进 sideview/tactical、奖励成长、演练、其余扩展与 P7；按新规则清理旧路径，保留完整原定产品范围。

决策记录阶段完成：文档规则、阶段任务、API 目标与验收矩阵更新及一致性检查；当时未开始代码改造或新验收。后续实施以 §36 的实测证据更新上述复选框，不沿用历史数字。


## 36. 精确版本安装实施与验收（2026-10-08，阶段已提交，总体未完成）

### 当前工作区与范围

- 从已验收检查点 c58c8db 新建 D:/Code/arknights-tavern-version-installs，分支 feat/plugin-version-installs。
- 本轮本地提交 1e463069d907b525f041549743e8a8d3c16a0f58（80 个文件，含 4 个新文件）；提交后工作树 clean。当前 task.md 为 ignored 文件，单独同步主工作区与 version-installs，不在 Git 提交内；checkpoint-acceptance 保留原阶段记录。
- 主工作区 main 与原 unified-plugins/checkpoint-acceptance 工作树保持；未合并、未推送，未读写真实存档或重启用户服务。
- §35.1 盘点完成：registry/lifecycle 默认指针、bindings 预检、session/frozen 执行旁路、UI discovery/贡献键、SDK/API/创建向导和管理页均有消费者；现有 combat_binding 仅保存内容/资源，不含可执行包。
- 本轮当时统一存档导入仍在持久写入前拒绝，引用式导入/完整导出尚未实现；后续完整静态导出见 §37，不能把移除卸载旁路或导出成功视作导入已完成。旧内部 registry schema 1 不迁移，隔离夹具使用 schema 2，真实数据未转换。

### 本轮已落地

- packages 按精确版本保存 enabled；移除 defaults 表、default-version API、升级 activation_probe 和 collectable 回收候选层。
- 兼容请求显式 version，创建请求显式 pluginVersion（无模式为 null）；会话仍使用原 modeLock，不改绑其他版本。
- 执行要求根包和完整依赖已安装、启用、获本机授权；静态已安装快照可在停用/撤权后读取，不再提供卸载后执行。
- 卸载预览覆盖会话/演练/预留/依赖包/实例/未完成操作；写锁下重验，先记录禁止执行的删除意图，再安全删除精确包文件及安装记录，失败留日志可恢复。
- 有活动实例时停用明确拒绝；自动保存/暂停/跨窗口停止协调尚未据此放行。管理页会话名称补全、全部原生验收仍需后续门禁。
- 前端双版本选择、版本化贡献键与路由已同步。选择保存完整 PackageLock，不因安装/启用另一个版本而静默改选；贡献键为 pluginId@version:contributionId，应用页路由为 /plugins/<id>/<version>/<pageId>。包作者仍声明包内 ID，不承担版本拼接。
- 修复跨版本授权失效：每个包保存单调 authority_revision，叙事、模型请求、随机、结果校验及固定效果预览只比较精确依赖闭包的最大事件序号。无关版本不取消当前操作；同包/依赖撤权后重授或停用后重启仍使旧凭据失效。run_events 全局唤醒保留。
- 修复共享 browser engine lease 被普通 UI ACK 错误关闭：持久 owner_kind 固定 ui/browser 路径，辅助 browser metadata 缺失和 live UI 内存清空均不能降级放行。
- 卸载引用重验覆盖缺失 retained_refs 但仍有 session_create 持久日志的情况；失败删除只在启动恢复重试，不伪造成功或恢复可执行性。完成卸载移除包记录，不保留长期包 tombstone；同版本不同字节只允许在原安装完全卸载后重装，外部备份仍必须匹配原摘要。

### 本轮验收证据

- 下列组有交叉，不相加为不重复总数；均是本轮 schema 2 与新版本策略下的实测，不引用 §16–§34 的旧通过数字。
- 卸载新增测试与内容存储：78 passed。
- 注册表、会话绑定/删除与管理 HTTP：273 passed /80.19s。
- 剧情检查点/发布、公共效果结算、结算、随机：173 passed /383.84s。
- Python runtime、校验规则、会话绑定、注册表、run events、应用生命周期：212 passed /183.88s。
- 会话 UI、browser HTTP、叙事 provider、UI runtime：134 passed /215.73s；早先四个失败修复后复跑通过，不将失败运行计为通过。
- 契约、绑定、统一创建、browser HTTP、管理 HTTP、内容存储及卸载：508 passed /185.10s。
- 精确闭包授权新增测试、叙事 generation/provider、注册表及 run events：178 passed /199.41s。
- 最终 schema 1 原字节拒绝、逐版本授权/卸载、会话 UI 与 browser HTTP 联合：102 passed /158.81s。包括最后增加的 owner_kind、清空 live UI 内存、缺失辅助 browser metadata 断言。
- 最后应用状态、叙事轮次、run 状态及结算 HTTP 联合：176 passed /348.17s。
- 前端插件/创建向导/管理客户端：493/493；npm run build 通过（包含 Electron main/preload 产物），SDK 协议生成检查通过。构建不是 Electron 运行证据。
- 生命周期/删除恢复与跨版本授权经过独立审查，限定范围未发现新增可操作缺陷。
- 授权消费者专项：LLM/随机收据两文件 80 项通过；新增消费者文件 15 passed /105.62s，合计该专项 95 项。覆盖无关版本变更、根包/依赖 ABA、固定预览不重执行和真实 Python worker 随机调用。模型请求使用受控模拟，不是真 LLM 验收；初轮 14 个独占 lease 夹具错误修复后全量复跑通过，未放宽生产门禁。
- 提交前最终前端重跑仍为 493/493，生产及 Electron main/preload 构建再次通过；构建有 Vite CJS 弃用与体积提示，不是运行错误。SDK 四投影与 staged diff --check 通过，80 个已提交文件均为 blob LF / 工作区 CRLF。共享 node_modules junction 和 tsc/vite 入口已核对保留。

可复跑的最后联合命令（仓库根目录）：

```powershell
python -m pytest tests/test_plugin_version_authority_v1.py tests/test_plugin_version_uninstall_v1.py tests/test_plugin_session_ui_v1.py tests/test_plugin_browser_http_v1.py -q -o addopts= --disable-warnings --maxfail=3
python -m pytest tests/test_plugin_application_state_v1.py tests/test_plugin_narrative_rounds_v1.py tests/test_plugin_runs_v1.py tests/test_plugin_settlement_http_v1.py -q -o addopts= --disable-warnings --maxfail=3
$pluginTests = @(rg --files frontend/src/features/plugins -g '*.test.mjs')
node --test --test-reporter=spec @pluginTests frontend/src/components/session/sessionCreation.test.mjs frontend/src/components/session/CreateSessionWizard.test.mjs scripts/test_plugin_admin_client.mjs
node frontend/plugin-sdk/generate-protocol.mjs --check
# 在 frontend 目录执行 npm run build
```

### 未覆盖与下一步

- 浏览器桥枚举和新建 Chrome 页均返回 nodeRepl.fetch request failed；未启动额外验收服务，未取得真实浏览器截图/交互证据。Electron 仍未验收。
- 桌面待执行清单 docs/design/plugins/admin-desktop-qa.md 已指向当前 version-installs 树；需五固定视口、四主题及 Electron 窗口/窗口全屏/全屏、file/preload、真实下载等独立运行证据。未跑统一入口全量后端/perf，不声称全仓通过。
- §35.2 的代码与自动化完成；§35.3–§35.5 仍未整体完成。下一步先接引用式导出/导入（不携包、先精确依赖准入、持久引用/CAS/失败恢复），再补管理页会话名称与删除导航闭环、实际停止协调、作者 SDK/模板封装及相应 A10–A12/A16/A25–A27 验收。
- 随后继续 §35.6 的同版本统一回档 coordinator（公共/私有检查点、旧 owner 回收、新 epoch、文件/SQL 唯一决定），再推进官方 narrative/tactical/sideview 实质拆包、奖励成长、演练、其它扩展和 P7。未因简化跨版本策略缩减原产品范围。

## 37. 完整引用式存档静态导出（2026-10-08，阶段已提交，总体未完成）

### 实现与边界

- 续做基线为 version-installs / 1e46306，分支 feat/plugin-version-installs；本阶段本地提交 696298ec5306a12660285ace11b60d06c2e18e2e（17 个文件）。提交后 tracked 工作树 clean；main/dbeafef 不变。两份 ignored task.md 单独同步，不在 Git 提交中；未触碰真实数据、安装包、配置或服务。
- 旧 ZIP 只复制会话目录，遗漏 SQLite 运行/随机/模型收据与剧情检查点；源 SessionUpdates 日志绑定绝对根和文件身份，不能直接移植。新格式为 ark-session-archive/1，仅完整静态导出和只读结构校验，导入协调器仍未实现。
- [x] 独占会话准入，子租约保留 exclusive；registry → manager → overlay 固定锁序；无活动实例、owned/active run、pending command/model 或未结束文件事务才可导出。停用、撤权、安装目录缺失仍能静态备份，不自动执行、保存、停止或授信。
- [x] 精确版本/依赖需求，不携可执行包；全部文件清单、字节数、SHA-256，安全路径与配额。临时 ZIP 在同一打开句柄完整复核后 fsync/no-clobber 发布；失败无半 ZIP，已有或并发出现的目标不覆盖。
- [x] 保留所有历史 epoch 的完整 run、终态命令/模型/动作观察/随机账本。模型 succeeded/failed/unknown、预留预算、结果与已知用量不丢失；历史 owner ID 只作证据，不携 grants、leases、token、事件时钟或未采用的预览缓存。
- [x] 剧情检查点保留完整五文件（区分缺失与空文件）及 projection；结算保留已采用 verification/effectImage 与源账本。portable fileDecision 去除根路径和文件身份；原 fileManifestDigest 仅作来源证据，不冒充目标机恢复日志。
- [x] 校验索引覆盖、内部 JSON、账本字段/业务键/关联、可重算摘要；completed run 反向要求唯一 committed settlement 与 confirm receipt。当前会话 JSON 和历史图像分别校验；检查点文件配额在分配 BLOB 前检查。
- [x] 正式契约 docs/design/plugins/session-archives.md 已新增；内容绑定、创建/运行存储、运行 HTTP、architecture 和 notes 已同步现状。仍保留尚未拆包玩法所需的旧出口，不将其用于统一存档迁移。

### 验收与修复记录

- 各组有交叉，不相加为不重复总数。首组真实创建/Python运行/暂停/HTTP导出 13 passed /34.52s；随后导出与场景媒体/旧文件夹出口/准入/创建存储联合 95 passed /110.47s。
- 补全故事/公共效果与历史 epoch 后，真实导出专项 17 passed /97.14s；审查修复后的首轮真实专项再次 17 passed /96.41s。
- 格式安全 162 passed；新增运行索引、坏 JSON、身份/关联、检查点配额与历史 claim/动作 revision 测试后，格式+结构最终 273 passed /9.58s。
- 真实公共效果/已采用源账本及模型三终态专项 4 passed /38.18s；模型使用受控替身，Python worker、HTTP、SQLite 和导出实际执行，不是真 LLM 验收。
- 独立审查先发现完成态可缺结算证据、账本坏 JSON/重复业务键、当前会话坏 JSON 三项；已修复并复审关闭。复审另指出合法 claim 的 SQL owner_id 实际为 NULL、观察 revision 缺少动作原值对照，两项已按生产契约修复并补回归，最终复核关闭，限定阶段 pass。审查为源码/测试逻辑复核，实际测试由主代理执行，不重复计数。
- Windows ZipInfo 路径归一化、保留路径大小写别名、排他子租约丢失、宽泛 ValueError 覆盖 PluginError 诊断均已修复；失败运行未计为通过。
- 最终归档三文件、场景媒体、旧文件夹出口、HTTP 准入与统一创建联合：386 passed /173.22s。提交前 git diff --cached --check 通过；17 个已提交文件均为 blob LF / 工作区 CRLF。无本轮前端改动，未重复构建或借旧截图声称通过。

可复跑的最终联合命令（version-installs 根目录）：

```powershell
python -m pytest tests/test_session_archive_format.py tests/test_plugin_session_archive_structure_v1.py tests/test_plugin_session_archive_v1.py tests/test_scene_media.py tests/test_session_export_folders.py tests/test_session_http_access.py tests/test_unified_session_creation.py -q -o addopts= --disable-warnings --maxfail=3
```

### 下一步与未验收范围

- [ ] 引用式导入仍在任何持久写入前明确拒绝：需要目标机精确依赖/授权、原身份冲突策略、终态来源证据登记、本机新执行身份、会话/快照世界书双目标发布、持久引用/CAS 与崩溃恢复。
- 缺失原请求输入的摘要只能验证形状和现有关联；归档自洽不证明源真实性或目标机权限。不能把此导出阶段勾选为 §35.3、A12 或 P0–P7 全部完成。
- 然后继续 §35.4–§35.7 的管理/删除导航、停止协调、SDK、同版本统一回档、官方三包实质实现、奖励成长、演练和其它扩展。浏览器/Electron 五视口/四主题/窗口模式、真实下载及真 LLM 门禁仍未执行。
- 本轮仅本地 feature 里程碑，不合并 main、不推送；两份 ignored task.md 单独同步，真实用户数据保持原状。
