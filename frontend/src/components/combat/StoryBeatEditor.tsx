/**
 * 剧情节拍编辑抽屉 — 节点图中"剧情节点"的编辑面板。
 *
 * 数据面：所属书内 plots/<plot_id>/index.md（剧情唯一真相源，叙述引擎共用）。
 * 通过 documents API 读写（带 _hash 冲突检测），节拍增删改在本端做
 * Markdown 手术（utils/plotBeatEditor），保存后由后端重新解析出图。
 */
import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../hooks/useApi";
import {
  addChapter, beatIdOf, deleteBeat, getBeatBody, insertBeat,
  nextBeatId, nextChapterIdx, updateBeat,
} from "../../utils/plotBeatEditor";

interface Props {
  plotId: string;
  bookId?: string | null;
  /** 打开抽屉时定位的节拍（可空 = 只展示章节概览） */
  beatId: string | null;
  onChanged: () => void;
  onClose: () => void;
}

interface DocState {
  content: string;
  metadata: Record<string, any>;
  hash: string;
}

export default function StoryBeatEditor({ plotId, bookId, beatId, onChanged, onClose }: Props) {
  const api = useApi();
  const [doc, setDoc] = useState<DocState | null>(null);
  const [selectedBeat, setSelectedBeat] = useState<string | null>(beatId);
  const [body, setBody] = useState("");
  const [keepOnDeviate, setKeepOnDeviate] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  useEffect(() => { setSelectedBeat(beatId); }, [beatId]);

  const loadDoc = useCallback(async () => {
    setBusy(true);
    try {
      const res = await api.readDocument("plots", plotId, bookId || undefined);
      setDoc({ content: res.content, metadata: res.metadata, hash: res.hash });
      setError(null);
      setConflict(false);
    } catch (e: any) {
      setError(e.message || "剧情文档加载失败");
      setDoc(null);
    } finally {
      setBusy(false);
    }
  }, [api, bookId, plotId]);

  useEffect(() => { setDoc(null); setSelectedBeat(beatId); loadDoc(); }, [loadDoc, beatId]);

  // 选中节拍时同步正文草稿与偏离标记
  useEffect(() => {
    if (!doc || !selectedBeat) return;
    setBody(getBeatBody(doc.content, selectedBeat));
    const header = doc.content.split("\n").find((l) => beatIdOf(l) === selectedBeat);
    setKeepOnDeviate(header ? !/keep_on_deviate:\s*false/.test(header) : true);
    setDirty(false);
    setNotice(null);
  }, [doc, selectedBeat]);

  const save = useCallback(async (mutate: (md: string) => string, message: string) => {
    if (!doc) return;
    setBusy(true);
    setError(null);
    try {
      const nextMd = mutate(doc.content);
      await api.saveDocument("plots", plotId, nextMd, doc.metadata, doc.hash, bookId || undefined);
      const fresh = await api.readDocument("plots", plotId, bookId || undefined);
      setDoc({ content: fresh.content, metadata: fresh.metadata, hash: fresh.hash });
      setNotice(message);
      setDirty(false);
      setConflict(false);
      onChanged();
    } catch (e: any) {
      if (e?.status === 409) {
        setConflict(true);
        setError("保存冲突：剧情文件已被其他窗口/进程修改");
      } else {
        setError(e.message || "保存失败");
      }
    } finally {
      setBusy(false);
    }
  }, [api, bookId, doc, plotId, onChanged]);

  /** 保存当前节拍正文/偏离标记 */
  const saveBeat = useCallback(() => {
    if (!selectedBeat) return;
    save((md) => updateBeat(md, selectedBeat, { body, keepOnDeviate }), "节拍已保存");
  }, [selectedBeat, body, keepOnDeviate, save]);

  const handleAddBeat = useCallback((chapterIdx: number, afterBeatId: string | null) => {
    save((md) => insertBeat(md, chapterIdx, afterBeatId, nextBeatId(md, "beat_new"), "（待补充）"),
      "已添加节拍");
  }, [save]);

  const handleDeleteBeat = useCallback(() => {
    if (!selectedBeat) return;
    if (!window.confirm(`确定删除节拍 ${selectedBeat} 吗？（连同其正文）`)) return;
    save((md) => deleteBeat(md, selectedBeat), "节拍已删除");
    setSelectedBeat(null);
  }, [selectedBeat, save]);

  const handleToggleDeviate = useCallback(() => {
    if (!selectedBeat) return;
    save((md) => updateBeat(md, selectedBeat, { keepOnDeviate: !keepOnDeviate }), "已更新偏离标记");
  }, [selectedBeat, keepOnDeviate, save]);

  const handleAddChapter = useCallback(() => {
    save((md) => addChapter(md, nextChapterIdx(md), "新章节", nextBeatId(md, "beat_new")),
      "已添加章节（含占位节拍）");
  }, [save]);

  // 章节结构（轻量解析，仅用于节拍列表展示）
  const chapters: { idx: number; title: string; beats: string[] }[] = [];
  if (doc) {
    let cur: { idx: number; title: string; beats: string[] } | null = null;
    for (const line of doc.content.split("\n")) {
      const t = line.trim();
      const ch = /^##\s*章节\s*(\d+)\s*[：:]\s*(.*)$/.exec(t);
      if (ch) {
        cur = { idx: parseInt(ch[1], 10), title: ch[2], beats: [] };
        chapters.push(cur);
        continue;
      }
      if (/^##\s/.test(t) && chapters.length > 0) break; // 剧情叙述区结束
      const bt = /^####\s+(beat_[A-Za-z0-9_]+)/.exec(t);
      if (bt && cur) cur.beats.push(bt[1]);
    }
  }

  if (!doc) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
        {busy ? "加载中…" : error || "剧情文档不存在"}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800">
        <span className="text-sm font-medium truncate">📜 剧情：{plotId}</span>
        {selectedBeat && <span className="text-[11px] text-gray-500 font-mono">{selectedBeat}</span>}
        {dirty && <span className="text-[11px] text-amber-400">● 未保存</span>}
        <div className="flex-1" />
        {notice && <span className="text-[12px] text-emerald-300">{notice}</span>}
        <button
          className="text-xs px-2 py-1 rounded border border-gray-700 hover:text-gray-200"
          onClick={handleAddChapter}
          disabled={busy}
          title="在剧情叙述区末尾追加新章节（含占位节拍）"
        >＋ 章节</button>
        {onClose && (
          <button className="text-xs text-gray-500 hover:text-gray-300" onClick={onClose}>✕ 关闭</button>
        )}
      </div>

      {error && (
        <div className="mx-4 mt-3 px-3 py-2 rounded border border-red-800/60 bg-red-950/40 text-xs text-red-200 flex items-center gap-3">
          <span className="flex-1">{error}</span>
          {conflict && (
            <button
              className="px-2 py-0.5 rounded border border-red-700 hover:bg-red-900/40"
              onClick={loadDoc}
            >重新加载</button>
          )}
          <button className="text-red-300/70" onClick={() => setError(null)}>✕</button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* 章节概览 + 节拍增删 */}
        <section className="space-y-1">
          <h3 className="text-xs text-gray-400 tracking-wider">章节与节拍</h3>
          {chapters.length === 0 && (
            <p className="text-[12px] text-gray-500">
              该剧情正文没有「## 章节 N」+「#### beat_id」骨架：节点图上的章节 / 节拍来自参考大纲
              （「LLM 分析剧情结构」的结果，或按「第N幕」标题切出），这里不能逐节拍编辑；
              要改正文请到「文档」页编辑该剧情，或用「+ 章节」为它建立标准骨架。
            </p>
          )}
          {chapters.map((ch) => (
            <div key={ch.idx} className="border border-gray-800 rounded p-2 bg-gray-900/40">
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-300">章节 {ch.idx}：{ch.title}</span>
                <div className="flex-1" />
                <button
                  className="text-[11px] px-1.5 rounded border border-gray-700 hover:text-gray-200"
                  onClick={() => handleAddBeat(ch.idx, null)}
                  disabled={busy}
                  title="在该章节末尾追加节拍"
                >＋ 节拍</button>
              </div>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {ch.beats.map((bid) => (
                  <span
                    key={bid}
                    className={
                      "text-[11px] px-1.5 py-0.5 rounded border cursor-pointer transition-colors " +
                      (selectedBeat === bid
                        ? "border-amber-500/60 bg-amber-600/20 text-amber-200"
                        : "border-gray-700 text-gray-400 hover:text-gray-200")
                    }
                    onClick={() => setSelectedBeat(bid)}
                  >{bid}</span>
                ))}
              </div>
            </div>
          ))}
        </section>

        {/* 节拍编辑 */}
        {selectedBeat ? (
          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <h3 className="text-xs text-gray-400 tracking-wider">节拍正文</h3>
              <div className="flex-1" />
              <label className="flex items-center gap-1 text-[11px] text-gray-500 cursor-pointer">
                <input
                  type="checkbox"
                  checked={keepOnDeviate}
                  disabled={busy}
                  onChange={(e) => setKeepOnDeviate(e.target.checked)}
                />
                偏离保留（keep_on_deviate）
              </label>
              <button
                className="text-[11px] px-1.5 rounded border border-gray-700 hover:text-gray-200"
                onClick={handleToggleDeviate}
                disabled={busy}
                title="立即写入偏离标记（不等正文一起保存）"
              >仅切换标记</button>
              <button
                className="text-[11px] px-1.5 rounded border border-red-800/60 text-red-300 hover:bg-red-900/30"
                onClick={handleDeleteBeat}
                disabled={busy}
              >删除节拍</button>
            </div>
            <textarea
              className="w-full h-72 bg-gray-900 border border-gray-700 rounded p-2 text-xs font-mono text-gray-200 outline-none focus:border-amber-500/50 resize-none"
              value={body}
              onChange={(e) => { setBody(e.target.value); setDirty(true); }}
              placeholder="节拍正文（Markdown）…"
            />
            <div className="flex items-center gap-2">
              <button
                className="text-xs px-2.5 py-1 rounded bg-cyan-800/40 border border-cyan-600/50 hover:bg-cyan-800/70 disabled:opacity-40"
                onClick={saveBeat}
                disabled={busy || !dirty}
              >保存节拍</button>
              <p className="text-[11px] text-gray-600">
                保存到当前剧情；如有其他修改，会提示保存冲突。
              </p>
            </div>
          </section>
        ) : (
          chapters.length > 0 && <p className="text-[12px] text-gray-500">点击上方节拍标签编辑其正文。</p>
        )}
      </div>
    </div>
  );
}
