# Data 目录

世界设定、角色、剧情及配套资源集中在世界书目录。平台本体不预设世界观；
《明日方舟》资料是可选的离线内容包。运行时由 `content_manifest.json`
及已安装、已启用的书决定其可见性。

```text
data/
├── categories.yaml        类别注册表：逻辑类别 → content 内的物理目录
├── worldbooks/
│   ├── content/           可编辑的结构化内容与资源（随程序分发）
│   │   ├── characters/    角色 index.md、头像/立绘/Spine、专属 combat.json
│   │   ├── classes/       职业设定与 cards.json
│   │   ├── world/         世界观
│   │   ├── factions/      势力
│   │   ├── races/         种族
│   │   ├── items/         物品设定与战斗效果
│   │   ├── enemies/       敌人设定与 combat_stats
│   │   ├── environment/   Location/、weather/；时段是代码内置列表
│   │   ├── plots/         剧情 index.md 与节拍
│   │   ├── attributes/    属性参考
│   │   ├── rules/         叙事机制说明
│   │   ├── combat/        nodes/、backgrounds/、tiles/、rules/
│   │   └── audio/         音乐及音效
│   ├── packs/             可选离线内容包 JSON，受版本控制
│   ├── books/             已安装的书，一本书一个 <book_id>.json，本地数据
│   ├── inbox/             复制 .arkwb / 酒馆 JSON 到这里，刷新书架即导入
│   ├── exports/           工作台导出的完整 .arkwb 包，可直接复制走
│   ├── content_manifest.json  离线内容的世界书归属清单，受版本控制
│   ├── local_content_manifest.json  完整包导入资源的本地归属，本地数据
│   ├── <book_id>.json     旧版已安装书位置，可读取并迁移
│   ├── settings.json      旧版本世界书设置，本地数据
│   └── *.bak              手动重装或修复前的恢复副本，本地数据
├── memory/                运行时创建的会话、向量记忆、战斗恢复（本地数据）
└── archive/               迁移时按需创建，保留已下线 AI 构建缓存
```

## 管理与读取

- `src/data_paths.py` 定义内容根目录和离线内容包位置。Document/Wiki/资产管理使用
  `categories.yaml`；角色、环境、剧情、卡牌、战斗加载器使用同一内容根目录。
- 世界书工作台编辑书条目；节点图编辑关联剧情和战斗节点；资产与卡牌管理按
  `worldbook_id` 展示归属。仓库内的离线内容须显式安装相应内容包才可读取；
  停用或删除书后，其角色、剧情、战斗数据和素材从运行时目录与直达 URL 隐藏。
  分发源仍留在仓库，方便之后重新安装，不属于已安装的运行时内容。
- Markdown 是结构化实体来源，书 JSON 是可独立编辑的注入内容；两者不会在编辑时自动互相覆盖。
  `scripts/generate_builtin_worldbook.py` 显式生成离线内容包，
  `scripts/generate_content_manifest.py` 更新其资源归属清单；启动不自动安装或刷新已安装副本。
  用户可在世界书工作台显式安装、删除或重装内容包，重装会覆盖该书当前安装副本。
  若检测到同名安装副本仍使用已停止支持的内部 schema，示例页会显示「备份并修复」；
  用户确认后先保存一份 `*.unsupported-schema-*.bak`，再安装当前内容包。
- `combat/nodes/*.json`、职业 `cards.json`、`combat/rules/*.json` 与 `combat/tiles/*.json`
  继续由引擎读取，不转换成自然语言世界书条目。战斗配置的唯一真相源不变。
- `imports` 继续使用 `类别/文档ID`，例如 `classes/向导`，不写物理目录。
## 整本复制与直接导入

- 在工作台点击「导出完整包」会下载 `<book_id>.arkwb`，同时在 `exports/` 留下一份。
  包内有原生书 JSON、该书所属 `content/` 资源、每个资源的大小和 SHA-256。
  酒馆 JSON 导出仍在「更多」中，适合和其他酒馆交换条目，但不包含全部剧情、战斗和图片文件。
- 把 `.arkwb` 或已有酒馆 `.json` / `.jsonl` 复制到 `inbox/`，刷新世界书书架即可导入；
  原文件保留，记录在 `inbox/.imported.json`，重启和再次刷新不会重复导入。同名文件内容更新后会重试。
  也可以用工作台「导入」直接选择 `.arkwb`。完整包保留书 ID；若目标已有相同 ID，先处理冲突，系统不会覆盖。
- 完整包导入先校验路径、哈希和现有资源；同路径同内容可共享，不同内容会拒绝。
  导入的资源仍由现有加载器从 `content/` 读取，本地归属由 `local_content_manifest.json` 记录。
  停用或删除书会隐藏其独占资源；删除不自动清掉可能仍被别处引用的共享文件。
- 旧版根目录 `<book_id>.json` 可继续使用。停用应用后运行
  `python scripts/migrate_worldbook_layout.py` 预览，再运行
  `python scripts/migrate_worldbook_layout.py --apply` 移入 `books/`；脚本不重写书内容，
  不符合当前 schema 的书会留在原处，先在示例页备份并修复，再重新迁移。
