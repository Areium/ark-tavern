import type { ScenePanelProps } from "../../plugins/scenePanels";
import CharacterPanel from "../CharacterPanel";
import ItemPanel from "../ItemPanel";
import EnvironmentPanel from "../EnvironmentPanel";
import StoryStatePanel from "../StoryStatePanel";
import MemoryPanel from "../MemoryPanel";

export function SceneOverviewPanel({ ctx }: ScenePanelProps) {
  return <div className="scene-overview">
    <section className="scene-overview-section" aria-label="角色"><CharacterPanel refreshKey={ctx.refresh.character} /></section>
    <section className="scene-overview-section" aria-label="物品"><ItemPanel refreshKey={ctx.refresh.env} /></section>
    <section className="scene-overview-section" aria-label="环境"><EnvironmentPanel /></section>
  </div>;
}

export function StoryOverviewPanel() {
  return <div className="scene-overview">
    <section className="scene-overview-section" aria-label="剧情进度"><StoryStatePanel /></section>
    <section className="scene-overview-section" aria-label="回忆"><MemoryPanel /></section>
  </div>;
}
