import { useState } from "react";
import { useAppStore } from "../../stores/appStore";
import type { ScenePanelProps } from "../../plugins/scenePanels";
import CharacterPanel from "../CharacterPanel";
import ItemPanel from "../ItemPanel";
import EnvironmentPanel from "../EnvironmentPanel";
import StoryStatePanel from "../StoryStatePanel";
import MemoryPanel from "../MemoryPanel";

export function SceneOverviewPanel({ ctx }: ScenePanelProps) {
  const [tab, setTab] = useState(() => {
    const saved = useAppStore.getState().scenePanelTab;
    return saved === "items" || saved === "environment" ? saved : "characters";
  });
  return <>
    <nav className="scene-subnav" aria-label="场景分类">
      {[["characters", "角色"], ["items", "物品"], ["environment", "环境"]].map(([id, label]) =>
        <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}
    </nav>
    {tab === "characters" && <CharacterPanel refreshKey={ctx.refresh.character} />}
    {tab === "items" && <ItemPanel refreshKey={ctx.refresh.env} />}
    {tab === "environment" && <EnvironmentPanel />}
  </>;
}

export function StoryOverviewPanel() {
  const [tab, setTab] = useState(() => useAppStore.getState().scenePanelTab === "memory" ? "memory" : "story");
  return <>
    <nav className="scene-subnav" aria-label="剧情分类">
      <button type="button" aria-pressed={tab === "story"} onClick={() => setTab("story")}>剧情进度</button>
      <button type="button" aria-pressed={tab === "memory"} onClick={() => setTab("memory")}>回忆</button>
    </nav>
    {tab === "story" ? <StoryStatePanel /> : <MemoryPanel />}
  </>;
}
