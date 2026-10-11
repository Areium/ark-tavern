import type { useApi } from "../hooks/useApi";
import type { StoryTreeNode } from "../types";
import { useAppStore } from "../stores/appStore";
import { confirmAction } from "../stores/confirmStore";

type RollbackApi = Pick<ReturnType<typeof useApi>, "rollbackNode">;

/** Hold a per-session mutation lock and never apply an obsolete response. */
export async function rollbackStoryNode(sessionId: string, node: StoryTreeNode, api: RollbackApi) {
  const isBusy = () => {
    const store = useAppStore.getState();
    return store.activeSessionId !== sessionId || store.sessionSending[sessionId] || store.sessionStreaming[sessionId] || !!store.sessionRollback[sessionId];
  };
  if (!node.has_state || isBusy()) return null;
  if (!await confirmAction(`回档到「${node.title || node.id}」？\n将恢复第 ${node.round_end ?? 0} 轮的会话状态，之后的进度会被清除。`,
    { title: "回退进度", confirmLabel: "回退到此节点" }) || isBusy()) return null;
  const source = useAppStore.getState();
  const messages = source.sessionMessages[sessionId];
  const epoch = source.sessionEpochs[sessionId];
  const round = source.sessionNarrationCount[sessionId];
  const owner = `${sessionId}:${Date.now()}:${Math.random()}`;
  source.setSessionRollback(sessionId, owner);
  try {
    const result = await api.rollbackNode(sessionId, node.id);
    const store = useAppStore.getState();
    if (store.sessionRollback[sessionId] !== owner || store.sessionMessages[sessionId] !== messages || store.sessionEpochs[sessionId] !== epoch
      || store.sessionNarrationCount[sessionId] !== round || store.sessionAbortFns[sessionId]) return null;
    store.setSessionMessages(sessionId, previous => previous.filter(message => !message.round || message.round <= result.target_round));
    store.setSessionNarrationCount(sessionId, result.narration_count);
    if (store.activeSessionId === sessionId) {
      store.triggerEnvRefresh(); store.triggerCharacterRefresh(); store.triggerStatsRefresh();
    }
    return result;
  } finally {
    const store = useAppStore.getState();
    if (store.sessionRollback[sessionId] === owner) store.setSessionRollback(sessionId, null);
  }
}
