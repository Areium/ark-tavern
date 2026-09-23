/** Built-in sidebar groups; individual content panels keep their existing behavior. */
import { registerScenePanel } from "./scenePanels";
import { SceneOverviewPanel, StoryOverviewPanel } from "../components/scene/OverviewPanels";
import QuestPanel from "../components/QuestPanel";
import SessionResourcePanel from "../components/session/SessionResourcePanel";

registerScenePanel({
  id: "characters", title: "场景", icon: "users", order: 10, hint: "角色、随身物品与当前环境",
  component: SceneOverviewPanel,
});
registerScenePanel({
  id: "story", title: "剧情", icon: "workflow", order: 40, modes: ["story"], hint: "剧情进度与旅途回忆",
  component: StoryOverviewPanel,
});
registerScenePanel({
  id: "quests", title: "任务", icon: "check", order: 60, modes: ["story"], hint: "任务状态",
  component: () => <QuestPanel />,
});
registerScenePanel({
  id: "resources", title: "资源", icon: "images", order: 80, hint: "会话资源：角色形象覆盖、背景覆盖、存档导入导出",
  component: () => <SessionResourcePanel />,
});
