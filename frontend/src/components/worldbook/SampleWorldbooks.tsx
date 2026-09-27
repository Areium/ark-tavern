import { useCallback, useEffect, useRef, useState } from "react";
import type { useApi } from "../../hooks/useApi";

type PackApi = Pick<ReturnType<typeof useApi>, "listAvailableWorldbookPacks" | "installWorldbookPack">;
type Pack = Awaited<ReturnType<PackApi["listAvailableWorldbookPacks"]>>["packs"][number];

export default function SampleWorldbooks({ api, onInstalled, onClose }: {
  api: PackApi; onInstalled: (id?: string) => Promise<void>; onClose: () => void;
}) {
  const [packs, setPacks] = useState<Pack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [installing, setInstalling] = useState<string | null>(null);
  const locked = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try { setPacks((await api.listAvailableWorldbookPacks()).packs); }
    catch (reason: any) { setError(`示例列表读取失败：${reason?.message || "请检查后端连接"}`); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => { heading.current?.focus(); void refresh(); }, [refresh]);
  const install = async (pack: Pack) => {
    if (locked.current || pack.installed) return;
    locked.current = true; setInstalling(pack.id); setError(""); setNotice("");
    try {
      const result = await api.installWorldbookPack(pack.id);
      setPacks(current => current.map(item => item.id === pack.id ? { ...item, installed: true } : item));
      await onInstalled(result.book.id);
      setNotice(`已导入《${pack.name}》，可从书架打开。`);
    } catch (reason: any) {
      if (reason?.status === 409) {
        setPacks(current => current.map(item => item.id === pack.id ? { ...item, installed: true } : item));
        await onInstalled();
        setNotice(`《${pack.name}》已经在书架中，无需重复导入。`);
      } else setError(`导入《${pack.name}》失败：${reason?.message || "请稍后重试"}`);
    } finally { locked.current = false; setInstalling(null); }
  };
  const available = packs.filter(pack => !pack.installed);
  return <section id="worldbook-samples" className="wber-samples" aria-labelledby="worldbook-samples-title">
    <header><div><h2 ref={heading} tabIndex={-1} id="worldbook-samples-title">导入示例世界书</h2>
      <p>选择一个随应用提供的世界。导入后可在书架编辑，并用于创建会话。</p></div>
      <button type="button" onClick={onClose}>返回书架</button></header>
    {notice && <p className="wber-samples-notice" role="status">{notice}</p>}
    {error && <div className="wber-samples-error" role="alert"><p>{error}</p>
      {!installing && <button type="button" onClick={() => void refresh()}>重新加载列表</button>}</div>}
    {loading ? <p role="status">正在读取示例世界书…</p> : !error && !available.length ?
      <p className="wber-samples-empty">{packs.length ? "所有示例世界书均已导入，可从书架打开。" : "暂无可导入的示例世界书。你也可以新建世界书或导入本地文件。"}</p> : null}
    {!loading && <ul>{available.map(pack => <li key={pack.id}>
      <div><h3>{pack.name}</h3><p>{pack.description || "暂无简介"}</p>
        <small>{pack.book_type === "reference" ? "资料世界书" : "剧情世界书"} · {pack.entry_count} 条目</small></div>
      <button type="button" className="is-primary" disabled={!!installing} aria-label={`导入${pack.name}`} onClick={() => void install(pack)}>
        {installing === pack.id ? "正在导入…" : "导入"}
      </button>
    </li>)}</ul>}
  </section>;
}
