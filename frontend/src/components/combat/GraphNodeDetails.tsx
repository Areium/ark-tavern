import { useState, type ReactNode } from "react";
import type { CombatNodeGraphDTO, PlotFlowDTO, PlotGraphNodeDTO } from "../../types";
import { resolveGraphReference } from "./graphReferences";

interface Props {
  node: PlotGraphNodeDTO;
  plot: PlotFlowDTO | null;
  overview: CombatNodeGraphDTO | null;
  onRelink: (ref: PlotGraphNodeDTO["ref"]) => void;
  onClose: () => void;
  onEdit: () => void;
  mediaEditor?: ReactNode;
}

export default function GraphNodeDetails({ node, plot, overview, onRelink, onClose, onEdit, mediaEditor }: Props) {
  const [replacement, setReplacement] = useState("");
  const [tab, setTab] = useState<"content" | "media">("content");
  const { chapter, beat, missing, moved } = resolveGraphReference(node, plot);
  const battle = overview?.nodes.find(n => n.node_id === node.ref?.node_id);
  const unavailable = node.type === "combat" ? !battle || battle.missing : missing;
  const title = beat?.title || (node.type === "chapter" ? chapter?.label : node.type === "plot" ? plot?.name : battle?.name) || node.title;
  const incomingTarget = beat?.id ?? (node.type === "chapter" ? chapter?.beats[0]?.id : undefined);
  const incoming = plot?.chapters.flatMap(ch => ch.beats.flatMap(b => (b.branches ?? [])
    .filter(branch => incomingTarget && branch.target_beat_id === incomingTarget)
    .map(branch => ({ ...branch, from: b.title || b.id })))) ?? [];
  const replacements = node.type === "beat" ? plot?.chapters.flatMap(ch => ch.beats.map(b => ({
    key: `${ch.idx}:${b.id}`, title: `${ch.label} / ${b.title || b.id}`, ref: { chapter_idx: ch.idx, beat_id: b.id },
  }))) : node.type === "chapter" ? plot?.chapters.map(ch => ({
    key: String(ch.idx), title: ch.label, ref: { chapter_idx: ch.idx },
  })) : node.type === "combat" ? overview?.nodes.filter(n => !n.missing).map(n => ({
    key: n.node_id, title: n.name, ref: { node_id: n.node_id },
  })) : [];
  const section = (heading: string, content?: string) => content ? <section className="ng-detail-section"><h3>{heading}</h3><p>{content}</p></section> : null;
  return <div className="ng-node-inspector">
    {mediaEditor && <div className="ng-inspector-tabs" role="tablist" aria-label="节点配置">
      {(["content", "media"] as const).map(value => <button key={value} id={`ng-inspector-tab-${value}`}
        role="tab" aria-selected={tab === value} aria-controls="ng-inspector-panel" tabIndex={tab === value ? 0 : -1}
        onClick={() => setTab(value)} onKeyDown={event => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const next = event.key === "Home" ? "content" : event.key === "End" ? "media" : tab === "content" ? "media" : "content";
            setTab(next); document.getElementById(`ng-inspector-tab-${next}`)?.focus();
          }
        }}>{value === "content" ? "内容" : "演出"}</button>)}
    </div>}
    <div className="ng-inspector-panel" id="ng-inspector-panel" role={mediaEditor ? "tabpanel" : undefined}
      aria-labelledby={mediaEditor ? `ng-inspector-tab-${tab === "media" ? "media" : "content"}` : undefined}>
    {tab === "media" && mediaEditor ? mediaEditor : <section className="ng-media-panel" aria-label="节点内容详情">
    <header className="ng-media-header"><div><h2>{title}</h2><p>节点详情 · {node.type === "beat" ? beat?.id || node.ref?.beat_id : node.type === "chapter" ? chapter?.id : node.type === "combat" ? node.ref?.node_id : plot?.plot_id}</p></div>
      <button onClick={onClose} aria-label="关闭节点详情">关闭</button></header>
    <div className="ng-media-scroll">
      {unavailable && <p role="alert" className="ng-media-error">引用已失效，未打开其他剧情内容。请选择正确资源重新关联；现有布局、连线和演出配置会保留。</p>}
      {moved && <p role="status">此节拍已移动到{chapter?.label}。保存前请更新引用，确保背景与 CG 在正确章节生效。
        <button onClick={() => onRelink({ ...node.ref, chapter_idx: chapter!.idx })}>更新章节引用</button></p>}
      {!unavailable && <>
        {section("内容", beat?.content || beat?.summary || (node.type === "chapter" ? chapter?.summary : node.type === "plot" ? plot?.summary : battle?.summary) || node.content || "暂无正文内容。")}
        {section("必须保留", beat?.must_keep)}
        {section("叙事指引", beat?.guidance)}
        {beat && <p className="ng-detail-section">{beat.choice_required ? "必须由玩家选择分支后推进" : "按剧情节拍推进"}{beat.min_rounds ? ` · 最少 ${beat.min_rounds} 轮` : ""}</p>}
        {node.type === "chapter" && <section className="ng-detail-section"><h3>章节节拍</h3><ul>{chapter?.beats.map(b => <li key={b.id}><strong>{b.title || b.id}</strong><p>{b.summary}</p></li>)}</ul></section>}
        {!!incoming.length && <section className="ng-detail-section"><h3>进入此节点的选项</h3><ul>{incoming.map((b, i) => <li key={i}><strong>{b.from} → {b.label}</strong>{b.intent && <p>{b.intent}</p>}</li>)}</ul></section>}
        {beat && <section className="ng-detail-section"><h3>分支与判定说明</h3>{beat.branches?.length ? <ul>{beat.branches.map((b, i) => <li key={i}><strong>{b.label}</strong>{b.intent && <p>{b.intent}</p>}<p>前往：{b.target_beat_id || "新方向（未指定固定节拍）"}</p></li>)}</ul> : <p>此节拍未配置固定分支。</p>}<p>这里只展示大纲声明的选项与意图；画布连线本身不执行数值或物品判定。</p></section>}
      </>}
      {node.ref && <details className="ng-detail-section" open={unavailable || undefined}><summary>重新关联资源</summary>
        <p>仅选择确认对应的资源，不按相似名称自动替换。已有演出配置将跟随新引用。</p>
        <label className="ng-media-field">关联到<select aria-label="重新关联资源" value={replacement} onChange={e => setReplacement(e.target.value)}>
          <option value="">选择资源</option>{replacements?.map(item => <option key={item.key} value={item.key}>{item.title}</option>)}</select></label>
        <button disabled={!replacement} onClick={() => { const item = replacements?.find(r => r.key === replacement); if (item) { onRelink(item.ref); setReplacement(""); } }}>应用关联</button>
      </details>}
    </div>
    <footer className="ng-media-footer"><span>查看详情不会推进剧情</span><div className="ng-media-targets">
      {!unavailable && node.type !== "note" && <button onClick={onEdit}>{node.type === "combat" ? "编辑战斗内容" : "打开剧情原文"}</button>}
    </div></footer>
  </section>}
  </div></div>;
}
