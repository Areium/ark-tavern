import { useEffect, useRef, useState } from "react";
import { useApi } from "../../hooks/useApi";
import type { AssetEntityGroupDTO, PlotGraphNodeDTO, SceneMediaConfigDTO, SceneMediaEventDTO, SceneVisualDTO, StatFieldDTO, StoryConditionDTO, WorldBookDetail } from "../../types";
import { newSceneVisual, sceneAssetPath, sceneAssetUrl, sceneMediaErrors } from "../../utils/sceneMedia";
import AppIcon from "../AppIcon";

interface Props {
  node: PlotGraphNodeDTO;
  title: string;
  bookId: string;
  plotId: string;
  targets: { id: string; title: string }[];
  onChange: (media: SceneMediaConfigDTO | undefined) => void;
  onApplyBackground: (ids: string[], visual: SceneVisualDTO) => void;
  onSave: () => void;
  saving: boolean;
  saveMessage: string;
  saveError: boolean;
  onClose: () => void;
}
const message = (error: unknown) => error instanceof Error ? error.message : "加载失败，请重试。";
const fieldDefault = (field: StatFieldDTO) => field.default ?? (field.type === "number" ? 0 : field.type === "bool" ? false : field.options?.[0] ?? "");

/** All author drafts live in the graph document, including incomplete events. */
export default function SceneMediaEditor({ node, title, bookId, plotId, targets, onChange, onApplyBackground, onSave, saving, saveMessage, saveError, onClose }: Props) {
  const api = useApi();
  const [assets, setAssets] = useState<AssetEntityGroupDTO[]>([]);
  const [book, setBook] = useState<WorldBookDetail | null>(null);
  const [choices, setChoices] = useState<Record<string, { rule_key: string; label: string }[]>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState("background");
  const [batch, setBatch] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [imageFailed, setImageFailed] = useState(false);
  const active = useRef(true);
  const current = useRef({ media: node.scene_media, onChange });
  current.current = { media: node.scene_media, onChange };
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setLoadError("");
    Promise.allSettled([api.getAssetImages(), api.getWorldbook(bookId), api.getSceneMediaOptions(plotId, bookId)]).then(results => {
      if (cancelled) return;
      const [images, details, options] = results;
      if (images.status === "fulfilled") setAssets(images.value.filter(group => group.worldbook_id === bookId));
      if (details.status === "fulfilled") setBook(details.value);
      if (options.status === "fulfilled") setChoices(options.value.choices);
      setLoadError(results.flatMap(result => result.status === "rejected" ? [message(result.reason)] : []).join("；"));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [api, bookId, plotId, reload]);

  const media = node.scene_media || {};
  const events = media.events || [];
  const selectedEvent = events.find(event => event.id === target);
  const visual = target === "background" ? media.background : selectedEvent?.actions[0]?.visual;
  const previewUrl = visual?.asset ? sceneAssetUrl(visual.asset, bookId) : "";
  useEffect(() => setImageFailed(false), [previewUrl]);
  useEffect(() => { if (target !== "background" && !events.some(event => event.id === target)) setTarget("background"); }, [events, target]);
  const emit = (next: SceneMediaConfigDTO) => onChange(next.background || next.events?.length ? next : undefined);
  const updateEvent = (patch: Partial<SceneMediaEventDTO>) => emit({ ...media, events: events.map(event => event.id === target ? { ...event, ...patch } : event) });
  const setVisual = (next: SceneVisualDTO | undefined, forTarget = target) => {
    // Uploads may finish after another field changes; read the latest controlled draft.
    const latest = current.current.media || {};
    if (forTarget === "background") current.current.onChange({ ...latest, background: next });
    else current.current.onChange({ ...latest, events: (latest.events || []).map(event => event.id === forTarget
      ? { ...event, actions: next ? [{ kind: "set_visual", visual: next }, ...event.actions.slice(1)] : event.actions.slice(1) } : event) });
  };
  const changeVisual = (patch: Partial<SceneVisualDTO>) => setVisual({ ...(visual || newSceneVisual()), ...patch });
  const addEvent = () => {
    const id = `media_${crypto.randomUUID()}`;
    emit({ ...media, events: [...events, { id, trigger: { kind: "enter" }, repeat: "session", priority: 0, actions: [{ kind: "set_visual", visual: newSceneVisual("cg") }] }] });
    setTarget(id);
  };
  const upload = async (file?: File) => {
    if (!file) return;
    const uploadTarget = target;
    setUploading(true); setError("");
    try {
      const result = await api.uploadAssetImage("plots", file, `${plotId}/art`, bookId);
      const asset = sceneAssetPath(result.url, bookId, result.asset_path);
      if (!asset) throw new Error("上传返回的图片不属于当前世界书，未更改配置。");
      if (active.current) {
        const latest = current.current.media;
        const prior = uploadTarget === "background" ? latest?.background : latest?.events?.find(event => event.id === uploadTarget)?.actions[0]?.visual;
        setVisual({ ...(prior || newSceneVisual(uploadTarget === "background" ? "background" : "cg")), asset }, uploadTarget);
        setReload(value => value + 1);
      }
    } catch (failure) { if (active.current) setError(message(failure)); }
    finally { if (active.current) setUploading(false); }
  };
  const images = [...new Map(assets.flatMap(group => group.images.flatMap(image => {
    const asset = sceneAssetPath(image.url, bookId, image.asset_path);
    return asset ? [{ ...image, asset, entity: group.entity_name }] : [];
  })).map(image => [image.asset, image])).values()];
  const filtered = images.filter(image => `${image.name} ${image.entity}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const eventChoices = choices[node.ref?.beat_id || ""] || [];
  const errors = sceneMediaErrors(media);
  return <section className="ng-media-panel" aria-labelledby="scene-media-heading">
    <header className="ng-media-header"><h2 id="scene-media-heading">演出配置 · {title}</h2><button onClick={onClose} aria-label="关闭演出配置"><AppIcon name="close" size={18} /></button></header>
    <div className="ng-media-scroll">
      <div className="ng-media-event-list" role="group" aria-label="演出项目">
        <button aria-pressed={target === "background"} onClick={() => setTarget("background")}>进入节点画面</button>
        {events.map((event, index) => <button key={event.id} aria-pressed={target === event.id} onClick={() => setTarget(event.id)}>{event.title || `事件 ${index + 1}`}</button>)}
        <button onClick={addEvent} disabled={events.length >= 32}><AppIcon name="plus" />添加事件</button>
      </div>
      <p className="ng-media-hint">画面持续到下一次明确切换。清除配置后，本节点沿用当前画面。</p>
      {selectedEvent && <section className="ng-media-event-config" aria-label="事件触发设置">
        <label className="ng-media-field">事件名称<input value={selectedEvent.title || ""} maxLength={100} onChange={event => updateEvent({ title: event.target.value })} placeholder="例如：发现密室" /></label>
        <div className="ng-media-form-row">
          <label className="ng-media-field">触发时机<select value={selectedEvent.trigger.kind} onChange={event => updateEvent({ trigger: { kind: event.target.value as SceneMediaEventDTO["trigger"]["kind"] } })}>
            <option value="enter">进入节点</option><option value="condition">满足条件</option>{node.type === "beat" && <option value="choice">选择分支后</option>}
          </select></label>
          <label className="ng-media-field">重复策略<select value={selectedEvent.repeat} onChange={event => updateEvent({ repeat: event.target.value as SceneMediaEventDTO["repeat"] })}><option value="session">每个会话一次</option><option value="entry">每次进入节点</option></select></label>
          <label className="ng-media-field">优先级<input type="number" min={0} max={100} step={1} value={selectedEvent.priority} onChange={event => updateEvent({ priority: Math.max(0, Math.min(100, Math.trunc(Number(event.target.value)))) })} /></label>
        </div>
        {selectedEvent.trigger.kind === "choice" && <label className="ng-media-field">作者分支<select value={selectedEvent.trigger.choice_key || ""} onChange={event => updateEvent({ trigger: { kind: "choice", choice_key: event.target.value } })} disabled={loading}>
          <option value="">{loading ? "正在加载分支…" : "选择分支"}</option>
          {selectedEvent.trigger.choice_key && !eventChoices.some(choice => choice.rule_key === selectedEvent.trigger.choice_key) && <option value={selectedEvent.trigger.choice_key}>已有分支（当前列表不可用）</option>}
          {eventChoices.map(choice => <option key={choice.rule_key} value={choice.rule_key}>{choice.label}</option>)}
        </select>{!loading && !eventChoices.length && <span>此节拍没有可用作者分支，请先在剧情中配置分支。</span>}</label>}
        <ConditionsEditor conditions={selectedEvent.conditions || []} book={book} loading={loading} onChange={conditions => updateEvent({ conditions })} />
        <button className="ng-media-remove" onClick={() => { emit({ ...media, events: events.filter(event => event.id !== target) }); setTarget("background"); }}>移除事件</button>
      </section>}
      <div className="ng-media-preview" aria-label="画面预览">
        {previewUrl && !imageFailed ? <><img src={previewUrl} alt="当前演出画面" style={{ objectFit: visual!.fit, objectPosition: `${visual!.position[0]}% ${visual!.position[1]}%` }} onError={() => setImageFailed(true)} />
          {visual!.portraits === "show" && <div className="ng-media-portrait-preview" aria-label="立绘显示示意"><AppIcon name="user" size={44} /><span>立绘区域</span></div>}
          <div className="ng-media-dialogue-preview" aria-hidden="true">对白区域</div></>
          : <div><AppIcon name="image" size={28} /><span>{imageFailed ? "图片无法加载，请检查资源" : target === "background" ? "沿用当前画面" : "选择事件图片"}</span></div>}
      </div>
      <div className="ng-media-preview-caption"><span>{visual?.asset || "尚未选择图片"}</span><button disabled={!visual} onClick={() => setVisual(undefined)}>清除图片</button></div>
      <div className="ng-media-form-row">
        <label className="ng-media-field">画面类型<select value={visual?.role || (target === "background" ? "background" : "cg")} onChange={event => {
          const role = event.target.value as SceneVisualDTO["role"];
          changeVisual({ role, portraits: role === "cg" ? "hide" : "show", fit: role === "cg" ? "contain" : "cover" });
        }}><option value="background">场景背景</option><option value="cg">CG</option></select></label>
        <label className="ng-media-field">图片适配<select value={visual?.fit || "cover"} disabled={!visual} onChange={event => changeVisual({ fit: event.target.value as SceneVisualDTO["fit"] })}><option value="cover">铺满画面</option><option value="contain">完整显示</option></select></label>
        <label className="ng-media-field">角色立绘<select value={visual?.portraits || "show"} disabled={!visual} onChange={event => changeVisual({ portraits: event.target.value as SceneVisualDTO["portraits"] })}><option value="show">显示</option><option value="hide">隐藏</option></select></label>
      </div>
      <div className="ng-media-form-row">
        {([0, 1] as const).map(axis => <label key={axis} className="ng-media-field">{axis === 0 ? "水平位置" : "垂直位置"} · {visual?.position[axis] ?? 50}%<input type="range" min={0} max={100} value={visual?.position[axis] ?? 50} disabled={!visual} onChange={event => {
          const position: [number, number] = [...(visual?.position || [50, 50])]; position[axis] = Number(event.target.value); changeVisual({ position });
        }} /></label>)}
      </div>
      {target === "background" && <details className="ng-media-batch"><summary>应用到其他节点</summary><p className="ng-media-hint">替换所选节点的进入画面，保留各节点的事件。</p><div className="ng-media-batch-list">
        {targets.filter(item => item.id !== node.id).map(item => <label key={item.id}><input type="checkbox" checked={batch.includes(item.id)} onChange={event => setBatch(prev => event.target.checked ? [...prev, item.id] : prev.filter(id => id !== item.id))} />{item.title}</label>)}
        {targets.length < 2 && <p>没有其他可配置节点。</p>}
      </div><button disabled={!media.background?.asset || !batch.length} onClick={() => { if (media.background) { onApplyBackground(batch, media.background); setNotice(`已应用到 ${batch.length} 个节点，可撤销。`); setBatch([]); } }}>应用到所选 {batch.length} 个节点</button></details>}
      {notice && <p role="status" className="ng-media-hint">{notice}</p>}
      <div className="ng-media-library-heading"><h3>本书图片</h3><label className={`ng-media-upload${uploading ? " is-disabled" : ""}`}><AppIcon name="upload" />{uploading ? "上传中…" : "上传图片"}<input aria-label="上传本书图片" type="file" accept=".png,.jpg,.jpeg,.gif,.webp,.bmp" disabled={uploading} onChange={event => { void upload(event.target.files?.[0]); event.target.value = ""; }} /></label></div>
      <label className="ng-media-field"><span className="sr-only">搜索本书图片</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索图片或所属条目" /></label>
      {(loadError || error) && <div className="ng-media-error" role="alert"><span>{loadError || error}</span><button onClick={() => { setError(""); setReload(value => value + 1); }}>重新加载资源</button></div>}
      {loading ? <p className="ng-media-empty" role="status">正在加载本书资源…</p> : filtered.length ? <div className="ng-media-grid">{filtered.map(image => <button key={image.asset} title={`${image.entity} / ${image.name}`} aria-pressed={visual?.asset === image.asset} onClick={() => setVisual({ ...(visual || newSceneVisual(target === "background" ? "background" : "cg")), asset: image.asset })}>
        <img src={sceneAssetUrl(image.asset, bookId)} alt="" loading="lazy" /><span>{image.name}</span><small>{image.entity}</small></button>)}</div> : <p className="ng-media-empty">{query ? "没有匹配的图片。" : "本书暂无图片，可以上传图片。"}</p>}
      {errors.length > 0 && <div className="ng-media-validation" role="status"><strong>保存前需补全</strong><ul>{errors.map((text, index) => <li key={index}>{text}</li>)}</ul></div>}
    </div>
    <footer className="ng-media-footer ng-media-editor-footer">
      <span className={`ng-media-save-message${saveError ? " is-error" : ""}`} role={saveError ? "alert" : "status"}>{saveMessage}</span>
      <div className="ng-media-footer-actions"><button onClick={onClose}>完成配置</button>
        <button className="ng-media-save" disabled={saving} onClick={onSave}><AppIcon name="save" />{saving ? "保存中…" : "保存节点图"}</button></div>
    </footer>
  </section>;
}

function ConditionsEditor({ conditions, book, loading, onChange }: { conditions: StoryConditionDTO[]; book: WorldBookDetail | null; loading: boolean; onChange: (value: StoryConditionDTO[]) => void }) {
  const fields = book?.stat_fields || [];
  const items = book?.entries.filter(entry => entry.category_id === "items" && entry.enabled) || [];
  const actors = [...new Set((book?.entries || []).map(entry => entry.character_id).filter((id): id is string => !!id))];
  const update = (index: number, condition: StoryConditionDTO) => onChange(conditions.map((value, at) => at === index ? condition : value));
  return <div className="ng-media-conditions"><h3>触发条件（全部满足）</h3>
    {conditions.map((condition, index) => <fieldset className="ng-media-condition" key={index}><legend>条件 {index + 1}</legend>
      {condition.kind === "stat" ? <>
        <label className="ng-media-field">角色<select value={condition.actor} onChange={event => update(index, { ...condition, actor: event.target.value })}><option value="player">玩家</option>
          {!actors.includes(condition.actor) && condition.actor !== "player" && <option value={condition.actor}>{condition.actor}</option>}
          {actors.map(actor => <option key={actor} value={actor}>{actor}</option>)}
        </select></label>
        <label className="ng-media-field">数值字段<select value={condition.key} onChange={event => { const field = fields.find(value => value.key === event.target.value); if (field) update(index, { ...condition, key: field.key, op: "eq", value: fieldDefault(field) }); }}>
          {!fields.some(field => field.key === condition.key) && <option value={condition.key}>{condition.key || "选择数值字段"}（不可用）</option>}
          {fields.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}
        </select></label>
        <label className="ng-media-field">比较<select value={condition.op} onChange={event => update(index, { ...condition, op: event.target.value as typeof condition.op })}>
          <option value="eq">等于</option><option value="ne">不等于</option>
          {(fields.find(field => field.key === condition.key)?.type === "number" || ["gt", "gte", "lt", "lte"].includes(condition.op)) && <><option value="gt">大于</option><option value="gte">大于等于</option><option value="lt">小于</option><option value="lte">小于等于</option></>}
        </select></label>
        <ConditionValue field={fields.find(field => field.key === condition.key)} value={condition.value} onChange={value => update(index, { ...condition, value })} />
      </> : <>
        <label className="ng-media-field">物品<select value={condition.item_id} onChange={event => update(index, { ...condition, item_id: event.target.value })}>
          {!items.some(item => item.uid === condition.item_id) && <option value={condition.item_id}>{condition.item_id || "选择物品"}（不可用）</option>}
          {items.map(item => <option key={item.uid} value={item.uid}>{item.name}</option>)}
        </select></label>
        <label className="ng-media-field">持有状态<select value={String(condition.present)} onChange={event => update(index, { ...condition, present: event.target.value === "true" })}><option value="true">持有</option><option value="false">未持有</option></select></label>
      </>}
      <button aria-label={`移除条件 ${index + 1}`} onClick={() => onChange(conditions.filter((_, at) => at !== index))}><AppIcon name="trash" /></button>
    </fieldset>)}
    <div className="ng-media-targets"><button disabled={loading || !fields.length || conditions.length >= 16} onClick={() => onChange([...conditions, { kind: "stat", actor: "player", key: fields[0].key, op: "eq", value: fieldDefault(fields[0]) }])}>添加数值条件</button>
      <button disabled={loading || !items.length || conditions.length >= 16} onClick={() => onChange([...conditions, { kind: "item", item_id: items[0].uid, present: true }])}>添加物品条件</button></div>
    {!loading && !fields.length && !items.length && <p className="ng-media-hint">本书暂无数值字段或物品条目。</p>}
    {actors.length > 0 && <p className="ng-media-hint">角色条件仅在该角色处于会话阵容时可用。</p>}
  </div>;
}

function ConditionValue({ field, value, onChange }: { field?: StatFieldDTO; value: string | number | boolean; onChange: (value: string | number | boolean) => void }) {
  return <label className="ng-media-field">目标值{field?.type === "bool" ? <select value={String(value)} onChange={event => onChange(event.target.value === "true")}><option value="true">是</option><option value="false">否</option></select>
    : field?.type === "select" ? <select value={String(value)} onChange={event => onChange(event.target.value)}>{!field.options?.includes(String(value)) && <option value={String(value)}>{String(value)}</option>}{field.options?.map(option => <option key={option} value={option}>{option}</option>)}</select>
    : <input type={field?.type === "number" ? "number" : "text"} min={field?.min} max={field?.max} step={field?.step ?? "any"} value={String(value)} onChange={event => onChange(field?.type === "number" ? Number(event.target.value) : event.target.value)} />}</label>;
}
