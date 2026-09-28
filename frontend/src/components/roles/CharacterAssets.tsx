/**
 * 角色页「资产」页签 —— 只看这一个角色的图片：头像 / 立绘 / 卡面。
 *
 * 与总的「资产」模块共用同一批接口（`/api/assets/...`），区别是上传直接落到
 * `characters/<角色>/avatar|skin/` 子目录，因此上传后就能设为默认头像 / 立绘
 * （总资产页上传到实体根目录的图片设不了默认，见 docs/notes.md）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApi } from "../../hooks/useApi";
import { useAppStore } from "../../stores/appStore";
import type { AssetEntityGroupDTO } from "../../types";
import AppIcon from "../AppIcon";
import { ActionButton } from "./RoleWidgets";

interface Props {
  characterId: string;
  worldbookId?: string;
}

type Subdir = "avatar" | "skin" | "card_face";

const SECTIONS: Array<{ subdir: Subdir; label: string; hint: string; defaultKey: "default_avatar" | "default_skin" | "card_face"; type: Subdir }> = [
  { subdir: "avatar", label: "头像", hint: "对话气泡与列表里的小图，建议正方形", defaultKey: "default_avatar", type: "avatar" },
  { subdir: "skin", label: "立绘", hint: "舞台模式与战斗中的全身像，建议透明背景 PNG", defaultKey: "default_skin", type: "skin" },
  { subdir: "card_face", label: "卡面", hint: "战斗卡牌上的图；从头像 / 立绘「设为卡面」会复制到这里", defaultKey: "card_face", type: "card_face" },
];

const IMAGE_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp";

export default function CharacterAssets({ characterId, worldbookId = "" }: Props) {
  const api = useApi();
  const bumpResourceVersion = useAppStore((s) => s.bumpResourceVersion);
  const [group, setGroup] = useState<AssetEntityGroupDTO | null>(null);
  const [defaults, setDefaults] = useState<{ default_avatar: string; default_skin: string; card_face: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const all = await api.getAssetImages();
      const mine = (all || []).filter((g) => g.category === "characters"
        && (g.entity === characterId || g.entity.endsWith(`/${characterId}`))
        && (g.worldbook_id || "") === worldbookId);
      mine.sort((a, b) => b.images.length - a.images.length);
      setGroup(mine[0] || null);
      try {
        const d = await api.getDefaultImage("characters", mine[0]?.entity || characterId, worldbookId);
        setDefaults({ default_avatar: d.default_avatar || "", default_skin: d.default_skin || "", card_face: d.card_face || "" });
      } catch {
        setDefaults({ default_avatar: "", default_skin: "", card_face: "" });
      }
    } catch (err: any) {
      setMessage({ text: err.message || "加载失败", error: true });
    } finally {
      setLoading(false);
    }
  }, [api, characterId, worldbookId]);

  useEffect(() => { void load(); }, [load]);

  const entity = group?.entity || characterId;
  const bySubdir = useMemo(() => {
    const map: Record<string, AssetEntityGroupDTO["images"]> = {};
    for (const img of group?.images || []) (map[img.subdir || ""] ||= []).push(img);
    return map;
  }, [group]);

  const flash = (text: string, error = false) => {
    setMessage({ text, error });
    setTimeout(() => setMessage(null), 2500);
  };

  const upload = async (subdir: Subdir, file: File) => {
    setBusy(true);
    try {
      await api.uploadAssetImage("characters", file, `${entity}/${subdir}`, worldbookId);
      flash(`已上传到 ${subdir}/`);
      await load();
      setVersion((v) => v + 1);
      bumpResourceVersion();
    } catch (err: any) {
      flash(err.message || "上传失败", true);
    } finally {
      setBusy(false);
    }
  };

  const setDefault = async (type: Subdir, filename: string) => {
    setBusy(true);
    try {
      await api.setDefaultImage("characters", entity, type, filename, undefined, worldbookId);
      flash(`已设为默认${SECTIONS.find((s) => s.type === type)?.label}`);
      await load();
      setVersion((v) => v + 1);
      bumpResourceVersion();
    } catch (err: any) {
      flash(err.message || "设置失败", true);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (path: string) => {
    if (!window.confirm(`确定删除「${path.split("/").pop()}」？`)) return;
    setBusy(true);
    try {
      const rel = path.startsWith("characters/") ? path.slice("characters/".length) : path;
      await api.deleteAssetImage("characters", rel, worldbookId);
      flash("已删除");
      await load();
    } catch (err: any) {
      flash(err.message || "删除失败", true);
    } finally {
      setBusy(false);
    }
  };

  const withV = (url: string) => `${url}${url.includes("?") ? "&" : "?"}v=${version}`;

  return (
    <div className="max-w-2xl space-y-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[12px] text-gray-500 leading-relaxed">
          图片存在 <code className="font-mono">characters/{entity}/</code> 下的三个子目录；带 ★ 的是当前默认图。
          会话里想临时换形象，用对话页场景面板的「资源」页（只对该会话生效）。
        </p>
        <ActionButton icon="refresh" variant="ghost" onClick={() => void load()} disabled={loading}>刷新</ActionButton>
      </div>
      {message && (
        <p className={`text-xs ${message.error ? "text-red-400" : "text-emerald-300"}`}>{message.text}</p>
      )}

      {SECTIONS.map((section) => {
        const images = bySubdir[section.subdir] || [];
        const current = defaults?.[section.defaultKey] || "";
        return (
          <section key={section.subdir}>
            <h3 className="roles-section">
              {section.label}
              <span className="text-[11px] font-normal tracking-normal text-gray-600">{section.hint}</span>
            </h3>
            <div className="flex flex-wrap gap-2">
              {images.map((img) => {
                const isDefault = current === img.name;
                return (
                  <div key={img.path} className={`relative group rounded-lg overflow-hidden border-2 ${isDefault ? "border-amber-500/70" : "border-gray-700 hover:border-gray-500"}`}
                    style={{ width: section.subdir === "skin" ? 96 : 80, height: section.subdir === "skin" ? 128 : 80 }} title={img.name}>
                    <img src={withV(img.url)} alt={img.name} className="w-full h-full object-cover" loading="lazy" />
                    {isDefault && (
                      <span className="absolute top-1 left-1 inline-flex items-center justify-center w-4 h-4 rounded-full bg-black/70 text-amber-300">
                        <AppIcon name="star" size={10} fill="currentColor" />
                      </span>
                    )}
                    <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 px-1 py-1 bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity">
                      {!isDefault ? (
                        <button type="button" className="text-[11px] text-amber-300 hover:text-amber-200" disabled={busy}
                          onClick={() => void setDefault(section.type, img.name)}>设为默认</button>
                      ) : <span className="text-[11px] text-amber-300">默认</span>}
                      <button type="button" className="text-gray-300 hover:text-red-300" disabled={busy} title="删除" aria-label={`删除 ${img.name}`}
                        onClick={() => void remove(img.path)}>
                        <AppIcon name="trash" size={11} />
                      </button>
                    </div>
                  </div>
                );
              })}
              <label className={`flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-gray-700 text-gray-500 hover:text-amber-300 hover:border-amber-500/50 cursor-pointer transition-colors ${busy ? "opacity-50 pointer-events-none" : ""}`}
                style={{ width: section.subdir === "skin" ? 96 : 80, height: section.subdir === "skin" ? 128 : 80 }} title={`上传${section.label}`}>
                <AppIcon name="upload" size={16} />
                <span className="text-[11px]">上传</span>
                <input type="file" accept={IMAGE_ACCEPT} className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(section.subdir, f); e.target.value = ""; }} />
              </label>
            </div>
            {section.subdir !== "card_face" && images.length > 0 && (
              <p className="mt-1.5 text-[11px] text-gray-600">
                也可以把这里的图设为卡面：
                {images.map((img) => (
                  <button key={img.path} type="button" className="ml-1.5 underline hover:text-amber-300" disabled={busy}
                    onClick={() => void setDefault("card_face", img.name)}>{img.name}</button>
                ))}
              </p>
            )}
          </section>
        );
      })}

      {Object.keys(bySubdir).some((k) => k && !SECTIONS.some((s) => s.subdir === k)) && (
        <section>
          <h3 className="roles-section">其它</h3>
          <div className="flex flex-wrap gap-2">
            {Object.entries(bySubdir).filter(([k]) => k && !SECTIONS.some((s) => s.subdir === k)).flatMap(([, imgs]) => imgs).map((img) => (
              <div key={img.path} className="rounded-lg overflow-hidden border-2 border-gray-700" style={{ width: 80, height: 80 }} title={`${img.subdir}/${img.name}`}>
                <img src={withV(img.url)} alt={img.name} className="w-full h-full object-cover" loading="lazy" />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
