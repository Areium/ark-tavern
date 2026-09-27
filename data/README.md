# Data 目录

世界设定、角色、剧情及配套资源集中在世界书目录。平台本体不预设世界观；
《明日方舟》资料是可选的离线内容包。旧内容的物理路径和 ID 保持兼容，
运行时由 `content_manifest.json` 及已安装、已启用的书决定其可见性。

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
│   ├── content_manifest.json  离线内容的世界书归属清单，受版本控制
│   ├── <book_id>.json     用户书及已安装副本，本地数据
│   ├── settings.json      旧版本世界书设置，本地数据
│   └── *.bak              旧版内容刷新前的恢复副本，本地数据
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
- `combat/nodes/*.json`、职业 `cards.json`、`combat/rules/*.json` 与 `combat/tiles/*.json`
  继续由引擎读取，不转换成自然语言世界书条目。战斗配置的唯一真相源不变。
- `imports` 继续使用 `类别/文档ID`，例如 `classes/向导`，不写物理目录。

## 从旧布局升级

先停止正在运行的应用/后端，再执行：

```powershell
python scripts/migrate_data_layout.py
python scripts/migrate_data_layout.py --apply
```

默认只预览。迁移器先检查全部目标冲突，保留本地角色素材，逐文件验证内容，支持中断后重跑；
用户世界书、设置、备份和会话不移动。旧 `worldbook_jobs`、`worldbook_analysis` 移入 `archive/` 留存。
若目标已有不同内容，处理冲突后再运行，不会覆盖。新检出的仓库无需迁移。
