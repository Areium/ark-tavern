/**
 * 内置场景面板 —— 通过与第三方相同的注册表挂上去（顺序 10–80）。
 *
 * 原有面板组件（角色 / 物品 / 环境 / 剧情 / 回忆 / 任务）本体不变，只是从「左栏堆叠」
 * 改为「页签切换」；会话资源（原右侧独立面板）并入这里成为「资源」页；「数值」是新面板。
 */
import { registerScenePanel, type ScenePanelProps } from "./scenePanels";
import CharacterPanel from "../components/CharacterPanel";
import ItemPanel from "../components/ItemPanel";
import EnvironmentPanel from "../components/EnvironmentPanel";
import StoryStatePanel from "../components/StoryStatePanel";
import MemoryPanel from "../components/MemoryPanel";
import QuestPanel from "../components/QuestPanel";
import CharacterStatsPanel from "../components/scene/CharacterStatsPanel";
import SessionResourcePanel from "../components/session/SessionResourcePanel";

registerScenePanel({
  id: "characters", title: "角色", icon: "users", order: 10, hint: "场景角色：查看详情、切换对话对象",
  component: ({ ctx }: ScenePanelProps) => <CharacterPanel refreshKey={ctx.refresh.character} />,
});
registerScenePanel({
  id: "items", title: "物品", icon: "content", order: 20, hint: "场景物品",
  component: ({ ctx }: ScenePanelProps) => <ItemPanel refreshKey={ctx.refresh.env} />,
});
registerScenePanel({
  id: "environment", title: "环境", icon: "location", order: 30, hint: "地点 / 天气 / 时间；剧情模式可切换场景",
  component: () => <EnvironmentPanel />,
});
registerScenePanel({
  id: "story", title: "剧情", icon: "workflow", order: 40, modes: ["story"], hint: "剧情进度、剧情树与回档",
  component: () => <StoryStatePanel />,
});
registerScenePanel({
  id: "memory", title: "回忆", icon: "book", order: 50, modes: ["story"], hint: "剧情回忆摘要",
  component: () => <MemoryPanel />,
});
registerScenePanel({
  id: "quests", title: "任务", icon: "check", order: 60, modes: ["story"], hint: "任务状态",
  component: () => <QuestPanel />,
});
registerScenePanel({
  id: "stats", title: "数值", icon: "index", order: 70, hint: "角色数值：世界书统一字段 × 角色全局值 × 会话值",
  component: CharacterStatsPanel,
});
registerScenePanel({
  id: "resources", title: "资源", icon: "images", order: 80, hint: "会话资源：角色形象覆盖、背景覆盖、存档导入导出",
  component: () => <SessionResourcePanel />,
});
