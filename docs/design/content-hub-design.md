# 内容中心（Content Hub）整合设计

> 状态：已实施（2026-08） · 目标：整合「资产 / 索引」为统一的内容中心，世界书保留独立管理入口
> 关联目标：内置方舟内容开箱即用 · 导入内容自由扩展 · 无重复入口 · 管理模式统一可解释
> 后续变更（2026-09，世界书工作台重构）：内容中心不再有「世界书图谱」「索引」两个 Tab —— 前者取消，后者改名「本家索引」并搬进世界书工作台；内容中心只保留 **资产 / 卡牌 / 节点图**。见 `proposals/worldbook-workbench-redesign.md` §2.2。

---

## 1. 背景沿革（为什么不再有「三个模块」）

内容中心最初由「资产 / 索引」两个分立页面合并而来；早期并存的 **文档管理入口（前端 `DocumentManager.tsx`）已移除**——世界观语料改由 `scripts/generate_builtin_worldbook.py` 整理为世界书整合包（`data/packs/arknights.json`），浏览与编辑统一走世界书模块。（后端 `src/document_manager.py` 与 `documents` blueprint 仍保留，继续承担文档 CRUD。）
世界书**未并入**内容中心，仍是独立入口：其管理页负责书的 CRUD / 导入 / 条目编辑。依赖配置与索引一度挂在内容中心（「世界书图谱」「索引」两个 Tab），2026-09 起全部收回世界书工作台的五个页签（`条目` / `分类与载入` / `Prompt 预览` / `节点视图` / `本家索引`），内容中心不再有任何世界书相关 Tab。

## 2. 统一管理模式

### 2.1 单一入口：内容中心

「资产 / 索引」合并为 **「内容中心」** 一项；**世界书保留独立入口**（世界书已工作台化，与内容中心不再重叠）。内容中心内部按 Tab 组织（当前共三个 Tab）：

| Tab | 内容 | 来源组件 |
|---|---|---|
| 资产 | 图片资产上传 / 裁剪 / 默认图 / 按来源世界书筛选 | AssetManager |
| 卡牌 | 角色卡牌与职业卡牌编辑、所属世界书 | CardManager |
| 节点图 | 按设定集选择剧情，整页画布编辑节点图 | PlotGraphPage |

世界书依赖与索引都不在内容中心：依赖关系与起点在 `分类与载入`，内置语料索引 / 依赖完整性 / 会话白名单在 `本家索引`（仍在内容中心的只有资产、卡牌与战斗节点图）。

### 2.2 统一管理模式：内容包（Content Pack），不做内置/导入分层

**核心决策（2026-08）：本家内容不做「内置只读层」，而是随程序分发一个整合包（Pack），与任何第三方内容在同一套管理规则下统一管理。**

| 来源 | 含义 | 存储 | 管理规则 |
|---|---|---|---|
| **预装（preinstalled）** | 随程序分发的方舟整合包，首次启动自动安装 | 分发源：`data/packs/*.json`（git 跟踪）；安装副本：`data/worldbooks/<id>.json`（gitignored） | 与导入内容**完全相同**：可编辑、可停用、可删除；删除后可从分发源一键「重装」 |
| **导入（imported）** | 用户导入/新建（第三方世界书、自制内容） | `data/worldbooks/*.json`（gitignored） | 完全可写 |

要点：

1. **存储统一**：所有书都在 `data/worldbooks/`，同一份列表、同一套 CRUD、同一个启用/停用开关——管理模式只有一套，可解释。
2. **开箱即用**：`WorldBookManager` 初始化时自动把 `data/packs/` 下的整合包复制到 `data/worldbooks/`（不存在才装），新用户零配置即有方舟世界书。
3. **来源标识（徽章）**：预装 = 青（可「重装」还原），导入 = 紫。仅作来源说明，不影响任何操作权限。
4. **程序 IP 中立**：用户可整体停用/卸载方舟整合包，导入自己的世界观内容，程序不绑定方舟。
5. 文档侧（角色/剧情/索引）属于程序内置故事内容（`data/<category>/`）；**角色卡导入**（SillyTavern 角色卡 PNG/JSON → `data/characters/<slug>/` + 内嵌世界书）已实现，frontmatter 带 `source: imported` 来源标识。

### 2.3 启用/停用语义统一

- **书级**：`WorldBook.enabled`（新增，默认 true）。停用的书不参与解析（resolve 跳过）。
- **条目级**：`entry.enabled`（已有）。
- **文档级**：会话索引白名单（已有）——启用哪些实体进入会话上下文。

### 2.4 开箱即用：方舟整合包

1. `scripts/generate_builtin_worldbook.py`：从 `data/characters/*/index.md`（角色名/别名/设定摘要）与 `data/plots/`（剧情概述）生成 `data/packs/arknights.json`（角色条目：触发词=角色名+别名；剧情条目：触发词=剧情名）。
2. 首次启动自动安装到 `data/worldbooks/arknights.json`（source=preinstalled）。
3. 解析回退链：**会话绑定 > 全局默认书 > 已启用的预装包（arknights）** —— 新用户零配置即有世界书生效。

### 2.5 统一检索

内容中心顶部全局搜索框：跨世界书书名/条目内容/条目触发词检索（后端新增 `GET /api/worldbook/search?q=`，文档侧复用现有 `/api/documents/search`）。

## 3. 接口变更

### 后端

- `GET /api/worldbook`：列表项新增 `source`（preinstalled/imported）、`is_preinstalled`、`enabled`。
- `GET /api/worldbook/<id>`：同上。
- `PUT /api/worldbook/<id>`：所有书均可更新（含 `enabled` 开关）；无只读限制。
- `DELETE /api/worldbook/<id>`：所有书均可删除（预装包删除后可用「重装」还原）。
- `POST /api/worldbook/<id>/reinstall`：从分发源重装预装整合包（恢复出厂内容）。
- `POST /api/worldbook/<id>/duplicate`：复制任意书为新导入书（做变体/备份）。
- `GET /api/worldbook/search?q=`：跨书/条目检索。
- `resolve`：回退到已安装且启用的预装包（`data/packs/` 分发源存在且 `data/worldbooks/` 中副本 enabled）。

### 前端

- `useApi`：`duplicateWorldbook`、`searchWorldbooks`、`updateWorldbook` 支持 enabled。
- 新组件 `ContentHub.tsx`、`SourceBadge.tsx`。
- `GameTopBar` / `HomeMenu`：资产与索引两项导航合并为「内容中心」；世界书保留独立导航入口。
- 前端 `DocumentManager.tsx` 已删除（后端 `src/document_manager.py` 保留）；其「资产 / 卡牌」Tab 分别独立为 `AssetManager.tsx` / `CardManager.tsx`，
  文档管理功能并入世界书整合包（见 §1 背景沿革）。

## 4. 验收对照

- [x] 新用户无需导入 → 方舟整合包自动安装，角色/剧情开箱即用
- [x] 第三方世界书与预装包共存于同一列表，来源徽章清晰可辨；可停用/卸载/重装
- [x] 无重复入口：内容中心单入口（资产 / 卡牌 / 节点图）+ 世界书依赖与索引收进世界书工作台页签
- [x] 统一检索、书级启用/停用、复制、重装

## 5. 数据模型（世界书存储格式）

分发源：`data/packs/<id>.json`（git 跟踪）→ 首次启动安装副本：`data/worldbooks/<id>.json`（gitignored）：

```json
{
  "id": "arknights",
  "name": "明日方舟·整合包",
  "source": "preinstalled",
  "enabled": true,
  "source_format": "builtin",
  "budget_tokens": 0,
  "entries": [ { "uid": "...", "name": "...", "content": "...", "trigger_keys": [...], ... } ]
}
```
