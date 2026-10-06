/**
 * 管理页面顶栏 — 取代原 sidebar：返回主菜单 + 管理页导航 + 音频开关。
 * 仅在非沉浸式页面（会话大厅/资产/世界书/索引/文档/设置）显示。
 */
import { useState } from "react";
import { useAppStore } from "../stores/appStore";
import { audioManager } from "../audio/audioManager";
import AppIcon, { type AppIconName } from "./AppIcon";

type ManageView = "sessions" | "characters" | "worldbook" | "combat-modes" | "docs" | "settings";

const NAV_ITEMS: { id: ManageView; label: string; icon: AppIconName }[] = [
  { id: "sessions", label: "会话大厅", icon: "sessions" },
  { id: "characters", label: "角色", icon: "characters" },
  { id: "worldbook", label: "世界书", icon: "worldbook" },
  { id: "combat-modes", label: "战斗模式", icon: "combat" },
  { id: "docs", label: "文档", icon: "docs" },
  { id: "settings", label: "设置", icon: "settings" },
];

export default function GameTopBar() {
  const { currentView, setCurrentView } = useAppStore();
  const [muted, setMuted] = useState(audioManager.getSettings().muted);
  const [bgmVol, setBgmVol] = useState(audioManager.getSettings().bgmVolume);

  const toggleMute = () => {
    const m = !muted;
    setMuted(m);
    audioManager.setMuted(m);
    if (!m) audioManager.resumeMenuBgmAfterUnmute();
  };

  const changeBgmVol = (v: number) => {
    setBgmVol(v);
    audioManager.setBgmVolume(v);
  };

  return (
    <header className="app-topbar shrink-0 bg-gray-900/95 backdrop-blur-sm z-30">
      <div className="topbar-row h-11 flex items-center gap-2 px-3 pt-1.5">
        {/* 返回主菜单与导航标签保持相同高度和文字基线。 */}
        <button
          onClick={() => setCurrentView("home")}
          className="topbar-home flex shrink-0 self-end h-9 items-center gap-1.5 px-2.5 rounded-lg text-xs whitespace-nowrap text-gray-400 hover:text-amber-300 hover:bg-amber-500/10 transition-colors"
          title="返回主菜单"
        >
          <AppIcon name="back" size={15} />
          <span>主菜单</span>
        </button>

        <div className="w-px h-5 shrink-0 bg-gray-700/70 mx-1" />

        {/* 管理页导航：Chrome 标签页式 —— 激活标签与下方内容连通，非激活标签退后 */}
        <nav aria-label="管理页面" className="topbar-nav flex flex-1 min-w-0 items-end gap-1 self-stretch">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              onClick={() => setCurrentView(item.id)}
              aria-current={currentView === item.id ? "page" : undefined}
              className={
                "topbar-tab flex items-center justify-center gap-1.5 h-9 text-xs whitespace-nowrap transition-colors " +
                (currentView === item.id
                  ? "topbar-tab-active bg-gray-800 text-amber-300 font-medium"
                  : "text-gray-400 hover:text-gray-200 hover:bg-gray-700/40")
              }
            >
              <AppIcon name={item.icon} size={15} />
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </nav>

        {/* 音频：静音（暂停/继续）+ BGM 音量 */}
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={toggleMute}
            className="px-2 py-1.5 rounded-lg text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-700/50 transition-colors"
            title={muted ? "取消静音（继续播放）" : "静音（暂停，再次点击继续）"}
          >
            <AppIcon name={muted ? "volumeOff" : "volume"} size={16} />
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={bgmVol}
            onChange={(e) => changeBgmVol(parseFloat(e.target.value))}
            className="hidden md:block w-20 h-1.5 accent-amber-500 cursor-pointer"
            title={"BGM 音量 " + Math.round(bgmVol * 100) + "%"}
          />
        </div>
      </div>
      {/* 与激活标签共用皮肤底色，形成连续的 Chrome 式底部衔接带。 */}
      <div aria-hidden="true" className="topbar-connector bg-gray-800 border-b border-gray-700/70" />
    </header>
  );
}
