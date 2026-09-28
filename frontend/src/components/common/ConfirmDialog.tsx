import { useEffect, useId, useRef, type ReactNode } from "react";
import AppIcon from "../AppIcon";
import "../../styles/confirm-dialog.css";

interface Props {
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  tone?: "danger" | "neutral";
  onCancel: () => void;
  onConfirm: () => void;
}

/** App-owned top-layer dialog: focus containment, safe initial focus and Escape. */
export default function ConfirmDialog({ title, children, confirmLabel = "确认删除", tone = "danger", onCancel, onConfirm }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    cancelRef.current?.focus();
    return () => {
      dialog?.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return <dialog ref={dialogRef} className="app-confirm-dialog" aria-labelledby={`${id}-title`}
    aria-describedby={`${id}-description`} onCancel={(event) => { event.preventDefault(); onCancel(); }}
    onKeyDown={(event) => {
      // Keep editor/game shortcuts behind this top-layer dialog inactive.
      event.stopPropagation();
      if (event.key !== "Tab") return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <header className="app-confirm-heading">
      <AppIcon name={tone === "danger" ? "trash" : "info"} size={23} />
      <h2 id={`${id}-title`}>{title}</h2>
    </header>
    <div id={`${id}-description`} className="app-confirm-description">{children}</div>
    <footer className="app-confirm-actions">
      <button ref={cancelRef} type="button" className="app-confirm-cancel" onClick={onCancel}>取消</button>
      <button type="button" className={tone === "danger" ? "app-danger-button app-confirm-submit" : "app-confirm-submit is-neutral"}
        onClick={onConfirm}>{confirmLabel}</button>
    </footer>
  </dialog>;
}
