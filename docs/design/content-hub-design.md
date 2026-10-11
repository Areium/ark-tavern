# 内容中心（Content Hub）整合设计

本页保留 2026-08 内容中心与内容包的决策，并说明它们在当前界面中的归属。维护资产、卡牌或世界书入口时先看“当前入口”；旧自动安装、来源徽章和重装接口仅供理解历史，不能作为当前操作步骤。

> 原方案实施时间：2026-08；后续入口与存储重构：2026-09。
> 最近核对：2026-10-11（`HomeMenu.tsx`、`GameTopBar.tsx`、`CharacterManager.tsx`、`WorldBookManager.tsx`、世界书路由与 `data/README.md` 的静态核对；未重跑历史验收或操作用户数据）。

## 当前入口与存储

当前没有独立 `ContentHub.tsx`、内容中心或资源存档一级入口。资源按使用任务挂载：

| 任务 | 当前位置 | 实现入口 |
|---|---|---|
| 管理角色、玩家身份、资产与卡牌 | 角色页模块页签；角色详情还提供该角色的数值、资产和专属卡牌 | [CharacterManager](../../frontend/src/components/CharacterManager.tsx)、[AssetManager](../../frontend/src/components/AssetManager.tsx)、[CardManager](../../frontend/src/components/CardManager.tsx) |
| 编辑世界书、预览 Prompt、编辑剧情节点、查看会话条目 | 世界书工作台的条目 / Prompt 预览 / 节点图 / 会话条目页签 | [WorldBookManager](../../frontend/src/components/WorldBookManager.tsx)、[PlotGraphPage](../../frontend/src/components/combat/PlotGraphPage.tsx) |
| 跨世界书检索 | 世界书工作台左侧书架上方 | 世界书工作台及 `GET /api/worldbook/search?q=` |

`characterTab` 保持角色模块的跨组件导航；世界书节点图使用当前选中的书作为受控书。旧“分类与载入”“节点视图”“本家索引”不能当成当前页签名称，依赖配置编辑 UI 尚未挂载。

自 2026-09-28 起，新项目书架为空。书籍及所属资源统一在 `data/worldbooks/books/<book_id>/`；导入酒馆 JSON/JSONL 创建书文件夹。启动自动安装、`packs/`、`content/`、散装 JSON 和预装徽章已移除，用户仍管理自己的旧安装副本。当前目录与导入说明以[数据目录说明](../../data/README.md)为准。

本页不定义会话恢复协议；不能将静态会话导出或参考归档据此解释为可导入恢复的存档。

## 历史决策：统一管理而非内置只读层（2026-08）

当时的目标是合并资产与索引的重复入口，保留世界书独立管理，并让方舟内容开箱即用、第三方内容可扩展。选择随程序分发可写的 Content Pack，与用户导入内容采用相同管理规则；不建立只能阅读的内置层，也不把程序固定在方舟 IP。

| 当时来源 | 分发与安装位置 | 当时管理行为 |
|---|---|---|
| `preinstalled` | 跟踪的 `data/worldbooks/packs/*.json` → 忽略的 `data/worldbooks/<id>.json` | 首次初始化时缺失才安装；可编辑、停用、删除，能从分发源重装。青色徽章只说明来源，不改变权限。 |
| `imported` | 忽略的 `data/worldbooks/*.json` | 导入或新建，可写；紫色徽章只说明来源。 |

启用有三层含义：书级 `enabled`（默认 true，停用不参与 resolve）、条目级 `entry.enabled`、会话文档索引白名单。它们分别控制不同候选范围，不能互相替代。

旧生成工具 `scripts/generate_builtin_worldbook.py` 从 `data/worldbooks/content/` 生成通用 `arknights.json`，并生成长夜临光、风雪过境、战斗功能测试三本剧情书；角色复制到剧情书，同时保留通用资料。旧解析回退顺序为会话绑定 → 全局默认书 → 已安装且启用的预装包。该回退和自动安装已删除，当前无绑定会话解析为空。

当时的 SillyTavern PNG/JSON 角色卡导入写入 `data/worldbooks/content/characters/<slug>/`，可带内嵌世界书与 `source: imported` frontmatter。这是旧路径记录，当前书文件夹是实际来源，不能使用 frontmatter 来源标记定位运行资源。

## 历史入口演变

1. **早期合并**：资产 / 索引合为内容中心，世界书保留 CRUD、导入与条目编辑。前端 `DocumentManager.tsx` 删除，文档浏览编辑转向世界书；后端 `document_manager.py` 与 documents blueprint 继续承担文档 CRUD。
2. **2026-09 工作台重构**：内容中心的世界书图谱取消，索引改为“本家索引”并迁回世界书。内容中心一度只保留资产、卡牌、节点图；工作台一度使用条目 / 分类与载入 / Prompt 预览 / 节点视图 / 本家索引五页签。
3. **2026-09 信息架构合并**：内容中心一级入口删除，资产与卡牌迁入角色页；节点图迁入世界书，替换旧节点视图；跨书搜索迁到书架。之后的页签名称以首节当前清单为准。

历史设计范围与删除原因见[世界书工作台重构提案](../proposals/worldbook-workbench-redesign.md)。

## 历史接口与数据模型

旧实现为 `GET /api/worldbook` 与 `GET /api/worldbook/<id>` 增加 `source`、`is_preinstalled`、`enabled`；`PUT`、`DELETE` 对所有来源书开放，复制用 `POST /api/worldbook/<id>/duplicate`，重装用 `POST /api/worldbook/<id>/reinstall`，搜索用 `GET /api/worldbook/search?q=`。resolve 跳过停用书，并使用上述预装回退。

前端当时新增 `ContentHub.tsx`、`SourceBadge.tsx`，导航合并资产与索引，`useApi` 增加复制、搜索及 enabled 更新。这些是当时变更清单；重装、来源徽章与预装回退不属于当前接口承诺，现状查[世界书路由](../../src/blueprints/worldbook.py)。

旧分发源与安装副本共同使用的模型示意如下；`entries` 省略完整条目字段，不能照此作为当前导入示例：

```json
{
  "id": "arknights",
  "name": "明日方舟·整合包",
  "source": "preinstalled",
  "enabled": true,
  "source_format": "builtin",
  "budget_tokens": 0,
  "entries": []
}
```

## 历史验收范围

2026-08 原记录将自动安装并开箱即用、预装与第三方共用列表、停用/卸载/重装、统一搜索与复制、内容中心单入口标为完成。该记录没有在本页列出逐项测试条件，本次也未重跑；它不能证明当前版本仍具备已删除的能力，亦不能作为当前 UI 或真实模型验收。
