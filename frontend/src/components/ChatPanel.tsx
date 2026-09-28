import { useState, useRef, useEffect, useCallback } from "react";
import { useAppStore } from "../stores/appStore";
import { confirmAction } from "../stores/confirmStore";
import { useApi, createSSE } from "../hooks/useApi";
import { useCombatResume } from "../hooks/useCombatResume";
import { useDialogMinimize } from "../hooks/useDialogMinimize";
import { parseDialogue, normalizeSegments } from "../utils/dialogueParser";
import type { ChatMessage, BranchChoice } from "../types";
import DialogueBubble from "./chat/DialogueBubble";
import NarrationText from "./chat/NarrationText";
import LoadingIndicator from "./chat/LoadingIndicator";
import TokenUsage from "./chat/TokenUsage";
import StageView from "./stage/StageView";
import SessionStoryGraph from "./story/SessionStoryGraph";
import StoryChoices, { latestStoryBranches, resolveChoiceBranch } from "./story/StoryChoices";
import { isChoiceMessage } from "../utils/stageScript";
import AppIcon from "./AppIcon";

const EMPTY_MSGS: ChatMessage[] = [];

/** 消息气泡的外观类（chat.css）：按角色 / 是否气泡模式 / 是否选项消息 */
export function bubbleClass(msg: ChatMessage, bubbleMode: boolean): string {
  if (msg.role === "user") return "is-user";
  if (msg.role === "character") return bubbleMode ? "is-character is-plain" : "is-character";
  if (msg.role === "narrator") return bubbleMode ? "is-narrator is-plain" : "is-narrator";
  if (msg.role === "system" && (msg.choices || msg.branches?.length)) return "is-choices";
  if (msg.role === "system") return "is-system";
  return "is-other";
}

function filterSceneLog(log: string[], playerIdentity: string): string[] {
  return log.filter(
    (entry) =>
      !entry.includes(`${playerIdentity}加入了场景`) &&
      !entry.includes(`${playerIdentity}切换`)
  );
}

interface ChatPanelProps {
  stageOnly: boolean;
  onExitStageOnly: () => void;
  musicMuted: boolean;
  onToggleMusic: () => void;
}

export default function ChatPanel({ stageOnly, onExitStageOnly, musicMuted, onToggleMusic }: ChatPanelProps) {
  const { activeSessionId, chatMode, sessions, setSessions, triggerEnvRefresh, triggerMemoryRefresh, chatRefreshKey, characterRefreshKey, editBeforeSend, sceneSwitchKey, dialogueBubbleMode, setCurrentView, setCombatContext, pendingAutoNarrate, setPendingAutoNarrate, pendingBriefing, setPendingBriefing, chatFontSize, setChatFontSize, chatLayout } = useAppStore();
  const stageMode = chatLayout === "stage";
  const graphMode = chatLayout === "graph" && chatMode === "story" && sessions.find(s => s.id === activeSessionId)?.mode === "story";
  const visualMode = stageMode || graphMode;
  const [logOverlayOpen, setLogOverlayOpen] = useState(false);
  // 切回消息流 / 换会话时收起记录抽屉
  useEffect(() => { setLogOverlayOpen(false); }, [chatLayout, activeSessionId]);
  const activeMode = sessions.find((s) => s.id === activeSessionId)?.mode || "free";

  const sceneCharacters: string[] = (() => {
    const session = sessions.find((s) => s.id === activeSessionId);
    if (!session) return [];
    const chars = (session.characters || []).map((c: any) =>
      c
    );
    // 玩家身份也参与说话人推断，避免玩家台词被误判给场景角色
    const player = session.player_identity || "玩家";
    if (player && !chars.includes(player)) chars.push(player);
    return chars;
  })();

  const [characterColors, setCharacterColors] = useState<Record<string, string>>({});
  const [customPromptOpen, setCustomPromptOpen] = useState(false);
  const [customPromptDraft, setCustomPromptDraft] = useState("");
  const [customPromptSaving, setCustomPromptSaving] = useState(false);
  const customPromptInitSession = useRef<string | null>(null);

  const api = useApi();
  // 「继续战斗」：恢复被临时返回挂起的战斗（战斗态已落盘，需走 resume 重建引擎）
  const { resumeSession, busyKey } = useCombatResume();
  const resumeBusy = !!activeSessionId && busyKey === `session:${activeSessionId}`;

  // Fetch character colors from backend whenever session/scene changes
  useEffect(() => {
    if (!activeSessionId) {
      setCharacterColors({});
      return;
    }
    let cancelled = false;
    api.getSceneCharacters(activeSessionId).then((data: any) => {
      if (!cancelled && data.character_colors) {
        setCharacterColors(data.character_colors);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [activeSessionId, characterRefreshKey, chatRefreshKey, api]);

  // Sync custom prompt draft only when modal opens or active session changes.
  // 不依赖 sessions 轮询更新，避免用户输入过程中被外部刷新覆盖。
  useEffect(() => {
    if (!customPromptOpen) {
      customPromptInitSession.current = null;
      return;
    }
    if (customPromptInitSession.current === activeSessionId) return;
    const session = sessions.find(s => s.id === activeSessionId);
    setCustomPromptDraft(session?.custom_prompt || "");
    customPromptInitSession.current = activeSessionId ?? null;
  }, [customPromptOpen, activeSessionId, sessions]);

  const messages = useAppStore(s => s.sessionMessages[activeSessionId || ""] ?? EMPTY_MSGS);
  const streaming = useAppStore(s => s.sessionStreaming[activeSessionId || ""] ?? false);
  const sending = useAppStore(s => s.sessionSending[activeSessionId || ""] ?? false);
  const narrationCount = useAppStore(s => s.sessionNarrationCount[activeSessionId || ""] ?? 0);
  const [input, setInput] = useState("");
  const [draftBranch, setDraftBranch] = useState<BranchChoice | undefined>();
  const [choiceError, setChoiceError] = useState("");
  const knownBranches = latestStoryBranches(messages);
  useEffect(() => { setDraftBranch(undefined); setChoiceError(""); }, [activeSessionId]);
  const [stagePlayback, setStagePlayback] = useState<{ sessionId: string; messages: ChatMessage[]; complete: boolean } | null>(null);
  const onPlaybackChange = useCallback((sessionId: string, source: ChatMessage[], complete: boolean) => {
    setStagePlayback({ sessionId, messages: source, complete });
  }, []);
  const stageDialogueComplete = stagePlayback?.sessionId === activeSessionId
    && stagePlayback?.messages === messages && stagePlayback.complete;
  // When the current stage segment is finished, choices and free input are both available.
  const stageInputReady = !stageMode || !!stageDialogueComplete;
  // 战前简报：d20 检定结果 + 谈判失败后暂存的战斗状态
  const [briefingCheck, setBriefingCheck] = useState<{ d20: number; modifier: number; total: number; dc: number; success: boolean; attr: string; character: string } | null>(null);
  const [briefingCombatState, setBriefingCombatState] = useState<any | null>(null);
  const [initialLoading, setInitialLoading] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [regeneratingRound, setRegeneratingRound] = useState<number | null>(null);
  const [regenerationPrompt, setRegenerationPrompt] = useState("");

  // 对话框最小化：关闭与最小化是两个独立操作，最小化保留对话框内部状态
  const customPromptDialog = useDialogMinimize("chat-custom-prompt", "自定义提示词", customPromptOpen);
  const briefingDialog = useDialogMinimize(
    "combat-briefing",
    pendingBriefing ? `战斗选项 · ${pendingBriefing.name}（必选）` : "战斗选项（必选）",
    !!pendingBriefing,
  );

  // 战斗选项是必选流程节点：未完成选择前禁止输入与推进剧情。
  // 展开态由全屏遮罩天然拦截，最小化态由本标记拦截（输入框/发送/内联选项/手动开战）。
  const choiceLocked = !!pendingBriefing;
  const bottomRef = useRef<HTMLDivElement>(null);
  const waitStartRef = useRef<number>(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  // Wait time counter: tick every second while sending or streaming
  useEffect(() => {
    if (sending || streaming) {
      if (!waitStartRef.current) waitStartRef.current = Date.now();
      setElapsedSeconds(0);
      const timer = setInterval(() => {
        setElapsedSeconds(
          Math.round((Date.now() - waitStartRef.current) / 1000)
        );
      }, 250);
      return () => clearInterval(timer);
    } else {
      waitStartRef.current = 0;
      setElapsedSeconds(0);
    }
  }, [sending, streaming]);

  // ── Session load / restore ──

  useEffect(() => {
    setEditingIdx(null);

    if (!activeSessionId) return;
    const sid: string = activeSessionId;
    const store = useAppStore.getState();

    // If store already has messages for this session (from background SSE), skip loading
    const existing = store.sessionMessages[sid];
    if (existing && existing.length > 0) return;

    const key = `ark_chat_${activeMode}_${sid}`;
    let cancelled = false;

    async function init() {
      // 1. Try localStorage
      const cached = localStorage.getItem(key);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length > 0) {
            if (!cancelled) {
              useAppStore.getState().setSessionMessages(sid, parsed);
              setInitialLoading(false);
              // Restore narrationCount from max round
              const maxRound = Math.max(0, ...parsed
                .filter((m: ChatMessage) => m.round != null)
                .map((m: ChatMessage) => m.round!));
              useAppStore.getState().setSessionNarrationCount(sid, maxRound);
            }
            return;
          }
        } catch { /* corrupt */ }
      }

      // 2. Backend fallback
      setInitialLoading(true);
      try {
        const session = await api.getSession(sid);
        if (cancelled) return;
        useAppStore.getState().setSessionNarrationCount(sid, session.narration_count || 0);

        const initialMessages: ChatMessage[] = [];
        const log = filterSceneLog(session.scene_log || [], session.player_identity || "玩家");
        if (log.length > 0) {
          initialMessages.push({ role: "system", content: `【场景记录】\n${log.join("\n")}` });
        }
        if (session.environment) {
          const { location, weather, time } = session.environment;
          initialMessages.push({
            role: "system",
            content: `【环境】${location || "未知地点"} · ${weather || "未知天气"} · ${time || "未知时间"}`,
          });
        }
        const chars = session.characters || [];
        if (chars.length > 0) {
          const charList = chars
            .map((c: string) => c)
            .join("、");
          initialMessages.push({ role: "system", content: `【已加载角色】${charList}` });
        }
        if (!cancelled) useAppStore.getState().setSessionMessages(sid, initialMessages);
      } catch {
        // Fresh session
      } finally {
        if (!cancelled) setInitialLoading(false);
      }

      // 3. Story mode auto-narrate
      if (chatMode === "story" && !cancelled) {
        triggerNarrate(sid);
      }
    }

    init();
    return () => { cancelled = true; };
  }, [activeSessionId, chatMode, api]);

  // ── Persist (subscribe to store, persists on every change including mid-stream) ──

  useEffect(() => {
    if (!activeSessionId) return;
    const sid = activeSessionId;
    const session = sessions.find(s => s.id === sid);
    if (!session) return;
    const key = `ark_chat_${session.mode}_${sid}`;

    let prevMsgs: ChatMessage[] | undefined;
    const unsub = useAppStore.subscribe((state) => {
      const msgs = state.sessionMessages[sid];
      if (msgs !== prevMsgs && msgs && msgs.length > 0) {
        prevMsgs = msgs;
        try { localStorage.setItem(key, JSON.stringify(msgs)); } catch {}
      }
    });
    return unsub;
  }, [activeSessionId, sessions]);

  // ── External rollback (from MemoryPanel) ──

  useEffect(() => {
    if (!activeSessionId || chatRefreshKey === 0) return;
    (async () => {
      try {
        const session = await api.getSession(activeSessionId);
        const targetRound = session.narration_count || 0;
        useAppStore.getState().setSessionNarrationCount(activeSessionId, targetRound);
        useAppStore.getState().setSessionMessages(activeSessionId, (prev) =>
          prev.filter((m) => !m.round || m.round <= targetRound)
        );
      } catch { /* ignore */ }
    })();
  }, [chatRefreshKey]);

  // ── Scene switch narration (story mode) ──

  useEffect(() => {
    if (!activeSessionId || chatMode !== "story" || sceneSwitchKey === 0) return;
    triggerNarrate(activeSessionId);
  }, [sceneSwitchKey]);

  // ── Rollback ──

  const handleRollback = useCallback(async (targetRound: number) => {
    if (!activeSessionId) return;
    if (!await confirmAction(`回退到第 ${targetRound} 轮？\n之后的对话记录和回忆将被删除。`, { title: "回退进度", confirmLabel: "回退到此轮" })) return;

    try {
      await api.rollbackSession(activeSessionId, targetRound);
      useAppStore.getState().setSessionMessages(activeSessionId, (prev) =>
        prev.filter((m) => !m.round || m.round <= targetRound)
      );
      useAppStore.getState().setSessionNarrationCount(activeSessionId, targetRound);
      triggerMemoryRefresh();
    } catch (err: any) {
      alert("回退失败: " + (err.message || "未知错误"));
    }
  }, [activeSessionId, api, triggerMemoryRefresh]);

  // ── Edit user message ──

  const startEdit = useCallback((idx: number, text: string) => {
    setEditingIdx(idx);
    setEditText(text);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingIdx(null);
    setEditText("");
  }, []);

  const commitEdit = useCallback(async () => {
    // 必选战斗选项未完成前禁止通过编辑消息回滚/推进剧情
    if (editingIdx == null || !activeSessionId || choiceLocked) return;
    const targetMsg = messages[editingIdx];
    const targetRound = targetMsg?.round;
    const edited = editText.trim();
    if (!edited) {
      cancelEdit();
      return;
    }

    const rollbackTo = targetRound ? targetRound - 1 : 0;
    try {
      if (rollbackTo >= 0) {
        await api.rollbackSession(activeSessionId, rollbackTo);
        useAppStore.getState().setSessionNarrationCount(activeSessionId, rollbackTo);
        triggerMemoryRefresh();
      }

      useAppStore.getState().setSessionMessages(activeSessionId, (prev) => {
        const keep = prev.slice(0, editingIdx);
        return [...keep, { role: "user", content: edited, round: rollbackTo + 1 }];
      });

      setEditingIdx(null);
      setEditText("");

      triggerNarrate(activeSessionId, edited);
    } catch (err: any) {
      alert("编辑失败: " + (err.message || "未知错误"));
      useAppStore.getState().setSessionStreaming(activeSessionId, false);
    }
  }, [editingIdx, editText, activeSessionId, messages, api, triggerMemoryRefresh, cancelEdit, choiceLocked]);

  // ── Send ──

  const performSend = useCallback(
    async (text: string, branchId?: string) => {
      if (!activeSessionId) return;
      const sid = activeSessionId;

      // Story mode: use SSE streaming for progressive token display
      if (chatMode === "story") {
        triggerNarrate(sid, text, branchId);
        return;
      }

      // Free mode: blocking POST (group chat)
      useAppStore.getState().setSessionStreaming(sid, true);
      try {
        const res = await api.groupChat(sid, text);
        const items: any[] = res.responses;
        const responses: ChatMessage[] = items.map((r: any) => ({
          role: "character",
          content: r.response,
          character: r.character,
          usage: r.usage,
        }));
        useAppStore.getState().setSessionMessages(sid, (prev) => {
          if (responses.length === 0) {
            return [...prev, { role: "system", content: "（没有角色回复 — 请先在右侧面板加载角色）" }];
          }
          return [...prev, ...responses];
        });
      } catch (err: any) {
        useAppStore.getState().setSessionMessages(sid, (prev) => [...prev, { role: "system", content: `请求失败: ${err.message}` }]);
      } finally {
        useAppStore.getState().setSessionSending(sid, false);
        useAppStore.getState().setSessionStreaming(sid, false);
      }
    },
    [activeSessionId, chatMode, api, triggerEnvRefresh, triggerMemoryRefresh]
  );

  // 战前简报：新简报到来时清空上一轮的检定/暂存状态
  useEffect(() => {
    if (pendingBriefing) {
      setBriefingCheck(null);
      setBriefingCombatState(null);
    }
  }, [pendingBriefing]);

  // 战前简报：选择打法
  const handleBriefingApproach = useCallback(async (approachId: string) => {
    if (!pendingBriefing || !activeSessionId) return;
    const b = pendingBriefing;
    try {
      const sideview = sessions.find((session) => session.id === b.session_id)?.combat_mode === "sideview";
      const resp = sideview
        ? await api.sideviewStart(b.session_id, b.encounter_id, approachId)
        : await api.combatStart(b.session_id, b.encounter_id, [], approachId);
      if (resp?.state) {
        if (resp.check) {
          // 谈判失败：先展示检定，玩家确认后进入战斗
          setBriefingCheck(resp.check);
          setBriefingCombatState(resp.state);
        } else {
          setCombatContext({ sessionId: b.session_id, state: sideview ? null : resp.state });
          setPendingBriefing(null);
          setCurrentView("combat");
        }
      } else if (resp?.kind === "check") {
        setBriefingCheck(resp.check ?? null);
      } else if (resp?.kind === "avoid") {
        setPendingBriefing(null);
        setPendingAutoNarrate({ action: `战斗已避免（${resp.label}），描述当前场景与去向` });
      }
    } catch (err: any) {
      alert("启动战斗失败: " + (err.message || "未知错误"));
    }
  }, [pendingBriefing, activeSessionId, sessions, api, setCombatContext, setPendingBriefing, setCurrentView, setPendingAutoNarrate]);

  // Auto-narrate after combat: watch for pendingAutoNarrate being set
  useEffect(() => {
    if (pendingAutoNarrate && activeSessionId) {
      const { action, settlement } = pendingAutoNarrate;
      setPendingAutoNarrate(null);
      if (settlement) {
        const winnerText = settlement.winner === "player" ? "玩家获胜" : settlement.winner === "enemy" ? "敌方获胜" : "战斗结束";
        const survivorsText = settlement.survivors.length > 0 ? `\n幸存：${settlement.survivors.join("、")}` : "";
        const settlementMsg: ChatMessage = {
          role: "system",
          content: `⚔ 战斗结束：遭遇战「${settlement.encounter_id}」— ${winnerText}，${settlement.engine === "sideview" ? `用时 ${Math.max(1, Math.ceil((settlement.durationMs || 0) / 1000))} 秒` : `共 ${settlement.rounds} 回合`}。${survivorsText}`,
        };
        useAppStore.getState().setSessionMessages(activeSessionId, prev => [...prev, settlementMsg]);
      }
      performSend(action);
    }
  }, [pendingAutoNarrate, activeSessionId, performSend, setPendingAutoNarrate]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || sending || streaming || !activeSessionId || choiceLocked || !stageInputReady) return;
    const branch = draftBranch?.label === text ? draftBranch : resolveChoiceBranch(text, knownBranches);
    if (branch?.available === false) {
      setChoiceError(branch.blocked_reasons?.join("；") || "当前条件未满足");
      return;
    }

    const sid = activeSessionId;
    const curRound = useAppStore.getState().sessionNarrationCount[sid] || 0;
    setInput("");
    setDraftBranch(undefined);
    setChoiceError("");
    useAppStore.getState().setSessionSending(sid, true);
    useAppStore.getState().setSessionMessages(sid, (prev) => [...prev, { role: "user", content: text, round: curRound }]);
    performSend(text, branch?.id);
  }, [input, sending, streaming, activeSessionId, performSend, choiceLocked, stageInputReady, draftBranch, knownBranches]);

  const handleChoiceClick = useCallback(
    (choice: string, branch?: BranchChoice) => {
      // 必选战斗选项未完成前，内联选项同样不允许推进剧情
      if (choiceLocked || sending || streaming || (stageMode && !stageDialogueComplete)) return;
      const selectedBranch = branch ?? resolveChoiceBranch(choice, knownBranches);
      if (selectedBranch?.available === false) {
        setChoiceError(selectedBranch.blocked_reasons?.join("；") || "当前条件未满足");
        return;
      }
      setChoiceError("");
      if (editBeforeSend) {
        setInput(choice);
        setDraftBranch(selectedBranch);
        return;
      }
      if (!activeSessionId) return;
      const sid = activeSessionId;
      const curRound = useAppStore.getState().sessionNarrationCount[sid] || 0;
      setInput("");
      setDraftBranch(undefined);
      useAppStore.getState().setSessionMessages(sid, (prev) => [...prev, { role: "user", content: choice, round: curRound }]);
      performSend(choice, selectedBranch?.id);
    },
    [activeSessionId, performSend, editBeforeSend, choiceLocked, sending, streaming, stageMode, stageDialogueComplete, knownBranches]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  // ── Variant switching & regeneration ──

  const syncVariantToBackend = useCallback((round: number | undefined, narrative: string) => {
    if (!activeSessionId || round == null) return;
    api.narrateUpdate(activeSessionId, round, narrative).catch(() => {});
  }, [activeSessionId, api]);

  const handleVariantPrev = useCallback((idx: number) => {
    if (!activeSessionId) return;
    const sid = activeSessionId;
    useAppStore.getState().setSessionMessages(sid, (prev) => {
      const msg = prev[idx];
      if (!msg.variants || (msg.variantIndex ?? 0) <= 0) return prev;
      const newIdx = (msg.variantIndex ?? 0) - 1;
      const narrative = msg.variants[newIdx];
      const updated = { ...msg, content: narrative, variantIndex: newIdx, dialogueSegments: undefined };
      syncVariantToBackend(msg.round, narrative);
      return [...prev.slice(0, idx), updated, ...prev.slice(idx + 1)];
    });
  }, [activeSessionId, syncVariantToBackend]);

  const handleVariantNext = useCallback((idx: number) => {
    if (!activeSessionId) return;
    const sid = activeSessionId;
    useAppStore.getState().setSessionMessages(sid, (prev) => {
      const msg = prev[idx];
      if (!msg.variants) return prev;
      const curIdx = msg.variantIndex ?? 0;
      if (curIdx < msg.variants.length - 1) {
        const newIdx = curIdx + 1;
        const narrative = msg.variants[newIdx];
        const updated = { ...msg, content: narrative, variantIndex: newIdx, dialogueSegments: undefined };
        syncVariantToBackend(msg.round, narrative);
        return [...prev.slice(0, idx), updated, ...prev.slice(idx + 1)];
      }
      return prev;
    });
  }, [activeSessionId, syncVariantToBackend]);

  const handleRegeneratePrompt = useCallback((round: number) => {
    setRegeneratingRound(round);
    setRegenerationPrompt("");
  }, []);

  const handleRegenerateCancel = useCallback(() => {
    setRegeneratingRound(null);
    setRegenerationPrompt("");
  }, []);

  const handleRegenerateSubmit = useCallback(async () => {
    if (!activeSessionId || regeneratingRound == null || choiceLocked) return;
    const sid = activeSessionId;
    const round = regeneratingRound;
    const prompt = regenerationPrompt.trim();
    setRegenerationPrompt("");
    setRegeneratingRound(null);
    useAppStore.getState().setSessionStreaming(sid, true);
    try {
      const data = await api.narrateVariant(sid, prompt);
      const newNarrative: string = data.narrative;
      useAppStore.getState().setSessionMessages(sid, (prev) => {
        const idx = prev.findIndex(
          (m) => m.role === "narrator" && m.round === round
        );
        if (idx === -1) return prev;
        const msg = prev[idx];
        const variants = msg.variants || [msg.content];
        const newIdx = variants.length;
        const updated: ChatMessage = {
          ...msg,
          content: newNarrative,
          variants: [...variants, newNarrative],
          variantIndex: newIdx,
          dialogueSegments: data.dialogue_segments || msg.dialogueSegments,
          usage: data.usage || msg.usage,
        };
        api.narrateUpdate(sid, round, newNarrative).catch(() => {});
        return [...prev.slice(0, idx), updated, ...prev.slice(idx + 1)];
      });
    } catch (err: any) {
      alert("重新生成失败: " + (err.message || "未知错误"));
    } finally {
      useAppStore.getState().setSessionStreaming(sid, false);
    }
  }, [activeSessionId, regeneratingRound, regenerationPrompt, api, choiceLocked]);

  // ── Single message deletion ──

  const handleDeleteMessage = useCallback(async (idx: number) => {
    if (!activeSessionId) return;
    const sid = activeSessionId;
    const target = useAppStore.getState().sessionMessages[sid]?.[idx];
    if (!target) return;
    if (!await confirmAction("确定从当前消息列表删除这条消息？此操作不可撤销。", { title: "删除消息", confirmLabel: "删除消息" })) return;
    useAppStore.getState().setSessionMessages(sid, (prev) => {
      // The list may refresh while awaiting confirmation; never delete a different message by index.
      const targetIndex = prev.indexOf(target);
      if (targetIndex < 0) return prev;
      return [...prev.slice(0, targetIndex), ...prev.slice(targetIndex + 1)];
    });
  }, [activeSessionId]);

  // ── Derive round groups for rollback dividers ──

  const roundBoundaries: number[] = [];
  let lastRound: number | undefined;
  messages.forEach((m, i) => {
    if (m.round != null && m.round !== lastRound) {
      if (lastRound != null) roundBoundaries.push(i);
      lastRound = m.round;
    }
  });

  const showEmptyState = messages.length === 0 && !initialLoading;

  const isWaitingForLLM =
    (sending || streaming) &&
    !(streaming && messages.length > 0 && messages[messages.length - 1].role === "narrator");

  // ── Render ──

  function renderMessageContent(msg: ChatMessage): React.ReactNode {
    if (!dialogueBubbleMode) {
      return <div className="whitespace-pre-wrap">{msg.content}</div>;
    }

    const applyBubbles = msg.role === "character" || msg.role === "narrator";
    if (!applyBubbles || !msg.content) {
      return <div className="whitespace-pre-wrap">{msg.content || ""}</div>;
    }

    // 流式生成中的叙述先以纯文本展示，完成后（onDone）再统一解析为气泡，
    // 避免半句引号/说话人未闭合时渲染出错误或不完整的气泡。
    if (msg.streaming) {
      return <div className="whitespace-pre-wrap">{msg.content}</div>;
    }

    // Prefer backend-provided segments, fall back to frontend parser
    let segments = msg.dialogueSegments;
    if (!segments || segments.length === 0) {
      segments = parseDialogue(msg.content, msg.character, sceneCharacters);
    }
    // 仅相邻且缺失 speaker 的台词可继承；显式未知与旁白切断归属链。
    segments = normalizeSegments(segments);
    const hasDialogue = segments.some((s) => s.type === "dialogue");
    if (!hasDialogue) {
      return <div className="whitespace-pre-wrap">{msg.content}</div>;
    }

    return (
      <div>
        {segments.map((seg, si) => {
          if (seg.type === "narration") {
            return <NarrationText key={si} text={seg.text} />;
          }
          return (
            <DialogueBubble
              key={si}
              text={seg.text}
              speaker={seg.speaker}
              color={seg.speaker ? characterColors[seg.speaker] : undefined}
              sessionId={activeSessionId ?? undefined}
            />
          );
        })}
      </div>
    );
  }

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const lastMessage = messages[messages.length - 1];
  const requestError = lastMessage?.requestError ? lastMessage.content : "";
  const graphChoice = isChoiceMessage(lastMessage) ? lastMessage : null;
  const graphChoicesDisabled = sending || streaming || choiceLocked || !!activeSession?.in_combat
    || (graphChoice?.round != null && graphChoice.round < narrationCount);
  const sessionTokens = activeSession?.total_usage;
  const actionInput = stageInputReady && (!stageMode || (!sending && !streaming && !choiceLocked)) ? (
    <div className={`chat-input-bar ${stageOnly && stageMode ? "stage-action-input" : ""}`}>
        {choiceLocked && (
          <p className="chat-lock-note">
            ⚔ 待完成战斗选项：已暂停输入与剧情推进，请点击左下角「战斗选项（必选）」恢复并选择打法。
          </p>
        )}
        <div className="flex gap-2">
          <textarea
            rows={stageOnly && stageMode ? 1 : 2}
            aria-label="行动或对话"
            placeholder={
              choiceLocked
                ? "请先完成战斗选项..."
                : !activeSessionId
                  ? "请先选择或创建会话"
                  : activeSession?.in_combat
                    ? "战斗中，无法对话..."
                    : sending
                      ? "发送中..."
                      : chatMode === "story"
                        ? "输入行动或对话推进剧情..."
                        : "输入消息..."
            }
            value={activeSession?.in_combat ? "（战斗中 — 请先完成战斗）" : input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!activeSessionId || sending || streaming || !!activeSession?.in_combat || choiceLocked}
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!input.trim() || !activeSessionId || sending || streaming || !!activeSession?.in_combat || choiceLocked}
            className="chat-send shrink-0"
          >
            {choiceLocked ? "待选择" : activeSession?.in_combat ? "战斗中" : sending ? "发送中…" : "发送"}
          </button>
        </div>
      </div>
  ) : null;

  return (
    <div className="flex flex-col h-full">
      {(choiceError || requestError) && <p role="alert" className="shrink-0 px-4 py-3 text-sm leading-relaxed text-red-200 bg-gray-900 border-b border-red-400/40 break-words">
        {choiceError || requestError}
      </p>}
      {/* Header bar — 会话信息 + token 统计 */}
      {activeSession && (
        <div className="chat-head">
          <div className="flex items-center gap-2 min-w-0">
            <span className="chat-head-round">ROUND {Math.max(activeSession.narration_count ?? 0, narrationCount)}</span>
            {activeSession.in_combat && (
              <span className="text-[11px] text-orange-400 font-medium animate-pulse">⚔ 战斗中</span>
            )}
            {activeSession.in_combat && activeSession.combat_mode === "sideview" && (
              <button
                type="button"
                className="chat-head-tool is-on"
                onClick={() => { setCombatContext({ sessionId: activeSession.id!, state: null }); setCurrentView("combat"); }}
              >
                ▶ 返回关卡
              </button>
            )}
            {!activeSession.in_combat && activeSession.combat_resumable && (
              <button
                onClick={() => void resumeSession(activeSession.id!)}
                disabled={resumeBusy}
                className="chat-head-tool is-on"
                title="继续这场已挂起的战斗（角色状态 / 手牌 / 战场局势均已保存）"
              >
                {resumeBusy ? "恢复中…" : "▶ 继续战斗"}
              </button>
            )}
            {activeSession.combat_mode !== "narrative" && (
              <span className="text-[11px] text-orange-400/70 font-medium">{activeSession.combat_mode === "sideview" ? "✦ 横版动作" : "⚔ 战术"}</span>
            )}
            {activeSession.sideview_status && (
              <span className="text-[11px] text-cyan-200/80 font-medium" title={`上次横版行动：${activeSession.sideview_status.outcome}`}>
                {activeSession.sideview_status.operatorName} HP {activeSession.sideview_status.hp}/{activeSession.sideview_status.maxHp}
              </span>
            )}
            {(chatMode === "story" || activeSession.combat_mode === "sideview") && activeSession.combat_mode !== "narrative" && !activeSession.in_combat && (
              <button
                onClick={async () => {
                  const encounterId = activeSession.combat_mode === "sideview"
                    ? "enc_quick_test_1"
                    : prompt("输入世界书中的战斗节点 ID（可在节点图查看）")?.trim();
                  if (!encounterId) return;
                  try {
                    let response: any;
                    if (activeSession.combat_mode === "sideview") {
                      response = await api.sideviewStart(activeSession.id!, encounterId);
                    } else {
                      response = await api.combatStart(activeSession.id!, encounterId, []);
                    }
                    if (response.kind === "approaches") {
                      setPendingBriefing({ session_id: activeSession.id!, encounter_id: encounterId,
                        name: encounterId, approaches: response.approaches });
                      return;
                    }
                    if (!response.state) return;
                    setCombatContext({ sessionId: activeSession.id! });
                    setCurrentView("combat");
                  } catch (err: any) {
                    alert("启动战斗失败: " + (err.message || "未知错误"));
                  }
                }}
                className="chat-head-tool"
                title={choiceLocked ? "请先完成战斗选项" : activeSession.combat_mode === "sideview" ? "进入横版动作关卡" : "手动触发战斗"}
                disabled={choiceLocked}
              >
                <AppIcon name="combat" size={15} />
              </button>
            )}
          </div>
          {/* 会话大厅入口只保留顶栏的「返回大厅」；会话资源并入左侧场景面板的「资源」页 */}
          <div className="flex items-center gap-2">
            <div className="chat-font-size">
              <button type="button" onClick={() => setChatFontSize(chatFontSize - 1)} className="chat-head-tool" title="减小字体">A−</button>
              <span>{chatFontSize}</span>
              <button type="button" onClick={() => setChatFontSize(chatFontSize + 1)} className="chat-head-tool" title="增大字体">A+</button>
            </div>
            <button
              type="button"
              onClick={() => setCustomPromptOpen(true)}
              className={`chat-head-tool ${activeSession.custom_prompt ? "is-on" : ""}`}
              title={activeSession.custom_prompt ? `自定义提示词: ${activeSession.custom_prompt}` : "自定义提示词"}
            >
              <AppIcon name="file" size={12} />
              <span>提示词</span>
            </button>
            {sessionTokens && sessionTokens.total_tokens > 0 && (
              <div className="chat-tokens" title={`输入 ${sessionTokens.prompt_tokens.toLocaleString()} + 输出 ${sessionTokens.completion_tokens.toLocaleString()}`}>
                {sessionTokens.total_tokens.toLocaleString()} <small>tokens</small>
              </div>
            )}
          </div>
        </div>
      )}
      {stageMode && activeSessionId && (
        <StageView
          key={activeSessionId}
          sessionId={activeSessionId}
          onPlaybackChange={onPlaybackChange}
          messages={messages}
          sceneCharacters={sceneCharacters}
          playerName={activeSession?.player_identity || "玩家"}
          characterColors={characterColors}
          fontSize={chatFontSize}
          waiting={sending || streaming}
          elapsedSeconds={elapsedSeconds}
          choicesDisabled={sending || streaming || choiceLocked || !!activeSession?.in_combat}
          onChoice={handleChoiceClick}
          onOpenLog={() => setLogOverlayOpen(true)}
          stageOnly={stageOnly}
          actionInput={stageOnly ? actionInput : undefined}
          onExitStageOnly={onExitStageOnly}
          musicMuted={musicMuted}
          onToggleMusic={onToggleMusic}
          onStart={() => triggerNarrate(activeSessionId)}
          chatMode={chatMode}
        />
      )}
      {graphMode && activeSessionId && (
        <>
          <SessionStoryGraph key={activeSessionId} sessionId={activeSessionId}
            onOpenLog={() => setLogOverlayOpen(true)} onExit={() => useAppStore.getState().setChatLayout("stage")} />
          {graphChoice && (
            <div className="session-graph-choices" role="group" aria-label="剧情分支选项" style={{ maxHeight: "min(38vh, 360px)", flexShrink: 0 }}>
              <span>选择一项，或在下方输入行动</span>
              <StoryChoices message={graphChoice} knownBranches={knownBranches} disabled={graphChoicesDisabled} onChoice={handleChoiceClick} />
            </div>
          )}
        </>
      )}
      {/* 消息流：舞台模式下变成覆盖在舞台上的「记录」抽屉（同一份 DOM，只换外观） */}
      <div
        className={visualMode
          ? (logOverlayOpen ? "stage-log-overlay space-y-3" : "hidden")
          : "chat-log flex-1 overflow-y-auto px-4 py-4 space-y-3"}
        style={{ fontSize: `${chatFontSize}px` }}
        onKeyDown={(e) => { if (e.key === "Escape") setLogOverlayOpen(false); }}
      >
        {visualMode && logOverlayOpen && (
          <div className="stage-log-head">
            <span>对话记录</span>
            <button type="button" onClick={() => setLogOverlayOpen(false)}><AppIcon name="close" size={12} />关闭</button>
          </div>
        )}
        {initialLoading && messages.length === 0 && (
          <div className="flex items-center justify-center h-full text-gray-500">
            <span className="text-sm">加载会话中...</span>
          </div>
        )}

        {showEmptyState && (
          <div className="flex flex-col items-center justify-center h-full text-gray-500">
            {chatMode === "story" ? (
              <>
                <p className="text-lg mb-1">📖 剧情模式</p>
                <p className="text-sm">创建一个剧情会话开始新的故事</p>
                <div className="mt-4 flex gap-2">
                  <button
                    onClick={() => {
                      if (!activeSessionId) return;
                      triggerNarrate(activeSessionId);
                    }}
                    className="btn-primary text-sm" disabled={!activeSessionId}
                  >
                    开始剧情
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-lg mb-1">💬 自由对话</p>
                <p className="text-sm">在右侧面板加载角色后即可开始对话</p>
                <p className="text-xs text-gray-600 mt-2">提示：点击角色卡片中的"加入"按钮</p>
              </>
            )}
          </div>
        )}

        {messages.map((msg, i) => {
          const isRoundStart = roundBoundaries.includes(i);
          const isEditing = editingIdx === i;
          const choicesDisabled =
            sending || streaming || choiceLocked || !!activeSession?.in_combat ||
            (msg.round != null && msg.round < narrationCount);

          return (
            <div key={i}>
              {/* Rollback divider between rounds */}
              {isRoundStart && chatMode === "story" && (
                <div className="chat-round-divider">
                  <button
                    type="button"
                    className="app-danger-button"
                    onClick={() => {
                      const prevMsgs = messages.slice(0, i);
                      const prevRound = [...prevMsgs].reverse().find((m) => m.round != null)?.round;
                      if (prevRound != null) handleRollback(prevRound);
                    }}
                    title="回退到上一轮"
                  >
                    ↩ 回退到此处
                  </button>
                </div>
              )}

              <div className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`chat-msg group ${bubbleClass(msg, dialogueBubbleMode)}`}>
                  {msg.character && !dialogueBubbleMode && (
                    <div className="chat-msg-name">{msg.character}</div>
                  )}
                  {msg.role === "user" && !dialogueBubbleMode && (
                    <div className="chat-msg-name">
                      {activeSession?.player_identity || "玩家"}
                    </div>
                  )}

                  {isEditing ? (
                    <div className="space-y-2">
                      <textarea
                        className="input text-sm w-full text-gray-100"
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={2}
                        autoFocus
                      />
                      <div className="flex gap-2">
                        <button onClick={commitEdit} disabled={choiceLocked} className="btn-primary text-xs px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed">保存并继续</button>
                        <button onClick={cancelEdit} className="btn-ghost text-xs px-2 py-1">取消</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {/* Reasoning/thinking display (collapsible) */}
                      {msg.reasoning && (
                        <details className="mb-2 text-xs">
                          <summary className="text-gray-500 cursor-pointer hover:text-gray-400 select-none">
                            思考过程 ({msg.reasoning.length} 字)
                          </summary>
                          <div className="mt-1 p-2 rounded bg-gray-800/60 text-gray-400 whitespace-pre-wrap border-l-2 border-gray-600 max-h-48 overflow-y-auto">
                            {msg.reasoning}
                          </div>
                        </details>
                      )}
                      {msg.content && renderMessageContent(msg)}

                      {/* Variant navigation (narrator messages in story mode) */}
                      {msg.role === "narrator" && chatMode === "story" && !streaming && msg.variants && (
                        <div className="flex items-center justify-end gap-1 mt-1.5">
                          <button
                            onClick={() => handleVariantPrev(i)}
                            disabled={choiceLocked || (msg.variantIndex ?? 0) <= 0}
                            className="text-xs px-1.5 py-0.5 rounded text-gray-500 hover:text-gray-300 disabled:opacity-30 transition-colors"
                            title="上一个版本"
                          >
                            ◂
                          </button>
                          <span className="text-[11px] text-gray-600">
                            {(msg.variantIndex ?? 0) + 1}/{msg.variants.length}
                          </span>
                          <button
                            onClick={() => {
                              if ((msg.variantIndex ?? 0) < msg.variants!.length - 1) {
                                handleVariantNext(i);
                              } else {
                                handleRegeneratePrompt(msg.round ?? 0);
                              }
                            }}
                            disabled={choiceLocked}
                            className="text-xs px-1.5 py-0.5 rounded text-gray-500 hover:text-gray-300 disabled:opacity-30 transition-colors"
                            title={(msg.variantIndex ?? 0) < msg.variants!.length - 1 ? "下一个版本" : "重新生成"}
                          >
                            ▸
                          </button>
                        </div>
                      )}

                      {/* Regeneration prompt input */}
                      {msg.role === "narrator" && regeneratingRound === msg.round && (
                        <div className="mt-2 space-y-1.5">
                          <textarea
                            className="input text-xs w-full text-gray-100"
                            placeholder="输入提示词或留空直接重新生成（如：让叙述更紧张一些）"
                            value={regenerationPrompt}
                            onChange={(e) => setRegenerationPrompt(e.target.value)}
                            rows={2}
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                                e.preventDefault();
                                handleRegenerateSubmit();
                              }
                              if (e.key === "Escape") handleRegenerateCancel();
                            }}
                          />
                          <div className="flex gap-1.5">
                            <button
                              onClick={handleRegenerateSubmit}
                              disabled={choiceLocked}
                              className="text-xs px-2 py-0.5 rounded bg-amber-700/30 text-amber-300 hover:bg-amber-700/50 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              重新生成
                            </button>
                            <button
                              onClick={handleRegenerateCancel}
                              className="text-xs px-2 py-0.5 rounded text-gray-500 hover:text-gray-300"
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      )}

                      {(msg.branches?.length || msg.choices) && (
                        <div className="flex flex-col gap-2 mt-1 min-w-0">
                          <StoryChoices message={msg} knownBranches={knownBranches} disabled={choicesDisabled} onChoice={handleChoiceClick} />
                        </div>
                      )}
                      {msg.role === "narrator" && streaming && i === messages.length - 1 && (
                        <span className="inline-block w-2 h-4 bg-amber-400/70 ml-1 animate-pulse" />
                      )}

                      {/* Delete button (all messages, hover reveal) */}
                      {!streaming && (
                        <button
                          onClick={() => handleDeleteMessage(i)}
                          disabled={choiceLocked}
                          className="app-danger-button absolute -top-2 -left-2 w-5 h-5 rounded-full bg-gray-600
                            text-gray-300 hover:bg-red-500 text-[11px] leading-5
                            opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity disabled:hidden inline-flex items-center justify-center"
                          title="删除此消息"
                          aria-label="删除此消息"
                        >
                          <AppIcon name="trash" size={11} />
                        </button>
                      )}

                      {/* Edit button on user messages (story mode only) */}
                      {msg.role === "user" && chatMode === "story" && !streaming && (
                        <button
                          onClick={() => startEdit(i, msg.content)}
                          disabled={choiceLocked}
                          className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-gray-600
                            text-gray-300 hover:bg-gray-500 text-[11px] leading-5
                            opacity-0 group-hover:opacity-100 transition-opacity disabled:hidden"
                          title="编辑此消息"
                        >
                          ✎
                        </button>
                      )}

                      {/* Round badge */}
                      {msg.usage && (msg.role === "narrator" || msg.role === "character") && (
                        <TokenUsage usage={msg.usage} />
                      )}
                      {msg.round != null && (
                        <div className="chat-msg-meta">第{msg.round}轮</div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {isWaitingForLLM && (
          <LoadingIndicator elapsedSeconds={elapsedSeconds} />
        )}
        <div ref={bottomRef} />
      </div>

      {!(stageOnly && stageMode && activeSessionId) && actionInput}

      {/* Custom Prompt Modal */}
      {customPromptOpen && (
        <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/60 ${customPromptDialog.minimizedClass}`}>
          <div
            ref={customPromptDialog.containerRef}
            tabIndex={-1}
            className="bg-gray-800 border border-gray-700 rounded-xl w-[520px] flex flex-col shadow-2xl outline-none"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
              <h2 className="text-base font-semibold">自定义提示词</h2>
              <div className="flex items-center gap-1">
                <button
                  onClick={customPromptDialog.minimize}
                  className="text-gray-500 hover:text-gray-300 text-lg leading-none px-1"
                  title="最小化（保留已输入内容）"
                  aria-label="最小化对话框"
                >
                  —
                </button>
                <button
                  onClick={() => setCustomPromptOpen(false)}
                  className="text-gray-500 hover:text-gray-300 text-lg leading-none px-1"
                  title="关闭"
                  aria-label="关闭对话框"
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <p className="text-xs text-gray-500 mb-3">
                输入你对叙事风格、对话语气或剧情走向的指示。提示词将注入到当前会话的所有后续 LLM 调用中。
              </p>
              <textarea
                className="w-full h-40 bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-100
                           resize-y focus:outline-none focus:border-violet-500/50 placeholder-gray-500"
                placeholder={`例如：
用更简洁的语言叙述
增加悬疑氛围
角色对话更活泼一些
避免使用过于华丽的修辞`}
                value={customPromptDraft}
                onChange={(e) => setCustomPromptDraft(e.target.value)}
                autoFocus
              />
            </div>
            <div className="flex items-center justify-between px-5 py-3 border-t border-gray-700">
              <button
                onClick={() => setCustomPromptOpen(false)}
                className="text-xs px-3 py-1.5 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-700/50 transition-colors"
              >
                取消
              </button>
              <div className="flex items-center gap-2">
                {customPromptDraft.trim() && (
                  <button
                    onClick={async () => {
                      if (!activeSessionId) return;
                      setCustomPromptSaving(true);
                      try {
                        await api.saveCustomPrompt(activeSessionId, "");
                        setCustomPromptDraft("");
                        setSessions(sessions.map(s =>
                          s.id === activeSessionId ? { ...s, custom_prompt: undefined } : s
                        ));
                      } catch (err: any) {
                        alert("清除失败: " + (err.message || "未知错误"));
                      } finally {
                        setCustomPromptSaving(false);
                      }
                    }}
                    className="text-xs px-3 py-1.5 rounded text-red-400 hover:text-red-300 hover:bg-red-700/20 transition-colors"
                    disabled={customPromptSaving}
                  >
                    清除
                  </button>
                )}
                <button
                  onClick={async () => {
                    if (!activeSessionId) return;
                    setCustomPromptSaving(true);
                    try {
                      await api.saveCustomPrompt(activeSessionId, customPromptDraft.trim());
                      setSessions(sessions.map(s =>
                        s.id === activeSessionId ? { ...s, custom_prompt: customPromptDraft.trim() || undefined } : s
                      ));
                      setCustomPromptOpen(false);
                    } catch (err: any) {
                      alert("保存失败: " + (err.message || "未知错误"));
                    } finally {
                      setCustomPromptSaving(false);
                    }
                  }}
                  className="btn-primary text-xs px-4 py-1.5"
                  disabled={customPromptSaving}
                >
                  {customPromptSaving ? "保存中..." : "保存"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Combat Briefing Modal — 战前打法选择 */}
      {pendingBriefing && (
        <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/60 ${briefingDialog.minimizedClass}`}>
          <div
            ref={briefingDialog.containerRef}
            tabIndex={-1}
            className="bg-gray-800 border border-gray-700 rounded-xl w-[520px] flex flex-col shadow-2xl outline-none"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
              <h2 className="text-base font-semibold">⚔ {pendingBriefing.name}</h2>
              <button
                onClick={briefingDialog.minimize}
                className="text-gray-500 hover:text-gray-300 text-lg leading-none px-1"
                title="最小化（必选流程，需回到此处完成选择）"
                aria-label="最小化对话框"
              >
                —
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <p className="text-[12px] text-gray-500 mb-3">
                战斗选项为必选流程节点，无法关闭；可最小化后继续查看剧情，完成后自动恢复。
              </p>
              {briefingCheck ? (
                <div>
                  <p className="text-xs text-amber-200 font-display mb-2">
                    🎲 {briefingCheck.attr}检定 — {briefingCheck.character} 掷出 d20 = {briefingCheck.d20} {briefingCheck.modifier >= 0 ? "+" : ""}{briefingCheck.modifier} = {briefingCheck.total} vs DC {briefingCheck.dc}
                  </p>
                  <p className={"text-sm font-bold mb-3 " + (briefingCheck.success ? "text-emerald-300" : "text-red-300")}>
                    {briefingCheck.success ? "✅ 成功 — 避免了战斗" : "❌ 失败 — 敌人警觉，被迫开战"}
                  </p>
                  {briefingCheck.success ? (
                    <button
                      onClick={() => {
                        setPendingBriefing(null);
                        setBriefingCheck(null);
                        setPendingAutoNarrate({ action: "描述交涉成功后的场景与去向" });
                      }}
                      className="btn-primary text-xs px-4 py-1.5"
                    >
                      继续
                    </button>
                  ) : briefingCombatState ? (
                    <button
                      onClick={() => {
                        setCombatContext({
                          sessionId: pendingBriefing.session_id,
                          state: sessions.find((session) => session.id === pendingBriefing.session_id)?.combat_mode === "sideview"
                            ? null : briefingCombatState,
                        });
                        setPendingBriefing(null);
                        setBriefingCheck(null);
                        setBriefingCombatState(null);
                        setCurrentView("combat");
                      }}
                      className="btn-primary text-xs px-4 py-1.5"
                    >
                      进入战斗
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-gray-500 mb-1">选择你的打法：</p>
                  {pendingBriefing.approaches.map((ap) => (
                    <button
                      key={ap.id}
                      onClick={() => handleBriefingApproach(ap.id)}
                      className="text-left px-3 py-2.5 bg-gray-900 border border-gray-700 rounded-lg hover:bg-gray-700 transition-colors"
                    >
                      <span className="text-sm text-gray-200 font-medium">{ap.label}</span>
                      <span className="block text-[12px] text-gray-500 mt-0.5">{ap.hint}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

// ── SSE narrate helper ──

export function triggerNarrate(
  sessionId: string,
  action?: string,
  branchId?: string,
) {
  const store = useAppStore.getState();

  // Abort previous SSE for the SAME session only
  const prevAbort = store.sessionAbortFns[sessionId];
  prevAbort?.();

  store.setSessionStreaming(sessionId, true);

  const curCount = store.sessionNarrationCount[sessionId] || 0;
  const newRound = curCount + 1;
  store.setSessionNarrationCount(sessionId, newRound);

  // 玩家身份：优先使用会话创建时选择的身份角色
  const session = store.sessions.find((s) => s.id === sessionId);
  const identity = session?.player_identity || "玩家";

  // 与组件内 sceneCharacters 一致：流式结束后用完整叙述解析气泡说话人
  const sceneChars: string[] = (session?.characters || [])
    .map((c: string) => c)
    .filter(Boolean);
  if (identity && !sceneChars.includes(identity)) sceneChars.push(identity);

  let accumulated = "";
  let accumulatedReasoning = "";
  let failed = false;
  const refreshStoryValues = () => {
    const current = useAppStore.getState();
    current.triggerStatsRefresh();
    current.triggerEnvRefresh();
  };

  const url = action
    ? `/api/sessions/${sessionId}/narrate?identity=${encodeURIComponent(identity)}&action=${encodeURIComponent(action)}`
    : `/api/sessions/${sessionId}/narrate?identity=${encodeURIComponent(identity)}`;
  // 分支落点：玩家点选的是结构化分支时，带上 branch_id 让后端精确恢复目标节拍
  const urlWithBranch = branchId
    ? `${url}&branch_id=${encodeURIComponent(branchId)}`
    : url;

  const sse = createSSE(urlWithBranch, {
      onReasoning: (token: string) => {
        accumulatedReasoning += token;
        useAppStore.getState().setSessionMessages(sessionId, (prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "narrator" && last.round === newRound) {
            return [...prev.slice(0, -1), { ...last, streaming: true, reasoning: accumulatedReasoning }];
          }
          return [...prev, { role: "narrator", content: "", reasoning: accumulatedReasoning, round: newRound, streaming: true }];
        });
      },
      onText: (token: string) => {
        accumulated += token;
        useAppStore.getState().setSessionMessages(sessionId, (prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "narrator" && last.round === newRound) {
            return [...prev.slice(0, -1), { role: "narrator", content: accumulated, round: newRound, streaming: true }];
          }
          return [...prev, { role: "narrator", content: accumulated, round: newRound, streaming: true }];
        });
      },
      onSceneEvent: () => useAppStore.getState().triggerEnvRefresh(),
      onMemoryEvent: () => useAppStore.getState().triggerMemoryRefresh(),
      onChoice: (options: string[], branches?: BranchChoice[]) => {
        useAppStore.getState().setSessionMessages(sessionId, (prev) => [
          ...prev,
          { role: "system", content: "— 请选择 —", choices: options, branches, round: newRound },
        ]);
      },
      onDialogueSegments: (segments) => {
        useAppStore.getState().setSessionMessages(sessionId, (prev) =>
          prev.map((m) =>
            m.role === "narrator" && m.round === newRound
              ? { ...m, streaming: true, dialogueSegments: segments }
              : m
          )
        );
      },
      onTokenUsage: (usage) => {
        useAppStore.getState().setSessionMessages(sessionId, (prev) =>
          prev.map((m) =>
            m.role === "narrator" && m.round === newRound
              ? { ...m, streaming: true, usage }
              : m
          )
        );
      },
      onCombatTrigger: (data: { encounter_id: string; session_id: string }) => {
        useAppStore.getState().setSessionStreaming(sessionId, false);
        useAppStore.getState().setSessionSending(sessionId, false);
        useAppStore.getState().setSessionMessages(sessionId, (prev) =>
          prev.map((m) => (m.role === "narrator" && m.round === newRound ? { ...m, streaming: false } : m))
        );
        useAppStore.getState().setCombatContext({ sessionId: data.session_id });
        useAppStore.getState().setCurrentView("combat");
      },
      onCombatBriefing: (data: { encounter_id: string; session_id: string; name: string; approaches: { id: string; label: string; hint: string; kind: "combat" | "check" | "avoid" }[] }) => {
        useAppStore.getState().setSessionStreaming(sessionId, false);
        useAppStore.getState().setSessionSending(sessionId, false);
        useAppStore.getState().setSessionMessages(sessionId, (prev) =>
          prev.map((m) => (m.role === "narrator" && m.round === newRound ? { ...m, streaming: false } : m))
        );
        useAppStore.getState().setPendingBriefing(data);
      },
      onAttributeRoll: (data: {
        attribute: string; character: string; roll: number;
        modifier: number; total: number; dc: number;
        success: boolean; text: string; source: string; stream_id: string;
      }) => {
        useAppStore.getState().setSessionMessages(sessionId, (prev) => [
          ...prev,
          {
            role: "system",
            content: data.text,
            rollData: data,
          },
        ]);
      },
      onError: (msg: string) => {
        failed = true;
        // 请求在生成任何叙述前被拒绝（例如 409），不凭空增加一轮。
        if (!accumulated && !accumulatedReasoning) useAppStore.getState().setSessionNarrationCount(sessionId, curCount);
        refreshStoryValues();
        useAppStore.getState().setSessionStreaming(sessionId, false);
        useAppStore.getState().setSessionSending(sessionId, false);
        useAppStore.getState().setSessionMessages(sessionId, (prev) =>
          prev.map((m) => (m.role === "narrator" && m.round === newRound ? { ...m, streaming: false } : m))
        );
        useAppStore.getState().setSessionMessages(sessionId, (prev) => [...prev, { role: "system", content: `错误: ${msg}`, requestError: true }]);
      },
      onDone: () => {
        if (failed) return;
        refreshStoryValues();
        useAppStore.getState().setSessionStreaming(sessionId, false);
        useAppStore.getState().setSessionSending(sessionId, false);
        useAppStore.getState().setSessionMessages(sessionId, (prev) =>
          prev.map((m) => {
            if (m.role !== "narrator" || m.round !== newRound) return m;
            const content = m.content || accumulated || "";
            // 优先使用后端结构化片段；否则用完整文本在流式结束后统一解析为气泡
            const segments = m.dialogueSegments?.length
              ? normalizeSegments(m.dialogueSegments)
              : normalizeSegments(parseDialogue(content, m.character, sceneChars));
            return {
              ...m,
              streaming: false,
              content,
              variants: [content],
              variantIndex: 0,
              dialogueSegments: segments,
            };
          })
        );
      },
    }
  );

  useAppStore.getState().setSessionAbortFn(sessionId, () => sse.close());
}
