# 场景面板插件

对话页左侧的「场景面板」是插件化的：每个页签（角色 / 物品 / 环境 / 剧情 / 回忆 / 任务 / 数值 / 资源）
都通过同一个注册表 `registerScenePanel()` 挂上去。想给会话加一个自己的数据面板，只需要在本目录
（`src/plugins/custom/`）放一个 `.tsx` 文件，`plugins/index.ts` 会用 `import.meta.glob` 自动加载它。

## 最小示例

```tsx
// src/plugins/custom/myPanel.tsx
import { useEffect, useState } from "react";
import { registerScenePanel, type ScenePanelProps } from "../scenePanels";

function MyPanel({ ctx }: ScenePanelProps) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    ctx.data.get("my-plugin").then((slot) => setCount(Number(slot.data.count ?? 0)));
  }, [ctx.sessionId]);
  return (
    <button onClick={async () => {
      const next = count + 1;
      await ctx.data.set("my-plugin", { count: next });
      setCount(next);
    }}>点了 {count} 次</button>
  );
}

registerScenePanel({ id: "my-plugin", title: "我的面板", icon: "star", order: 120, component: MyPanel });
```

## 上下文 `ctx`

| 字段 | 说明 |
| --- | --- |
| `sessionId` / `session` | 当前会话 id 与摘要（阵容 `roster`、场景角色 `characters`、`player_identity`、环境等） |
| `chatMode` | `story` / `free` |
| `api` | 完整 REST 客户端（`hooks/useApi.ts`） |
| `refresh` | 系统刷新键：`env` / `memory` / `chat` / `character` / `stats` / `resource`，任一变化就该重新拉取 |
| `stats.list()` | 阵容全部角色的合并数值（世界书字段默认 → 角色全局值 → 会话值），附每个键的来源 |
| `stats.set(name, values, replace?)` | 写会话数值；`null` 删键；字段内的值按类型校验，字段外自由填写 |
| `stats.reset(name)` | 清空会话值，回到角色全局值 |
| `data.get(ns)` / `data.set(ns, obj, replace?)` / `data.remove(ns)` | 本会话的插件数据，按命名空间隔离（`[a-z][a-z0-9_-]{0,39}`，单个命名空间 ≤ 64 KB） |
| `notify(kind)` | 主动通知系统某类数据变了（`stats` / `env` / `character` / `memory` / `resource`） |

会话数值与插件数据都存在会话覆盖层 `overrides.json`（`character_stats` / `plugin_data`），
**随剧情树节点快照一起回档**，也随会话存档导出。

## 对应的 HTTP 接口（`src/blueprints/stage.py`）

```
GET    /api/sessions/<id>/stage                       舞台：背景 / 场景角色立绘 / 环境
GET    /api/characters/<name>/stats                   角色全局数值 + 所属世界书字段
PUT    /api/characters/<name>/stats                   {values, replace?}
GET    /api/sessions/<id>/character-stats             阵容合并数值
PUT    /api/sessions/<id>/character-stats/<name>      {values, replace?}
DELETE /api/sessions/<id>/character-stats/<name>
GET    /api/sessions/<id>/plugin-data
GET    /api/sessions/<id>/plugin-data/<ns>
PUT    /api/sessions/<id>/plugin-data/<ns>            {data, replace?}
DELETE /api/sessions/<id>/plugin-data/<ns>
```

统一字段在世界书工作台的「数值字段」里定义（`PUT /api/worldbook/<id>` 的 `stat_fields`），
字段类型：`number`（可带 min / max / step / default）、`text`、`bool`、`select`（`options`）。

## 约定

- 面板 `id` 用小写字母开头的 `[a-z0-9-]`，也是页签持久化的键；同 id 再次注册会覆盖（便于热重载）。
- `order` 决定顺序：内置面板占 10–80，第三方默认 100。
- 需要只在剧情 / 自由模式其中之一显示时传 `modes: ["story"]`。
- 面板在 `ErrorBoundary` 里渲染：抛错只影响自己这一页，不会拖垮对话页。
- 样式请用 Tailwind 工具类或 `--ng-*` 令牌，皮肤（PRTS / 酒馆）与明暗主题会自动跟随。
