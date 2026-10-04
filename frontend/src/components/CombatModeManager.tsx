import { useCallback, useEffect, useId, useRef, useState } from "react";
import { getBaseUrl } from "../utils/baseUrl";
import AppIcon from "./AppIcon";
import ConfirmDialog from "./common/ConfirmDialog";
import "./combatModes.css";

interface CombatMode {
  id: string;
  name: string;
  description?: string;
  runtime: "builtin" | "browser";
  enabled: boolean;
  version?: string;
  digest?: string;
  size?: number;
  file_count?: number;
  input?: { id: string; version: number; required: string[] };
}
interface Catalog {
  abi: string;
  modes: CombatMode[];
  errors: { id: string; error: string }[];
}

// Same base URL as useApi: Vite proxy in browsers, preload URL in Electron.
async function modeRequest<T>(path: string, options: RequestInit = {}, blob = false): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 60000);
  try {
    const base = await getBaseUrl();
    const response = await fetch(`${base}/api/combat-modes${path}`, { ...options, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text();
      let message = body;
      try {
        const parsed: unknown = JSON.parse(body);
        if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") message = parsed.error;
      } catch { /* Non-JSON errors remain visible. */ }
      throw new Error(message || `HTTP ${response.status}`);
    }
    return (blob ? await response.blob() : await response.json()) as T;
  } catch (reason) {
    if (controller.signal.aborted) throw new Error("请求超时，结果尚未确认。请刷新列表核对后再试。");
    throw reason;
  } finally { window.clearTimeout(timeout); }
}

const errorText = (reason: unknown) => reason instanceof Error ? reason.message : "请求失败，请重试。";
const modePath = (id: string) => `/${encodeURIComponent(id)}`;
const formatSize = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024
  ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;

export default function CombatModeManager({ onPractice }: { onPractice?: (id: string) => void }) {
  const id = useId();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [busy, setBusy] = useState("正在读取模式列表…");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [removing, setRemoving] = useState<CombatMode | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const locked = useRef(false);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (locked.current) return;
    locked.current = true;
    const token = generation.current;
    setBusy("正在读取模式列表…"); setError(""); setNotice("");
    try {
      const result = await modeRequest<Catalog>("");
      if (token === generation.current) setCatalog(result);
    } catch (reason) { if (token === generation.current) setError(errorText(reason)); }
    finally { if (token === generation.current) { locked.current = false; setBusy(""); } }
  }, []);

  useEffect(() => {
    void refresh();
    return () => { generation.current += 1; locked.current = false; };
  }, [refresh]);

  async function perform(label: string, operation: () => Promise<string>, reload = true, focusRefresh = false) {
    if (locked.current) return;
    locked.current = true;
    const token = generation.current;
    setBusy(label); setError(""); setNotice("");
    try {
      const message = await operation();
      if (token !== generation.current) return;
      setNotice(message);
      if (reload) {
        try {
          const result = await modeRequest<Catalog>("");
          if (token === generation.current) setCatalog(result);
        } catch (reason) {
          if (token === generation.current) {
            setCatalog(null);
            setError(`操作已完成，但列表刷新失败：${errorText(reason)} 请刷新后继续。`);
          }
        }
      }
    } catch (reason) { if (token === generation.current) setError(errorText(reason)); }
    finally {
      if (token === generation.current) {
        locked.current = false; setBusy("");
        if (focusRefresh) window.requestAnimationFrame(() => refreshButton.current?.focus());
      }
    }
  }

  function install() {
    if (!file || !trusted) return;
    const selected = file;
    void perform("正在安装模式包…", async () => {
      const form = new FormData(); form.append("file", selected);
      const result = await modeRequest<CombatMode>("/install", { method: "POST", body: form });
      setFile(null); setTrusted(false);
      if (fileInput.current) fileInput.current.value = "";
      return `已安装「${result.name || result.id}」。启用状态以列表为准。`;
    });
  }

  function toggle(mode: CombatMode) {
    if (mode.runtime !== "browser") return;
    void perform(`正在${mode.enabled ? "停用" : "启用"}「${mode.name}」…`, async () => {
      await modeRequest(modePath(mode.id) + "/enabled", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !mode.enabled }),
      });
      return `已${mode.enabled ? "停用" : "启用"}「${mode.name}」。`;
    });
  }

  function exportMode(mode: CombatMode) {
    void perform(`正在导出「${mode.name}」…`, async () => {
      const blob = await modeRequest<Blob>(modePath(mode.id) + "/export", {}, true);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `${mode.id}.zip`;
      document.body.appendChild(link);
      try { link.click(); } finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
      return `已发起「${mode.name}」下载，请查看浏览器下载记录。`;
    }, false);
  }

  const disabled = Boolean(busy);
  return <section className="combat-modes" aria-labelledby={`${id}-title`}>
    <div className="cm-wrap">
      <header className="cm-header">
        <div><div className="cm-eyebrow"><AppIcon name="combat" size={16} /> COMBAT / 模式库</div>
          <h1 id={`${id}-title`}>战斗模式管理</h1><p>管理内置玩法与本地安装的浏览器模式包。</p></div>
        <button ref={refreshButton} type="button" onClick={() => void refresh()} disabled={disabled}><AppIcon name="refresh" size={16} />刷新列表</button>
      </header>

      <section className="cm-install" aria-labelledby={`${id}-install`}>
        <div><h2 id={`${id}-install`}><AppIcon name="upload" size={18} />安装模式包</h2>
          <p id={`${id}-trust`}>模式包包含第三方可执行代码。仅安装并启用你信任的来源；运行隔离不等于完整沙箱安全，不能保证阻止所有风险。</p>
          <p>也可将模式文件夹复制到 <code>data/combat_modes/&lt;id&gt;/</code> 后刷新列表。</p></div>
        <form onSubmit={(event) => { event.preventDefault(); install(); }}>
          <label htmlFor={`${id}-file`}>选择 ZIP 模式包</label>
          <input ref={fileInput} id={`${id}-file`} type="file" accept=".zip,application/zip" disabled={disabled}
            onChange={(event) => { setFile(event.target.files?.[0] ?? null); setTrusted(false); }} />
          <label className="cm-trust"><input type="checkbox" checked={trusted} disabled={disabled} aria-describedby={`${id}-trust`}
            onChange={(event) => setTrusted(event.target.checked)} />我信任此模式包的来源，并了解运行风险</label>
          <button className="cm-primary" type="submit" disabled={disabled || !file || !trusted}><AppIcon name="plus" size={16} />安装模式包</button>
        </form>
      </section>

      <div className="cm-feedback" role="status" aria-live="polite">{busy || notice}</div>
      {error && <div className="cm-error" role="alert"><AppIcon name="warning" size={18} /><span>{error}</span></div>}
      {catalog && catalog.errors.length > 0 && <section className="cm-errors" aria-label="模式包读取异常">
        <h2><AppIcon name="warning" size={18} />{catalog.errors.length} 个模式包未能载入</h2>
        <p>以下包暂不可用。请检查包文件，修复后刷新；其他正常模式仍可管理。</p>
        <ul>{catalog.errors.map((item, index) => <li key={`${item.id}-${index}`}><code>{item.id}</code><span>{item.error}</span></li>)}</ul>
      </section>}

      <section aria-labelledby={`${id}-list`} aria-busy={disabled}>
        <div className="cm-list-heading"><h2 id={`${id}-list`}>已安装模式 <span>{catalog ? catalog.modes.length : "—"}</span></h2>
          {catalog && <code>ABI {catalog.abi}</code>}</div>
        {!catalog && <div className="cm-empty">{busy ? "正在读取本地模式库…" : "模式列表不可用，请点击上方刷新列表重试。"}</div>}
        {catalog?.modes.length === 0 && <div className="cm-empty"><AppIcon name="folder" size={28} /><h3>暂无可用模式</h3><p>安装 ZIP 模式包，或复制模式文件夹后刷新。</p></div>}
        <div className="cm-grid">{catalog?.modes.map((mode) => <article className="cm-card" key={mode.id}>
          <header><div className="cm-mode-icon"><AppIcon name={mode.runtime === "builtin" ? "lock" : "combat"} size={21} /></div>
            <div className="cm-mode-name"><h3>{mode.name}</h3><code>{mode.id}</code></div>
            <span className={`cm-badge${mode.enabled ? " is-enabled" : ""}`}>{mode.enabled ? "已启用" : "已停用"}</span></header>
          <p className="cm-description">{mode.description || "此模式未提供描述。"}</p>
          <div className="cm-meta"><span>{mode.runtime === "builtin" ? "内置 · 只读" : "浏览器模式"}</span>
            {mode.version && <span>v{mode.version}</span>}{mode.size !== undefined && <span>{formatSize(mode.size)}</span>}
            {mode.file_count !== undefined && <span>{mode.file_count} 个文件</span>}</div>
          {(mode.input || mode.digest) && <details className="cm-details"><summary>技术信息</summary>
            {mode.input && <><p>输入契约：<code>{mode.input.id} / {mode.input.version}</code></p><p>必需字段：{mode.input.required.join("、") || "无"}</p></>}
            {mode.digest && <p>摘要：<code>{mode.digest}</code></p>}</details>}
          <footer>{mode.runtime === "builtin" ? <p><AppIcon name="lock" size={14} />随应用提供，不可停用或卸载</p> : <>
            <button type="button" disabled={disabled} aria-label={`${mode.enabled ? "停用" : "启用"}${mode.name}`} onClick={() => toggle(mode)}>
              <AppIcon name={mode.enabled ? "pause" : "play"} size={15} />{mode.enabled ? "停用" : "启用"}</button>
            <button type="button" disabled={disabled} aria-label={`导出${mode.name}`} onClick={() => exportMode(mode)}><AppIcon name="download" size={15} />导出</button>
            {mode.enabled && onPractice && <button className="cm-primary" type="button" disabled={disabled} onClick={() => onPractice(mode.id)}>演练</button>}
            <button className="cm-danger" type="button" disabled={disabled} aria-label={`卸载${mode.name}`} onClick={() => setRemoving(mode)}><AppIcon name="trash" size={15} />卸载</button>
          </>}</footer>
        </article>)}</div>
      </section>
      <p className="cm-footnote"><AppIcon name="info" size={16} />卸载会将模式包移入归档，不会直接永久删除；可从归档恢复到模式目录后刷新。</p>
    </div>
    {removing && <ConfirmDialog title="卸载战斗模式？" confirmLabel="卸载并归档" onCancel={() => setRemoving(null)} onConfirm={() => {
      const mode = removing; setRemoving(null);
      void perform(`正在归档「${mode.name}」…`, async () => {
        const result = await modeRequest<{ id: string; archived_to: string }>(modePath(mode.id), { method: "DELETE" });
        return `已卸载「${mode.name}」。归档位置：${result.archived_to}。可将归档包恢复到 data/combat_modes/${mode.id}/ 后刷新。`;
      }, true, true);
    }}><p>确定卸载「{removing.name}」吗？卸载后将无法从模式库使用它。</p><p>模式文件会移入归档，可手动恢复，不是永久删除。</p></ConfirmDialog>}
  </section>;
}
