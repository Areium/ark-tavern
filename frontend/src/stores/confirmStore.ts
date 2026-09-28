import { create } from "zustand";

export interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  tone?: "danger" | "neutral";
}

interface PendingConfirmation extends ConfirmOptions {
  message: string;
  resolve: (confirmed: boolean) => void;
}

export const useConfirmStore = create<{ pending: PendingConfirmation | null }>(() => ({ pending: null }));

/** Only one protected action at a time. Repeated clicks never queue another deletion. */
export function confirmAction(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  if (useConfirmStore.getState().pending) return Promise.resolve(false);
  return new Promise((resolve) => {
    useConfirmStore.setState({ pending: { message, ...options, resolve } });
  });
}

export function settleConfirmation(confirmed: boolean): void {
  const pending = useConfirmStore.getState().pending;
  useConfirmStore.setState({ pending: null });
  pending?.resolve(confirmed);
}
