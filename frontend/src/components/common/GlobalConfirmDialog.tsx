import { useEffect, useRef } from "react";
import { useAppStore } from "../../stores/appStore";
import { settleConfirmation, useConfirmStore } from "../../stores/confirmStore";
import ConfirmDialog from "./ConfirmDialog";

export default function GlobalConfirmDialog() {
  const pending = useConfirmStore((state) => state.pending);
  const view = useAppStore((state) => state.currentView);
  const session = useAppStore((state) => state.activeSessionId);
  const context = `${view}:${session || ""}`;
  const previous = useRef(context);
  useEffect(() => {
    if (previous.current !== context) settleConfirmation(false);
    previous.current = context;
  }, [context]);
  useEffect(() => () => settleConfirmation(false), []);
  if (!pending) return null;
  return <ConfirmDialog title={pending.title || "确认删除"} confirmLabel={pending.confirmLabel}
    tone={pending.tone} onCancel={() => settleConfirmation(false)} onConfirm={() => settleConfirmation(true)}>
    {pending.message}
  </ConfirmDialog>;
}
