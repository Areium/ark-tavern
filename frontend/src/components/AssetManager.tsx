/**
 * 资产目录 — 图片资产管理（上传 / 裁剪 / 默认图）。
 *
 * 由「角色 → 资产」页签挂载（原 DocumentManager 图像 Tab 独立成组件，
 * 文档管理功能已迁移至世界书整合包）。
 *
 * 来源标注：每个实体显示上级目录与来源世界书（index.md frontmatter 的
 * worldbook_id），详情面板可修改归属。
 *
 * 分组维度两个，并列存在：
 *  - 按类别（默认，原有维度）：按 assets 类别分组，来源下拉只做筛选（不再改成按书分组——
 *    那和「按世界书」维度是同一件事）；
 *  - 按世界书：一级按来源世界书分组，组内保持原有的实体顺序与实体级折叠。
 *    两个维度的来源选择共用同一个 `bookFilter` 状态。
 *
 * 工具栏只有一个「折叠 / 展开」，作用于当前可见的实体（缩略图那一级）；世界书分组用各自的箭头。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../hooks/useApi";
import { useWorldbookGroups } from "../hooks/useWorldbookGroups";
import { UNCLASSIFIED_KEY } from "../utils/worldbookGrouping";
import type { AssetEntityGroupDTO, SkinCrop, WorldBookSummary } from "../types";
import CropModal from "./assets/CropModal";
import WorldbookGroupList, { GroupDimensionToggle } from "./WorldbookGroupList";
import AppIcon from "./AppIcon";
import {
  ActionButton, EmptyState, FoldAllButton, PanelHeader, SearchInput, SourceBookBadge, ToolIconButton, WorldbookSelect,
} from "./roles/RoleWidgets";
import "../styles/roles.css";

interface ToastState {
  message: string;
  type: "success" | "error";
}

/** 资产条目的两个来源分类维度 */
type AssetDimension = "category" | "worldbook";

interface SelectedImage {
  url: string;
  name: string;
  size: number;
  subdir: string;
  path: string;
  category: string;
  entity: string;
  entityName: string;
}

const IMAGE_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp,.svg,.bmp";

function formatFileSize(bytes: number): string {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 子目录的展示名：card_face 目录在界面上一直叫 card art */
const subdirLabel = (subdir: string) => (subdir === "card_face" ? "card art" : subdir);

export default function AssetManager() {
  const api = useApi();
  const apiRef = useRef(api);
  apiRef.current = api;

  // ── 数据 ──
  const [assetImages, setAssetImages] = useState<AssetEntityGroupDTO[]>([]);
  const [imagesLoading, setImagesLoading] = useState(false);
  const [imageFilter, setImageFilter] = useState("");
  const [worldbooks, setWorldbooks] = useState<WorldBookSummary[]>([]);
  /** 来源筛选："" = 全部，`UNCLASSIFIED_KEY` = 未分类，否则为 book id */
  const [bookFilter, setBookFilter] = useState("");
  const [dimension, setDimension] = useState<AssetDimension>("category");
  const [collapsedImageKeys, setCollapsedImageKeys] = useState<Set<string>>(new Set());
  const [selectedImage, setSelectedImage] = useState<SelectedImage | null>(null);
  const [defaultImages, setDefaultImages] = useState<Record<string, { default_avatar: string; default_skin: string; card_face: string; card_face_crop: SkinCrop | null }>>({});
  const [cropTarget, setCropTarget] = useState<{ url: string; name: string; category: string; entity: string } | null>(null);

  // ── Toast ──
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const showToast = useCallback((message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const loadImages = useCallback(async () => {
    setImagesLoading(true);
    try {
      const data = await apiRef.current.getAssetImages();
      setAssetImages(data || []);
    } catch {
      setAssetImages([]);
    } finally {
      setImagesLoading(false);
    }
  }, []);

  const loadWorldbooks = useCallback(async () => {
    try {
      const res = await apiRef.current.listWorldbooks();
      setWorldbooks(res.books || []);
    } catch { /* 后端不可用时不阻塞资产管理 */ }
  }, []);

  useEffect(() => {
    loadImages();
    loadWorldbooks();
  }, [loadImages, loadWorldbooks]);

  const loadDefaultImages = useCallback(async () => {
    const newDefaults: Record<string, { default_avatar: string; default_skin: string; card_face: string; card_face_crop: SkinCrop | null }> = {};
    for (const item of assetImages) {
      const key = `${item.category}/${item.entity}`;
      try {
        const data = await apiRef.current.getDefaultImage(item.category, item.entity);
        newDefaults[key] = {
          default_avatar: data.default_avatar || "",
          default_skin: data.default_skin || "",
          card_face: data.card_face || "",
          card_face_crop: data.card_face_crop || null,
        };
      } catch { /* skip */ }
    }
    setDefaultImages(newDefaults);
  }, [assetImages]);

  useEffect(() => {
    if (assetImages.length > 0) loadDefaultImages();
  }, [assetImages, loadDefaultImages]);

  // ── 图片操作 ──

  const handleImageUpload = async (file: File, category: string, subdir?: string) => {
    try {
      await apiRef.current.uploadAssetImage(category, file, subdir);
      showToast(`图片 "${file.name}" 已上传`);
      loadImages();
    } catch (err: any) {
      showToast(err.message || "上传失败", "error");
    }
  };

  const handleImageDelete = async (category: string, fullPath: string) => {
    // fullPath example: "characters/阿米娅/avatar/char_002_amiya.png"
    // The API expects path relative to category dir: "阿米娅/avatar/char_002_amiya.png"
    const relativePath = fullPath.startsWith(category + "/")
      ? fullPath.slice(category.length + 1)
      : fullPath;
    try {
      await apiRef.current.deleteAssetImage(category, relativePath);
      showToast("图片已删除");
      if (selectedImage?.path === fullPath) setSelectedImage(null);
      loadImages();
    } catch (err: any) {
      showToast(err.message || "删除失败", "error");
    }
  };

  const handleSetDefaultImage = async (category: string, entity: string, type: "avatar" | "skin" | "card_face", filename: string, crop?: SkinCrop | null) => {
    try {
      await apiRef.current.setDefaultImage(category, entity, type, filename, crop);
      const label = type === "avatar" ? "头像" : type === "skin" ? "立绘" : "卡面";
      showToast(`已设为默认${label}`);
      const key = `${category}/${entity}`;
      setDefaultImages((prev) => {
        const prevEntry = prev[key] || { default_avatar: "", default_skin: "", card_face: "", card_face_crop: null };
        if (type === "card_face") {
          return { ...prev, [key]: { ...prevEntry, card_face: filename, card_face_crop: crop ?? null } };
        }
        return { ...prev, [key]: { ...prevEntry, [`default_${type}`]: filename } };
      });
      // card_face 会复制新文件，刷新图片列表以显示 card_face 子目录分组
      if (type === "card_face") {
        loadImages();
      }
    } catch (err: any) {
      showToast(err.message || "设置失败", "error");
    }
  };

  const handleCropSave = async (crop: SkinCrop) => {
    if (!cropTarget) return;
    await handleSetDefaultImage(cropTarget.category, cropTarget.entity, "card_face", cropTarget.name, crop);
    setCropTarget(null);
  };

  /** 修改实体来源世界书标注 */
  const handleSetEntityWorldbook = async (item: AssetEntityGroupDTO, bookId: string) => {
    try {
      await apiRef.current.setEntityWorldbook(item.category, item.entity, bookId);
      showToast(bookId ? "来源世界书已标注" : "已清除标注");
      setAssetImages((prev) => prev.map((g) =>
        g.category === item.category && g.entity === item.entity
          ? { ...g, worldbook_id: bookId }
          : g,
      ));
    } catch (err: any) {
      showToast(err.message || "标注失败", "error");
    }
  };

  const openDataDir = async () => {
    try {
      const { path } = await apiRef.current.getDataDir();
      if (window.electronAPI) {
        await window.electronAPI.openDirectory(path);
      } else {
        await navigator.clipboard.writeText(path);
        showToast("路径已复制: " + path);
      }
    } catch { /* ignore */ }
  };

  const bookName = (id: string) => worldbooks.find((b) => b.id === id)?.name || id;
  const entityKeyOf = (item: AssetEntityGroupDTO) => `${item.category}/${item.entity}`;

  // ── 筛选 ──
  const query = imageFilter.trim().toLowerCase();
  const matchSearch = (item: AssetEntityGroupDTO) =>
    !query ||
    item.entity_name.toLowerCase().includes(query) ||
    item.category.toLowerCase().includes(query) ||
    item.images.some((img) => img.name.toLowerCase().includes(query));

  // 按类别维度：搜索 + 来源筛选一起生效
  const filtered = assetImages.filter((item) => {
    if (bookFilter === UNCLASSIFIED_KEY && item.worldbook_id) return false;
    if (bookFilter && bookFilter !== UNCLASSIFIED_KEY && item.worldbook_id !== bookFilter) return false;
    return matchSearch(item);
  });

  // 按世界书维度：只按搜索词过滤、不先按 bookFilter 过滤——分组计数要覆盖全部来源，
  // 未被选中的分组才不是 0 条，也才能直接点标题切换来源。
  const searchFiltered = assetImages.filter(matchSearch);

  const {
    groups: worldbookGroups,
    collapsedKeys: collapsedBookKeys,
    toggleCollapsed: toggleBookCollapsed,
    selectedItems: selectedByBook,
  } = useWorldbookGroups(searchFiltered, (item) => item.worldbook_id, worldbooks, bookFilter);

  /** 「折叠 / 展开」按钮的作用范围：当前维度下真正渲染出来的实体 */
  const visibleEntities: readonly AssetEntityGroupDTO[] =
    dimension === "worldbook" ? selectedByBook : filtered;
  const entitiesAllCollapsed =
    visibleEntities.length > 0 && visibleEntities.every((item) => collapsedImageKeys.has(entityKeyOf(item)));
  const toggleFoldAllEntities = () => {
    if (entitiesAllCollapsed) {
      setCollapsedImageKeys(new Set());
    } else {
      setCollapsedImageKeys(new Set(visibleEntities.map(entityKeyOf)));
    }
  };

  // 按类别分组
  const grouped: Record<string, AssetEntityGroupDTO[]> = {};
  for (const item of filtered) {
    (grouped[item.category] = grouped[item.category] || []).push(item);
  }

  const selectImage = (item: AssetEntityGroupDTO, img: AssetEntityGroupDTO["images"][number]) =>
    setSelectedImage({
      url: img.url,
      name: img.name,
      size: img.size,
      subdir: img.subdir || "",
      path: img.path,
      category: item.category,
      entity: item.entity,
      entityName: item.entity_name,
    });

  const renderEntityGroup = (item: AssetEntityGroupDTO) => {
    const entityKey = entityKeyOf(item);
    const defaults = defaultImages[entityKey];
    // 按 subdir 分组图片
    const subdirGroups: Record<string, AssetEntityGroupDTO["images"]> = {};
    for (const img of item.images) {
      const sd = img.subdir || "";
      if (!subdirGroups[sd]) subdirGroups[sd] = [];
      subdirGroups[sd].push(img);
    }

    const isEntityCollapsed = collapsedImageKeys.has(entityKey);
    const toggleEntity = () => {
      setCollapsedImageKeys((prev) => {
        const next = new Set(prev);
        if (next.has(entityKey)) next.delete(entityKey);
        else next.add(entityKey);
        return next;
      });
    };

    return (
      <div key={entityKey} className="mb-1.5 ml-1">
        <div className="flex items-center gap-1 px-1 py-0.5 rounded text-xs text-gray-300 hover:bg-gray-800/60 select-none">
          <button
            type="button"
            onClick={toggleEntity}
            aria-expanded={!isEntityCollapsed}
            aria-label={isEntityCollapsed ? `展开 ${item.entity_name}` : `折叠 ${item.entity_name}`}
            className="w-4 shrink-0 flex items-center justify-center text-gray-500 hover:text-gray-300"
          >
            <AppIcon name={isEntityCollapsed ? "forward" : "expand"} size={12} />
          </button>
          <button
            type="button"
            onClick={toggleEntity}
            className="flex-1 min-w-0 text-left truncate"
            title={`${item.entity_name}（上级目录 ${item.parent_dir}，${item.images.length} 张）`}
          >
            {item.entity_name}
          </button>
          {dimension === "category" && (
            <SourceBookBadge size="xs" name={item.worldbook_id ? bookName(item.worldbook_id) : ""} />
          )}
          <label
            className="inline-flex items-center justify-center w-6 h-6 rounded text-gray-500 hover:text-amber-300 hover:bg-gray-700/50 cursor-pointer shrink-0"
            title="上传到该实体目录"
            onClick={(e) => e.stopPropagation()}
          >
            <AppIcon name="plus" size={13} />
            <input
              type="file"
              accept={IMAGE_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  handleImageUpload(file, item.category, item.entity);
                  e.target.value = "";
                }
              }}
            />
          </label>
        </div>
        {!isEntityCollapsed && Object.entries(subdirGroups).map(([subdir, imgs]) => (
          <div key={subdir || "__root__"} className="mb-1 ml-5">
            {subdir && <div className="roles-subdir mb-1">{subdirLabel(subdir)}</div>}
            <div className="flex flex-wrap gap-1">
              {imgs.map((img) => {
                const isSelected = selectedImage?.path === img.path;
                const isDefaultAvatar = defaults?.default_avatar === img.name;
                const isDefaultSkin = defaults?.default_skin === img.name;
                const isDefaultCardFace = defaults?.card_face === img.name;
                const isDefault = isDefaultAvatar || isDefaultSkin || isDefaultCardFace;
                const defaultLabel = isDefaultAvatar ? "默认头像" : isDefaultSkin ? "默认立绘" : "默认卡面";
                return (
                  <div
                    key={img.path}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelected}
                    className={`relative group rounded overflow-hidden border-2 transition-colors cursor-pointer ${
                      isSelected
                        ? "border-amber-400"
                        : isDefault
                          ? "border-amber-700/50 hover:border-amber-500/60"
                          : "border-gray-700 hover:border-gray-500"
                    }`}
                    style={{ width: 64, height: 64 }}
                    title={`${img.name}${isDefault ? `（${defaultLabel}）` : ""}`}
                    onClick={() => selectImage(item, img)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectImage(item, img); } }}
                  >
                    <img
                      src={img.url}
                      alt={img.name}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                    {isDefault && (
                      <span
                        className="absolute top-0.5 left-0.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-black/70 text-amber-300"
                        title={defaultLabel}
                      >
                        <AppIcon name="star" size={10} fill="currentColor" />
                      </span>
                    )}
                    <button
                      type="button"
                      className="absolute top-0.5 right-0.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-black/70 text-gray-300 hover:text-red-300 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`确定要删除 "${img.name}" 吗？`)) {
                          handleImageDelete(item.category, img.path);
                        }
                      }}
                      title="删除"
                      aria-label={`删除 ${img.name}`}
                    >
                      <AppIcon name="close" size={10} />
                    </button>
                    <div className="absolute bottom-0 left-0 right-0 bg-black/70 text-[11px] text-gray-300 px-1 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                      <div className="truncate">{img.name}</div>
                      {img.size != null && (
                        <div className="text-gray-500">{formatFileSize(img.size)}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  };

  const renderImageTree = () => {
    if (dimension === "worldbook") {
      // 按世界书维度：一级按来源世界书分组，组内沿用原有实体渲染与排序
      return (
        <WorldbookGroupList
          groups={worldbookGroups}
          totalCount={searchFiltered.length}
          activeKey={bookFilter}
          collapsedKeys={collapsedBookKeys}
          onSelect={setBookFilter}
          onToggleCollapse={toggleBookCollapsed}
          renderItems={(items) =>
            items.length === 0 ? (
              <p className="text-xs text-gray-600 italic pl-1">(空)</p>
            ) : (
              items.map(renderEntityGroup)
            )
          }
          emptyHint={
            <p className="text-xs text-gray-500 text-center py-4">
              {imageFilter ? "无匹配结果" : "暂无图像资产"}
            </p>
          }
        />
      );
    }
    if (filtered.length === 0) {
      return (
        <p className="text-xs text-gray-500 text-center py-4">
          {imageFilter || bookFilter ? "无匹配结果" : "暂无图像资产"}
        </p>
      );
    }
    return Object.entries(grouped).map(([cat, items]) => (
      <div key={cat} className="mb-3">
        <div className="flex items-center gap-1.5 py-1 mb-1">
          <span className="roles-category">{cat}</span>
          <span className="text-[12px] text-gray-600">({items.length})</span>
          <div className="flex-1" />
          <label
            className="inline-flex items-center gap-1 text-[12px] text-gray-500 hover:text-amber-300 cursor-pointer px-1 py-0.5 rounded hover:bg-gray-700/50"
            title="上传到该类别目录"
          >
            <AppIcon name="upload" size={12} />
            上传
            <input
              type="file"
              accept={IMAGE_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) { handleImageUpload(file, cat); e.target.value = ""; }
              }}
            />
          </label>
        </div>
        {items.map(renderEntityGroup)}
      </div>
    ));
  };

  // ── 渲染 ──

  const selectedEntity = selectedImage
    ? assetImages.find((g) => g.category === selectedImage.category && g.entity === selectedImage.entity)
    : undefined;

  return (
    <div className="roles-shell flex h-full">
      {/* ── 实体树侧栏 ── */}
      <div className="w-72 border-r border-gray-700 flex flex-col shrink-0">
        <div className="p-2 border-b border-gray-700 space-y-2">
          <div className="flex items-center gap-1.5">
            <SearchInput value={imageFilter} onChange={setImageFilter} placeholder="过滤图片名称…" />
            <ToolIconButton icon="folder" label="打开资产文件夹" onClick={() => void openDataDir()} />
            <ToolIconButton icon="refresh" label="刷新" onClick={() => void loadImages()} />
            <FoldAllButton
              collapsed={entitiesAllCollapsed}
              onToggle={toggleFoldAllEntities}
              what="实体"
              disabled={visibleEntities.length === 0}
            />
          </div>
          <GroupDimensionToggle
            value={dimension}
            onChange={setDimension}
            options={[
              { id: "category", label: "按类别", icon: "images", hint: "按资产类别（characters / classes …）分组" },
              { id: "worldbook", label: "按世界书", icon: "worldbook", hint: "按来源世界书分组" },
            ]}
          />
          {dimension === "category" && (
            <select
              className="w-full bg-gray-800/80 border border-gray-700 rounded-md px-2 py-1 text-[12px] text-gray-300"
              value={bookFilter}
              onChange={(e) => setBookFilter(e.target.value)}
              title="按来源世界书筛选"
            >
              <option value="">全部世界书</option>
              <option value={UNCLASSIFIED_KEY}>未分类</option>
              {worldbooks.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {imagesLoading && assetImages.length === 0 ? (
            <p className="text-gray-500 text-xs text-center py-4">加载中…</p>
          ) : assetImages.length === 0 ? (
            <p className="text-gray-500 text-xs text-center py-4">暂无图像资产</p>
          ) : (
            renderImageTree()
          )}
        </div>
      </div>

      {/* ── 预览面板 ── */}
      <div className="flex-1 flex flex-col min-w-0 bg-gray-900/30">
        {!selectedImage ? (
          <EmptyState
            icon="images"
            text="选择左侧图片预览"
            sub="可设为默认头像 / 立绘 / 卡面，并标注该实体的来源世界书"
          />
        ) : (
          <>
            <PanelHeader
              eyebrow={`资产 · ${selectedImage.category}`}
              icon="images"
              title={selectedImage.entityName}
              actions={<ToolIconButton icon="close" label="关闭预览" onClick={() => setSelectedImage(null)} />}
            />
            <div className="flex-1 overflow-y-auto p-5">
              <div className="max-w-lg mx-auto space-y-4">
                <img
                  src={selectedImage.url}
                  alt={selectedImage.name}
                  className="w-full max-h-96 object-contain rounded-lg bg-gray-900/50 border border-gray-700"
                />
                <dl className="roles-kv">
                  <dt>文件名</dt>
                  <dd className="is-mono">{selectedImage.name}</dd>
                  <dt>大小</dt>
                  <dd>{formatFileSize(selectedImage.size)}</dd>
                  {selectedImage.subdir && (
                    <>
                      <dt>子目录</dt>
                      <dd>{subdirLabel(selectedImage.subdir)}</dd>
                    </>
                  )}
                  <dt>上级目录</dt>
                  <dd className="is-mono">{selectedImage.category}/{selectedImage.entity}</dd>
                  <dt>路径</dt>
                  <dd className="is-mono text-gray-500">{selectedImage.path}</dd>
                  <dt className="self-center">来源世界书</dt>
                  <dd>
                    <WorldbookSelect
                      value={selectedEntity?.worldbook_id || ""}
                      worldbooks={worldbooks}
                      onChange={(id) => { if (selectedEntity) handleSetEntityWorldbook(selectedEntity, id); }}
                    />
                  </dd>
                </dl>

                {/* 设为默认图 */}
                <div className="flex gap-2 justify-center flex-wrap pt-1">
                  {selectedImage.subdir === "avatar" && (
                    <ActionButton
                      icon="star"
                      variant="blue"
                      onClick={() => handleSetDefaultImage(selectedImage.category, selectedImage.entity, "avatar", selectedImage.name)}
                    >
                      设为默认头像
                    </ActionButton>
                  )}
                  {selectedImage.subdir === "skin" && (
                    <ActionButton
                      icon="star"
                      variant="purple"
                      onClick={() => handleSetDefaultImage(selectedImage.category, selectedImage.entity, "skin", selectedImage.name)}
                    >
                      设为默认立绘
                    </ActionButton>
                  )}
                  {(selectedImage.subdir === "avatar" || selectedImage.subdir === "skin") && (
                    <ActionButton
                      icon="cards"
                      variant="amber"
                      onClick={() => handleSetDefaultImage(selectedImage.category, selectedImage.entity, "card_face", selectedImage.name)}
                      title="复制到 card art/ 子目录并设为卡面"
                    >
                      设为卡面
                    </ActionButton>
                  )}
                  {selectedImage.subdir === "card_face" && (
                    <>
                      <ActionButton
                        icon="star"
                        variant="amber"
                        onClick={() => handleSetDefaultImage(selectedImage.category, selectedImage.entity, "card_face", selectedImage.name)}
                      >
                        设为默认卡面
                      </ActionButton>
                      <ActionButton icon="crop" variant="green" onClick={() => setCropTarget(selectedImage)}>
                        裁剪卡面
                      </ActionButton>
                    </>
                  )}
                </div>
                {selectedImage.subdir && selectedImage.subdir !== "avatar" && selectedImage.subdir !== "skin" && selectedImage.subdir !== "card_face" && (
                  <p className="text-xs text-gray-600 text-center">
                    仅 avatar/、skin/ 和 card art/ 子目录的图片可设为默认
                  </p>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {cropTarget && (
        <CropModal
          imageUrl={cropTarget.url}
          onSave={handleCropSave}
          onClose={() => setCropTarget(null)}
        />
      )}

      {toast && (
        <div
          className={`fixed bottom-12 right-4 px-3 py-2 rounded-lg shadow-lg text-sm z-50 ${
            toast.type === "success"
              ? "bg-green-800/90 text-green-100"
              : "bg-red-800/90 text-red-100"
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
