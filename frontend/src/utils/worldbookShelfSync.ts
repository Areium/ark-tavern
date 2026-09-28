const RETRY_DELAYS = [2000, 5000, 10000];

/** Refresh on entry and return from the filesystem; never poll a healthy shelf. */
export function startWorldbookShelfSync(
  load: () => Promise<boolean>,
  host: Pick<Window, "addEventListener" | "removeEventListener" | "setTimeout" | "clearTimeout"> = window,
  page: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> = document,
): () => void {
  let disposed = false;
  let running = false;
  let retry = 0;
  let timer: number | undefined;
  const clearTimer = () => { host.clearTimeout(timer); timer = undefined; };
  const run = async () => {
    if (disposed || running || page.visibilityState === "hidden") return;
    clearTimer();
    running = true;
    let success = false;
    try { success = await load(); }
    catch { /* The loader owns the visible error; a rejected request is retryable. */ }
    finally { running = false; }
    if (disposed) return;
    if (success) retry = 0;
    else if (retry < RETRY_DELAYS.length) timer = host.setTimeout(() => void run(), RETRY_DELAYS[retry++]);
  };
  const onReturn = () => {
    if (page.visibilityState === "hidden") { clearTimer(); return; }
    // A tab becoming visible often emits focus too: coalesce the pair.
    if (running) return;
    clearTimer();
    retry = 0;
    timer = host.setTimeout(() => void run(), 150);
  };
  host.addEventListener("focus", onReturn);
  host.addEventListener("online", onReturn);
  page.addEventListener("visibilitychange", onReturn);
  void run();
  return () => {
    disposed = true;
    clearTimer();
    host.removeEventListener("focus", onReturn);
    host.removeEventListener("online", onReturn);
    page.removeEventListener("visibilitychange", onReturn);
  };
}
