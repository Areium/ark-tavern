# Data 目录

世界设定、角色、剧情及配套资源集中在世界书目录。平台本体不预设世界观；
《明日方舟》资料是可选的离线内容包。安装后的书及其资源放在同一文件夹中；
旧版共享目录只作为离线分发源和一次性迁移来源；运行时读取已安装书文件夹。

```text
data/
├── categories.yaml        类别注册表：逻辑类别 → content 内的物理目录
├── worldbooks/
│   ├── books/             已安装世界书，每本书一个文件夹（本地数据）
│   │   └── <book_id>/
│   │       ├── book.json  书名、条目、启用状态等
│   │       ├── characters/ 角色卡、头像与立绘
│   │       ├── plots/     剧情、节拍与插画
│   │       ├── combat/    战斗节点、背景、格子与规则
│   │       └── audio/     音乐与音效；其他类别按需加入
│   ├── content/           离线内容分发源和旧数据迁移来源
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
│   └── content_manifest.json  离线内容的世界书归属清单，受版本控制
├── memory/                运行时创建的会话、向量记忆、战斗恢复（本地数据）
└── archive/               迁移时按需创建，保留已下线 AI 构建缓存
```

## 管理与读取

- `src/data_paths.py` 定义安装位置；`categories.yaml` 定义书内类别目录的相对路径。
  会话按绑定书籍的顺序寻找资源，同名文件优先取顺序靠前的书。
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

- **复制导出**：直接复制 `books/<book_id>/` 整个文件夹，包含 `book.json` 和书内图片、
  音乐、剧情、战斗等文件。可以在副本内直接查看和修改资源。
- **复制导入**：把完整文件夹放入 `books/`，然后在工作台刷新书架。
  文件夹名须与 `book.json` 的 `id` 一致；已有同 ID 的书不会被覆盖。修改已安装文件后也要刷新书架。
- **应用内导入**：酒馆 `.json` / `.jsonl` 或含世界书的角色卡会新建 `books/<书 ID>/book.json`。
  酒馆文件通常只包含条目，不会凭空生成独立图片、音乐、剧情和战斗资源。
- 旧版散装书 JSON 和 `inbox/` 不再作为导入来源。迁移旧数据时，先备份原件，再手动整理为完整书文件夹。
