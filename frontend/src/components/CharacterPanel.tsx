import { useState, useEffect, useCallback, useRef } from "react";
import { useAppStore } from "../stores/appStore";
import { useApi } from "../hooks/useApi";
import AppIcon from "./AppIcon";
import AvatarPlaceholder from "./chat/AvatarPlaceholder";
import CharacterDetailCard from "./CharacterDetailCard";

interface CharacterInfo {
  id: string;
  name: string;
  title: string;
  loaded: boolean;
  active: boolean;
  isPlayer: boolean;
}

export default function CharacterPanel({ refreshKey }: { refreshKey?: number }) {
  const { activeSessionId, sessions, statsRefreshKey, triggerCharacterRefresh } = useAppStore();
  const highlightedSpeaker = useAppStore((s) => s.highlightedSpeaker);
  const api = useApi();
  const [characters, setCharacters] = useState<CharacterInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [departed, setDeparted] = useState<string[]>([]);
  const [rosterSession, setRosterSession] = useState<string | null>(null);
  const [statsError, setStatsError] = useState("");
  const [error, setError] = useState("");
  const rosterRequest = useRef(0);

  // Hover/pin preview
  const [hoveredChar, setHoveredChar] = useState<string | null>(null);
  const [hoverAnchor, setHoverAnchor] = useState<DOMRect | null>(null);
  const [pinnedChar, setPinnedChar] = useState<string | null>(null);
  const [pinnedAnchor, setPinnedAnchor] = useState<DOMRect | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (closeTimerRef.current) clearTimeout(closeTimerRef.current); }, []);

  const previewChar = hoveredChar || pinnedChar;
  const previewAnchor = hoveredChar ? hoverAnchor : pinnedAnchor;

  const clearCloseTimer = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const handleMouseEnter = (charId: string, el: HTMLElement) => {
    clearCloseTimer();
    setHoveredChar(charId);
    setHoverAnchor(el.getBoundingClientRect());
  };

  const handleMouseLeave = () => {
    // Delay close to give user time to reach the popup or pin button
    closeTimerRef.current = setTimeout(() => {
      setHoveredChar(null);
      setHoverAnchor(null);
    }, 250);
  };

  const handlePopupEnter = () => {
    clearCloseTimer();
  };

  const handlePopupLeave = () => {
    if (!pinnedChar) {
      setHoveredChar(null);
      setHoverAnchor(null);
    }
  };

  const handleTogglePin = () => {
    if (pinnedChar) {
      setPinnedChar(null);
      setPinnedAnchor(null);
    } else if (hoveredChar) {
      setPinnedChar(hoveredChar);
      setPinnedAnchor(hoverAnchor);
    }
  };

  const handlePinFromList = (charId: string, el: HTMLElement) => {
    clearCloseTimer();
    const rect = el.getBoundingClientRect();
    if (pinnedChar === charId) {
      setPinnedChar(null);
      setPinnedAnchor(null);
    } else {
      setPinnedChar(charId);
      setPinnedAnchor(rect);
      setHoveredChar(charId);
      setHoverAnchor(rect);
    }
  };

  const handleClosePreview = () => {
    clearCloseTimer();
    setHoveredChar(null);
    setHoverAnchor(null);
    setPinnedChar(null);
    setPinnedAnchor(null);
  };

  const loadCharacters = useCallback(async () => {
    const requestId = ++rosterRequest.current;
    if (!activeSessionId) {
      setCharacters([]);
      return;
    }
    setLoading(true);
    setRosterSession(null);
    setError("");
    try {
      const data = await api.getSceneCharacters(activeSessionId);
      if (requestId !== rosterRequest.current || useAppStore.getState().activeSessionId !== activeSessionId) return;
      const rawList: string[] = data.roster || data.characters || data;
      const player = sessions.find((session) => session.id === activeSessionId)?.player_identity || data.roster?.[0] || "";
      const list: CharacterInfo[] = [...new Set(rawList)].map((name) => ({
        id: name,
        name,
        title: "",
        loaded: true,
        active: data.active === name && name !== player,
        isPlayer: name === player,
      }));
      setCharacters(list);
      setRosterSession(activeSessionId);
    } catch (err: any) {
      if (requestId === rosterRequest.current) setError(err.message);
    } finally {
      if (requestId === rosterRequest.current) setLoading(false);
    }
  }, [activeSessionId, api, sessions]);

  useEffect(() => {
    setCharacters([]);
    loadCharacters();
    // Clear preview state on session switch
    setHoveredChar(null);
    setHoverAnchor(null);
    setPinnedChar(null);
    setPinnedAnchor(null);
    return () => { rosterRequest.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, refreshKey]);

  useEffect(() => {
    if (!activeSessionId || rosterSession !== activeSessionId || loading) { setDeparted([]); return; }
    let cancelled = false;
    setStatsError("");
    api.getSessionCharacterStats(activeSessionId).then((data) => {
      if (!cancelled) {
        const present = new Set(characters.map((character) => character.name));
        setDeparted(data.characters.filter((row) => !present.has(row.name) && Object.keys(row.session_values).length > 0).map((row) => row.name));
      }
    }).catch((err: Error) => { if (!cancelled) setStatsError(err.message || "加载失败"); });
    return () => { cancelled = true; };
  }, [activeSessionId, rosterSession, loading, characters, statsRefreshKey, api]);

  const handleSwitch = async (name: string) => {
    if (!activeSessionId || characters.some((c) => c.name === name && c.isPlayer)) return;
    try {
      await api.switchCharacter(activeSessionId, name);
      await loadCharacters();
      triggerCharacterRefresh();
    } catch (err: any) {
      alert("切换角色失败: " + err.message);
    }
  };

  if (!activeSessionId) {
    return (
      <div className="card">
        <h2 className="panel-title">场景角色</h2>
        <p className="text-gray-500 text-sm text-center py-4">
          请先选择或创建会话
        </p>
      </div>
    );
  }

  const loadedCount = characters.filter((c) => c.loaded).length;

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <h2 className="panel-title mb-0">
          场景角色
          {loadedCount > 0 && (
            <span className="ml-1.5 text-xs text-gray-500 font-normal">
              ({loadedCount})
            </span>
          )}
        </h2>
        <div className="flex gap-1">
          <button
            onClick={loadCharacters}
            className="text-xs text-gray-500 hover:text-gray-300"
            disabled={loading}
          >
            {loading ? "..." : "刷新"}
          </button>
        </div>
      </div>

      {loading && characters.length === 0 && <p role="status" className="text-gray-400 text-sm py-4">正在加载角色…</p>}
      {error && (
        <p className="text-red-400 text-xs mb-2">加载失败: {error}</p>
      )}

      <div className="space-y-1.5">
        {!loading && characters.length === 0 && (
          <p className="text-gray-500 text-sm text-center py-4">
            场景尚未加载角色
            <br />
            <span className="text-xs text-gray-600">角色阵容请在大厅或创建会话时配置</span>
          </p>
        )}
        {characters.map((c) => (
          <div
            key={c.id}
            onMouseEnter={(e) => handleMouseEnter(c.name, e.currentTarget)}
            onMouseLeave={handleMouseLeave}
            className={`scene-char-row flex items-center justify-between px-3 py-2 rounded-lg text-sm cursor-default ${
              highlightedSpeaker === c.name ? "is-highlighted " : ""
            }${
              c.active
                ? "bg-amber-600/20 border border-amber-600/30"
                : c.loaded
                  ? "bg-gray-700/50"
                  : "bg-gray-800/50"
            }`}
          >
            <AvatarPlaceholder name={c.name} sessionId={activeSessionId} />
            <div className="min-w-0 flex-1 ml-2">
              <span className="font-medium truncate block">{c.name}</span>
              {c.isPlayer && <span className="text-xs text-amber-400">主控</span>}
              {c.title && (
                <span className="text-xs text-gray-500">{c.title}</span>
              )}
              {c.active && (
                <span className="text-xs text-amber-400 ml-2">[对话中]</span>
              )}
            </div>
            <div className="flex gap-1 shrink-0 ml-2">
              {/* Pin button on list item */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handlePinFromList(c.name, e.currentTarget.parentElement!);
                }}
                className={`text-xs px-1 rounded transition-colors ${
                  pinnedChar === c.name
                    ? "bg-amber-600/30 text-amber-300"
                    : "text-gray-600 hover:text-gray-300"
                }`}
                title={pinnedChar === c.name ? "取消固定" : "固定查看详情"}
              >
                <AppIcon name="identity" size={15} />
              </button>
              {!c.active && !c.isPlayer && (
                <button
                  onClick={() => handleSwitch(c.name)}
                  className="text-xs px-2 py-1 rounded bg-blue-600/30 text-blue-300 hover:bg-blue-600/50"
                >
                  对话
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {statsError && <p role="alert" className="text-xs text-red-400 mt-3">离场角色数值加载失败：{statsError}，可刷新重试。</p>}
      {departed.length > 0 && !loading && <section className="mt-5 pt-3 border-t border-gray-700" aria-label="离场角色数值">
        <h3 className="text-xs font-medium text-gray-300 mb-1">离场角色数值</h3>
        <p className="text-xs text-gray-400 mb-2">这些角色已离场，保留的会话数值仍可查看与清除。</p>
        {departed.map((name) => <button key={name} type="button" className="flex items-center justify-between w-full px-2 py-2 text-sm text-gray-300 hover:bg-gray-700/50 rounded-lg"
          onClick={(event) => handlePinFromList(name, event.currentTarget)}>
          <span className="truncate">{name}</span><AppIcon name="identity" size={15} />
        </button>)}
      </section>}

      {/* Character detail popup */}
      {previewChar && previewAnchor && (
        <CharacterDetailCard
          characterId={previewChar}
          anchorRect={previewAnchor}
          pinned={!!pinnedChar}
          onTogglePin={handleTogglePin}
          onClose={handleClosePreview}
          onMouseEnter={handlePopupEnter}
          onMouseLeave={handlePopupLeave}
        />
      )}
    </div>
  );
}
