/**
 * 剧情进度面板 — 当前位置与作者节拍骨架。
 *
 * - 状态显示：玩家当前处于剧情树（LLM 生成的节点结构）中的什么位置；
 * - 节点详情与回档在会话节点图中操作。
 *
 * 仅在剧情模式且有剧情绑定时显示。
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useAppStore } from "../stores/appStore";
import { useApi } from "../hooks/useApi";
import type { StoryStateDTO, StoryBeatNode } from "../types";
import AppIcon from "./AppIcon";

const NODE_STYLE: Record<StoryBeatNode["state"], { dot: string; text: string }> = {
  done: { dot: "bg-emerald-500", text: "text-gray-400" },
  current: { dot: "bg-amber-400 animate-pulse", text: "text-amber-200 font-medium" },
  locked: { dot: "bg-gray-600/70", text: "text-gray-600" },
};

export default function StoryStatePanel() {
  const { activeSessionId, chatMode, chatRefreshKey, envRefreshKey, sceneSwitchKey, chatLayout, setChatLayout, sessions } = useAppStore();
  const busy = useAppStore(s => !!s.sessionStreaming[activeSessionId || ""] || !!s.sessionSending[activeSessionId || ""] || !!s.sessionRollback[activeSessionId || ""]);
  const requestId = useRef(0);
  const narrationCount = useAppStore(
    (s) => s.sessionNarrationCount[activeSessionId || ""] ?? 0
  );
  const api = useApi();

  const [state, setState] = useState<StoryStateDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRoadmap, setShowRoadmap] = useState(true);
  const [showStates, setShowStates] = useState(false);

  const load = useCallback(async () => {
    const request = ++requestId.current;
    if (!activeSessionId || chatMode !== "story") {
      setState(null);
      return;
    }
    if (busy) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getStoryState(activeSessionId);
      if (request === requestId.current) setState(result);
    } catch (e: any) {
      if (request === requestId.current) setError(e.message || "加载失败");
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, [activeSessionId, chatMode, api, busy]);

  useEffect(() => { setState(null); setError(null); }, [activeSessionId]);

  useEffect(() => {
    load();
    return () => { requestId.current++; };
  }, [load, narrationCount, chatRefreshKey, envRefreshKey, sceneSwitchKey]);

  if (chatMode !== "story") return null;
  const header = (
    <div className="session-story-panel-heading">
      <h3 className="panel-title">剧情进度</h3>
      <div className="session-story-panel-tools">
      {sessions.find(s => s.id === activeSessionId)?.mode === "story" && (
        <button type="button" aria-label={chatLayout === "graph" ? "切换回舞台" : "切换实时节点图"}
          aria-pressed={chatLayout === "graph"} onClick={() => setChatLayout(chatLayout === "graph" ? "stage" : "graph")}>
          <AppIcon name={chatLayout === "graph" ? "back" : "workflow"} size={14} />{chatLayout === "graph" ? "回到舞台" : "节点图"}
        </button>
      )}
        <button type="button" className="session-story-refresh" aria-label="刷新剧情进度" title="刷新剧情进度"
          disabled={busy || loading} onClick={load}><AppIcon name="refresh" size={14} className={loading ? "animate-spin" : ""} /></button>
      </div>
    </div>
  );

  if (loading && !state) {
    return (
      <div className="space-y-2">
        {header}
        <div className="text-xs text-gray-500 text-center py-3">加载中...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-2">
        {header}
        <div className="text-xs text-red-400 bg-red-500/10 rounded px-2 py-1">{error}</div>
        <button type="button" onClick={load} disabled={busy || loading}>重试加载剧情进度</button>
      </div>
    );
  }

  if (!state?.has_plot) {
    return (
      <div className="space-y-2">
        {header}
        <div className="text-xs text-gray-500 text-center py-3">当前会话未绑定剧情节点结构</div>
      </div>
    );
  }

  const chapter = state.chapter;
  const beat = state.beat;
  const roads = state.roads || [];
  const currentChapterIdx = chapter?.idx ?? 0;
  // 当前章节内的节拍进度
  const curBeats = roads[currentChapterIdx]?.beats || [];
  const doneInChapter = curBeats.filter((b) => b.state === "done").length;
  const chapterProgress = curBeats.length ? (doneInChapter / curBeats.length) * 100 : 0;

  const treeCurrent = state.tree?.current_node || null;
  const charStates = state.character_states || {};
  const charNames = Object.keys(charStates).filter(
    (n) => (charStates[n]?.conditions || []).length > 0
  );

  return (
    <div className="space-y-3">
      {header}

      {/* ── 当前位置 ── */}
      <div className="rounded-lg border border-amber-600/30 bg-amber-500/5 px-3 py-2 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-600/30 text-amber-300 shrink-0">
            第 {currentChapterIdx + 1} 章
          </span>
          <span className="text-xs text-gray-300 truncate">{chapter?.title || "—"}</span>
          <span className="ml-auto text-[11px] text-gray-500 shrink-0">
            {chapter ? `${currentChapterIdx + 1}/${chapter.total}` : ""}
          </span>
        </div>
        <div className="text-[12px] text-amber-200/90">
          {treeCurrent ? (
            <>
              当前节点：{treeCurrent.title || treeCurrent.id}
              <span className="text-gray-500">
                {" "}（深度 {treeCurrent.depth}
                {treeCurrent.round_start != null
                  ? ` · 第 ${treeCurrent.round_start}–${treeCurrent.round_end} 轮`
                  : ""}）
              </span>
            </>
          ) : (
            <>当前节点：{beat ? `${beat.idx + 1}/${beat.total} · ${beat.summary || beat.id}` : "—"}</>
          )}
        </div>
        {/* 章节内进度条 */}
        <div className="h-1 rounded-full bg-gray-700/50 overflow-hidden">
          <div
            className="h-full bg-amber-500/70 transition-all"
            style={{ width: `${chapterProgress}%` }}
          />
        </div>
        {!treeCurrent && beat && beat.narrations_on_beat > 0 && (
          <div className="text-[11px] text-gray-500">
            本节点已进行 {beat.narrations_on_beat} 轮叙述
          </div>
        )}
      </div>

      {/* ── 作者节拍骨架（路线图，作为剧情树之外的参考） ── */}
      {roads.length > 0 && (
        <button
          onClick={() => setShowRoadmap((v) => !v)}
          aria-expanded={showRoadmap}
          className="w-full flex items-center justify-between text-[11px] text-gray-500 hover:text-gray-300 transition-colors px-1"
        >
          <span>作者节拍骨架</span>
          <AppIcon name={showRoadmap ? "expand" : "forward"} size={12} />
        </button>
      )}
      {showRoadmap && (
        <div className="space-y-2 border-t border-gray-700/40 pt-2">
          {roads.map((r) => {
            const isCurrent = r.state === "current";
            const isLocked = r.state === "locked";
            return (
              <div key={r.chapter_idx} className="space-y-1">
                <div className="flex items-center gap-1.5 px-1">
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      r.state === "done"
                        ? "bg-emerald-500"
                        : isCurrent
                        ? "bg-amber-400"
                        : "bg-gray-600/70"
                    }`}
                  />
                  <span
                    className={`text-[12px] truncate ${
                      isCurrent ? "text-amber-200" : isLocked ? "text-gray-600" : "text-gray-400"
                    }`}
                  >
                    第 {r.chapter_idx + 1} 章 · {r.title}
                  </span>
                </div>
                {!isLocked && (
                  <div className="pl-4 space-y-0.5">
                    {r.beats.map((b) => {
                      const st = NODE_STYLE[b.state] || NODE_STYLE.locked;
                      return (
                        <div key={b.id} className="flex items-start gap-1.5">
                          <span className={`w-1 h-1 rounded-full mt-1.5 shrink-0 ${st.dot}`} />
                          <span className={`text-[11px] leading-tight ${st.text}`}>
                            {b.summary || b.id}
                            {b.has_combat && <AppIcon name="combat" size={12} className="ml-1 text-red-400/80" />}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── 角色状态记录 ── */}
      {charNames.length > 0 && (
        <div className="space-y-1 border-t border-gray-700/40 pt-2">
          <button
            onClick={() => setShowStates((v) => !v)}
            aria-expanded={showStates}
            className="w-full flex items-center justify-between text-[11px] text-gray-500 hover:text-gray-300 transition-colors px-1"
          >
            <span>角色状态（{charNames.length}）</span>
            <AppIcon name={showStates ? "expand" : "forward"} size={12} />
          </button>
          {showStates &&
            charNames.map((name) => (
              <div key={name} className="text-[11px] text-gray-400 px-1">
                <span className="text-gray-300">{name}</span>
                <span className="text-gray-500">
                  ：{(charStates[name].conditions || []).map((c: any) => c.name).join("、")}
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
