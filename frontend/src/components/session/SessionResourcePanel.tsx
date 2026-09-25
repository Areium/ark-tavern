import { useState, useEffect, useCallback, useRef } from "react";
import { useAppStore } from "../../stores/appStore";
import { useApi } from "../../hooks/useApi";
import type {
  SessionResourcesDTO,
  SessionResourceDTO,
} from "../../types";

const MEDIA_LABEL: Record<string, string> = {
  avatar: "头像",
  skin: "立绘",
  card_face: "卡面",
};
const MEDIA_TYPES: Array<"avatar" | "skin" | "card_face"> = [
  "avatar",
  "skin",
  "card_face",
];

/** 图片库单张图片（/api/assets/images 中 images[] 的元素） */
interface AssetImage {
  name: string;
  path: string;
  url: string;
  subdir: string;
}

/** 图片库实体分组 */
interface AssetEntity {
  category: string;
  entity: string;
  entity_name: string;
  images: AssetImage[];
}

/** 从全量图片库中找出某角色的实体分组（按显示名或目录名匹配，取图片最多的一组） */
function findCharacterLibrary(
  entities: AssetEntity[] | null,
  charName: string,
): AssetEntity | null {
  if (!entities) return null;
  const norm = (s: string) => s.trim().toLowerCase();
  const target = norm(charName);
  const candidates = entities.filter(
    (e) =>
      e.category === "characters" &&
      (norm(e.entity_name) === target || norm(e.entity.split("/").pop() || "") === target),
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.images.length - a.images.length);
  return candidates[0];
}

/** 拼接缓存爆破参数（v），保证覆盖图上传后强制刷新浏览器缓存 */
function withVersion(url: string | null | undefined, v: number): string {
  if (!url) return "";
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${v}`;
}

function Thumb({ url, alt, className = "w-12 h-12" }: {
  url: string | null | undefined;
  alt: string;
  className?: string;
}) {
  const [ok, setOk] = useState(true);
  useEffect(() => { setOk(true); }, [url]);
  if (!url || !ok) {
    return (
      <div role="img" aria-label={`${alt}：无`} className={`${className} rounded border border-gray-600 bg-gray-800 flex items-center justify-center text-gray-400 text-[11px] shrink-0`}>
        无
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={alt}
      className={`${className} rounded object-contain bg-gray-800 shrink-0 border border-gray-700`}
      onError={() => setOk(false)}
    />
  );
}

export default function SessionResourcePanel() {
  const { activeSessionId, sessions, bumpResourceVersion } = useAppStore();
  const combatMode = sessions.find((session) => session.id === activeSessionId)?.combat_mode;
  const showBattleBackgrounds = combatMode === "tactical" || combatMode === "sideview";
  const resourceVersion = useAppStore((s) => s.resourceVersion);
  const api = useApi();

  const [data, setData] = useState<SessionResourcesDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // 形象快捷选取：目标角色 + 媒体类型 + 图片库缓存
  const [picker, setPicker] = useState<{ name: string; mediaType: string } | null>(null);
  const [library, setLibrary] = useState<AssetEntity[] | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [defaults, setDefaults] = useState<Record<string, { default_avatar: string; default_skin: string; card_face: string }>>({});
  const loadSequence = useRef(0);
  const [pickingUrl, setPickingUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    if (!activeSessionId) {
      setData(null);
      return;
    }
    setLoading(true);
    setData(null);
    setLibrary(null);
    setDefaults({});
    setError("");
    try {
      const d = await api.getSessionResources(activeSessionId);
      if (sequence !== loadSequence.current) return;
      setData(d);
      setLibraryLoading(true);
      setLibraryError("");
      try {
        const images: AssetEntity[] = await api.listAssetImages();
        if (sequence !== loadSequence.current) return;
        const entries = await Promise.all(d.scene_characters.map(async (name) => {
          const entity = findCharacterLibrary(images, name);
          if (!entity) return [name, { default_avatar: "", default_skin: "", card_face: "" }] as const;
          return [name, await api.getDefaultImage("characters", entity.entity)] as const;
        }));
        if (sequence !== loadSequence.current) return;
        setLibrary(images);
        setDefaults(Object.fromEntries(entries));
      } catch (err: any) {
        if (sequence !== loadSequence.current) return;
        setLibrary(null);
        setDefaults({});
        setLibraryError(err.message || "图片库加载失败");
      } finally {
        if (sequence === loadSequence.current) setLibraryLoading(false);
      }
    } catch (err: any) {
      if (sequence === loadSequence.current) setError(err.message);
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [activeSessionId, api]);

  useEffect(() => {
    setPicker(null);
    void load();
    return () => { loadSequence.current += 1; };
  }, [load]);

  const refresh = async () => {
    await load();
    bumpResourceVersion();
  };

  const handleBgUpload = async (bgId: string, file: File) => {
    if (!activeSessionId) return;
    setBusy(true);
    try {
      await api.uploadSessionBackground(activeSessionId, bgId, file);
      await refresh();
    } catch (err: any) {
      alert("背景上传失败: " + err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleBgDelete = async (bgId: string) => {
    if (!activeSessionId) return;
    setBusy(true);
    try {
      await api.deleteSessionBackground(activeSessionId, bgId);
      await refresh();
    } catch (err: any) {
      alert("删除失败: " + err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleCharMediaUpload = async (
    name: string,
    mediaType: string,
    file: File,
  ) => {
    if (!activeSessionId) return;
    setBusy(true);
    try {
      await api.uploadSessionCharacterMedia(activeSessionId, name, mediaType, file);
      await refresh();
    } catch (err: any) {
      alert("形象上传失败: " + err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleCharMediaDelete = async (name: string, mediaType: string) => {
    if (!activeSessionId) return;
    setBusy(true);
    try {
      await api.deleteSessionCharacterMedia(activeSessionId, name, mediaType);
      await refresh();
    } catch (err: any) {
      alert("删除失败: " + err.message);
    } finally {
      setBusy(false);
    }
  };

  // ── 形象快捷选取：从该角色全局图片库挑一张设为会话覆盖 ──

  const openPicker = (name: string, mediaType: string) => {
    setPicker({ name, mediaType });
  };

  const handlePickImage = async (img: AssetImage) => {
    if (!activeSessionId || !picker) return;
    setPickingUrl(img.url);
    try {
      // 复用既有上传通道：拉取全局图片 → 作为会话覆盖上传（仅本会话生效）
      const res = await fetch(img.url);
      if (!res.ok) throw new Error(`读取图片失败 (${res.status})`);
      const blob = await res.blob();
      const ext = (img.name.match(/\.[a-z0-9]+$/i)?.[0] || ".png").toLowerCase();
      const file = new File([blob], `pick${ext}`, { type: blob.type || "image/png" });
      await api.uploadSessionCharacterMedia(activeSessionId, picker.name, picker.mediaType, file);
      await refresh();
      setPicker(null);
    } catch (err: any) {
      alert("选取形象失败: " + (err.message || "未知错误"));
    } finally {
      setPickingUrl(null);
    }
  };

  if (!activeSessionId) {
    return (
      <p className="text-gray-500 text-sm text-center py-6 leading-relaxed">
        请先选择一个会话
        <br />
        再管理它的覆盖资源
      </p>
    );
  }

  const bgByKey = new Map<string, SessionResourceDTO>(
    (data?.backgrounds ?? []).map((b): [string, SessionResourceDTO] => [b.key, b]),
  );
  const mediaByChar = new Map<string, SessionResourceDTO>(
    (data?.character_media ?? []).map((m): [string, SessionResourceDTO] => [`${m.key}:${m.media_type}`, m]),
  );

  return (
    <div className="space-y-4">
      {error && <p className="text-red-400 text-xs">加载失败: {error}</p>}
      {loading && <p role="status" className="text-gray-400 text-xs">加载中...</p>}
      {libraryError && <p role="alert" className="text-red-400 text-xs">图片库加载失败：{libraryError} <button className="underline" onClick={() => void load()}>重试</button></p>}

      {/* ── 角色形象 ── */}
      <section>
        <h3 className="text-xs font-semibold text-gray-400 mb-2">角色形象</h3>
        {loading && !data ? null : !data || data.scene_characters.length === 0 ? (
          <p className="text-gray-600 text-xs">场景尚未加载角色（阵容在会话大厅配置）</p>
        ) : (
          <div className="space-y-2">
            {data.scene_characters.map((name) => {
              const entity = findCharacterLibrary(library, name);
              return (
                <div key={name} className="card p-2">
                  <h4 className="text-xs font-medium truncate mb-2">{name}</h4>
                  <div className="space-y-3">
                    {MEDIA_TYPES.map((t) => {
                      const covered = mediaByChar.get(`${name}:${t}`);
                      const key = `char-${name}-${t}`;
                      const pool = entity?.images.filter((img) => img.subdir === t) ?? [];
                      const defaultName = defaults[name]?.[t === "avatar" ? "default_avatar" : t === "skin" ? "default_skin" : "card_face"]?.trim();
                      // 与后端头像/立绘规则一致；卡面仅展示明确配置的独立资源。
                      const globalImage = pool.find((img) => img.name === defaultName)
                        ?? (t === "card_face" ? undefined : pool
                          .filter((img) => img.name.toLowerCase().endsWith(".png"))
                          .sort((a, b) => a.name.length - b.name.length)[0]);
                      return (
                        <div key={t}>
                          <div className="flex items-center justify-between gap-2 mb-1.5">
                            <span className="text-xs text-gray-300">{MEDIA_LABEL[t]}</span>
                            {covered && <span className="text-[11px] text-blue-200">会话覆盖</span>}
                          </div>
                          <div className="flex items-start gap-3 mb-1.5">
                            <div className="space-y-1">
                              <Thumb url={withVersion(covered?.url, resourceVersion)} alt={`${name}会话${MEDIA_LABEL[t]}`} className="w-14 h-16" />
                              <p className="text-[11px] text-gray-400 text-center">会话</p>
                            </div>
                            <div className="space-y-1">
                              {libraryLoading ? <div role="status" className="w-14 h-16 rounded border border-gray-600 flex items-center justify-center text-[11px] text-gray-400">加载中</div> : <Thumb url={withVersion(globalImage?.url, resourceVersion)} alt={`${name}全局${MEDIA_LABEL[t]}`} className="w-14 h-16" />}
                              <p className="text-[11px] text-gray-400 text-center">全局</p>
                            </div>
                          </div>
                          <div className="flex gap-1 flex-wrap">
                            <button aria-label={`${covered ? "替换" : "上传"}${name}会话${MEDIA_LABEL[t]}`} disabled={busy || loading} onClick={() => fileRefs.current[key]?.click()} className="text-[11px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-300 hover:bg-gray-600 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400" title={`上传会话${MEDIA_LABEL[t]}（仅本会话生效）`}>
                              {covered ? "替换" : "上传"}
                            </button>
                            <button aria-label={`选取${name}会话${MEDIA_LABEL[t]}`} disabled={busy || loading || !!libraryError} onClick={() => openPicker(name, t)} className="text-[11px] px-1.5 py-0.5 rounded bg-blue-700/30 text-blue-200 hover:bg-blue-700/50 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400" title={`从「${name}」的图片库中选取${MEDIA_LABEL[t]}设为会话覆盖`}>选取</button>
                            {covered && <button aria-label={`删除${name}会话${MEDIA_LABEL[t]}覆盖`} disabled={busy || loading} onClick={() => handleCharMediaDelete(name, t)} className="text-[11px] px-1.5 py-0.5 rounded bg-red-700/30 text-red-300 hover:bg-red-700/50 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400" title={`删除会话${MEDIA_LABEL[t]}覆盖`}>删除覆盖</button>}
                            <input type="file" accept="image/*" className="hidden" ref={(el) => { fileRefs.current[key] = el; }} onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) handleCharMediaUpload(name, t, f);
                              e.target.value = "";
                            }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── 战斗背景 ── */}
      {showBattleBackgrounds && (
        <section>
        <h3 className="text-xs font-semibold text-gray-400 mb-2">战斗背景</h3>
        <p className="text-gray-600 text-[12px] mb-2">
          上传后，本会话的战斗优先使用此图；删除即还原全局背景。
        </p>
        {!data || data.available_background_ids.length === 0 ? (
          <p className="text-gray-600 text-xs">暂无可用背景</p>
        ) : (
          <div className="space-y-2">
            {data.available_background_ids.map((bgId) => {
              const covered = bgByKey.get(bgId);
              return (
                <div key={bgId} className="card p-2">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-medium truncate">{bgId}</span>
                    <span
                      className={`text-[11px] px-1.5 rounded ${
                        covered
                          ? "bg-blue-700/40 text-blue-200"
                          : "bg-gray-700 text-gray-400"
                      }`}
                    >
                      {covered ? "会话覆盖" : "全局来源"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mb-1.5">
                    <Thumb
                      url={covered ? withVersion(covered.url, resourceVersion) : null}
                      alt={`${bgId}会话图`}
                      className="w-16 h-10"
                    />
                    <Thumb
                      url={covered ? covered.global_url : null}
                      alt={`${bgId}全局图`}
                      className="w-16 h-10"
                    />
                    <span className="text-[11px] text-gray-600">会话 / 全局</span>
                  </div>
                  <div className="flex gap-1">
                    <button
                      disabled={busy}
                      onClick={() => fileRefs.current[`bg-${bgId}`]?.click()}
                      className={`text-[11px] px-1.5 py-0.5 rounded ${
                        covered
                          ? "bg-amber-700/30 text-amber-300 hover:bg-amber-700/50"
                          : "bg-gray-700 text-gray-300 hover:bg-gray-600"
                      }`}
                    >
                      {covered ? "替换" : "上传"}
                    </button>
                    {covered && (
                      <button
                        disabled={busy}
                        onClick={() => handleBgDelete(bgId)}
                        className="text-[11px] px-1.5 py-0.5 rounded bg-red-700/30 text-red-300 hover:bg-red-700/50"
                      >
                        删除
                      </button>
                    )}
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      ref={(el) => { fileRefs.current[`bg-${bgId}`] = el; }}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleBgUpload(bgId, f);
                        e.target.value = "";
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        </section>
      )}

      {/* ── 形象快捷选取弹窗（本角色图片库） ── */}
      {picker && (() => {
        const lib = findCharacterLibrary(library, picker.name);
        const wantDir =
          picker.mediaType === "avatar" ? "avatar"
          : picker.mediaType === "skin" ? "skin"
          : "card_face";
        const pool = (lib?.images ?? []).filter((i) => i.subdir === wantDir);
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            onClick={() => setPicker(null)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label={`选取${picker.name}${MEDIA_LABEL[picker.mediaType]}`}
              onKeyDown={(event) => { if (event.key === "Escape" && !pickingUrl) setPicker(null); }}
              className="bg-gray-850 border border-gray-600 rounded-xl p-4 w-[26rem] max-w-[calc(100vw-2rem)] max-h-[80vh] flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-sm font-medium mb-1">
                选取{picker.name}·{MEDIA_LABEL[picker.mediaType]}
              </h3>
              <p className="text-[12px] text-gray-500 mb-3">
                从该角色的全局{MEDIA_LABEL[picker.mediaType]}中挑一张，仅在本会话生效
              </p>
              {libraryLoading ? (
                <p className="text-gray-500 text-sm text-center py-6">图片库加载中...</p>
              ) : pool.length === 0 ? (
                <p className="text-gray-500 text-sm text-center py-6">
                  该角色暂无全局{MEDIA_LABEL[picker.mediaType]}
                  <br />
                  <span className="text-xs text-gray-600">可关闭后上传会话图片，或到角色资产页添加全局图片</span>
                </p>
              ) : (
                <div className="grid grid-cols-3 gap-2 overflow-y-auto pr-1">
                  {pool.map((img) => (
                    <button
                      key={img.path}
                      disabled={pickingUrl !== null}
                      onClick={() => handlePickImage(img)}
                      className="group relative rounded-lg overflow-hidden border border-gray-700 hover:border-amber-500/70 transition-colors disabled:opacity-50"
                      title={img.name}
                    >
                      <img
                        src={img.url}
                        alt={img.name}
                        className="w-full h-20 object-cover"
                      />
                      <span className="absolute inset-x-0 bottom-0 bg-black/60 text-[10px] text-gray-300 px-1 py-0.5 truncate opacity-0 group-hover:opacity-100 transition-opacity">
                        {pickingUrl === img.url ? "应用中..." : img.name}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <button
                autoFocus
                disabled={pickingUrl !== null}
                onClick={() => setPicker(null)}
                className="btn-ghost text-xs w-full mt-3"
              >
                取消
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
