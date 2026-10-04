/**
 * 新建会话向导 — 游戏式分步创建：
 * 模式&战斗模式 → 剧情（可选） → 世界书（可选） → 主控与阵容 → 命名创建
 *
 * **点选剧情即自动选中剧情声明的默认配置**（`pickPlot` → `resolvePlotDefaults`）：
 * frontmatter 的 `worldbook_id` 自动绑定（书没装则保留玩家当前选择），`player_identity`
 * 自动选为主控（缺省回退 `initial_characters` 首位），**该世界书的角色花名册**
 * （各书 `character_ids`）与剧情开场角色整批加入预选队友，并在磁贴上标「自动预选」。
 *
 * **「主控与阵容」这一步只选角色**：候选范围与手动追加不在这里调整
 * （按书配置在世界书工作台里做）。创建时仍与服务端同口径：预览指纹来自
 * `POST /scope-preview`，前端不自己再走一遍遍历，创建会话本身不调用任何 LLM。
 *
 * **主控角色与角色入队是同一次选择**：玩家在「主控与阵容」这一步从同一份候选目录里
 * 挑一个角色当主控（= 本次会话的玩家身份，一切玩家发言/视角都指向它），该角色随即
 * 入队；队友在同一个列表里多选。候选目录来自 `/api/characters`，自建角色与世界书
 * 角色混排并逐条标注来源（选择逻辑见 `CharacterPicker` / `utils/characterCatalog`）。
 *
 * 没有主控就不能创建：向导在「下一步 / 创建」前给出提示，后端对显式空 identity
 * 同样直接 400（`blueprints/sessions.py`），不会静默落到默认身份。
 */
import { useState, useEffect, useMemo } from "react";
import { useAppStore } from "../../stores/appStore";
import { useApi } from "../../hooks/useApi";
import { useDialogMinimize } from "../../hooks/useDialogMinimize";
import { useRosterScopePreview } from "../../hooks/useWorldbookDraft";
import type { SessionCatalog } from "../../hooks/useSessionCatalog";
import {
  buildCharacterCatalog, buildLineup, mainControlError, resolveLineupDefaults,
  resolvePlotDefaults, selectableCatalogItems, summaryText,
} from "../../utils/characterCatalog";
import type { Session } from "../../types";
import CharacterPicker from "./CharacterPicker";
import EntityAvatar, { characterAvatarUrl } from "../roles/EntityAvatar";
import { getBaseUrl } from "../../utils/baseUrl";

interface InstalledCombatMode {
  id: string;
  name: string;
  runtime: "builtin" | "browser";
  enabled: boolean;
  description: string;
  version: string;
}

interface CombatCompatibility {
  compatible: boolean;
  errors: string[];
  binding_digest: string;
  package_digest: string;
  encounters: { id: string; name: string; worldbook_id: string }[];
}

const BUILTIN_COMBAT_MODES = ["narrative", "tactical", "sideview"];

// Kept local: the shared API hook is being edited independently.
async function combatRequest(path: string, signal: AbortSignal, worldbookIds?: string[]) {
  const base = await getBaseUrl();
  const response = await fetch(`${base}/api/combat-modes${path}`, {
    signal,
    ...(worldbookIds ? {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worldbook_ids: worldbookIds }),
    } : {}),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(Array.isArray(body.errors) && body.errors.length
      ? body.errors.join("；") : body.error || `请求失败（HTTP ${response.status}）`);
  }
  return body;
}

interface CreateSessionWizardProps {
  open: boolean;
  catalog: SessionCatalog;
  onClose: () => void;
  /** 创建成功后回调（父组件负责刷新 store 并跳转） */
  onCreated: (session: Session) => void;
}

const STEP_LABELS: Record<string, string> = {
  mode: "模式选择",
  plot: "选择剧情",
  worldbook: "绑定世界书",
  lineup: "主控与阵容",
  finish: "命名创建",
};

const trimKey = (value: string | null | undefined) => (value || "").trim();

export default function CreateSessionWizard({ open, onClose, onCreated, catalog: sessionCatalog }: CreateSessionWizardProps) {
  const chatMode = useAppStore((s) => s.chatMode);
  const { setCurrentView, setCharacterTab } = useAppStore();
  const api = useApi();

  // ── 向导状态 ──
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<"story" | "free">(chatMode);
  const [combatMode, setCombatMode] = useState<string>("narrative");
  const [combatModes, setCombatModes] = useState<InstalledCombatMode[]>([]);
  const [modesLoading, setModesLoading] = useState(true);
  const [modesError, setModesError] = useState("");
  const [modesWarnings, setModesWarnings] = useState<string[]>([]);
  const [modesRetry, setModesRetry] = useState(0);
  const [compatRetry, setCompatRetry] = useState(0);
  const [compatibility, setCompatibility] = useState<{
    key: string; result?: CombatCompatibility; error?: string;
  } | null>(null);
  const [trustedDigest, setTrustedDigest] = useState("");
  /** 主控角色（= 玩家身份）；空串 = 还没选，此时不能创建会话 */
  const [mainControl, setMainControl] = useState("");
  const [plotId, setPlotId] = useState("");
  const [worldbookIds, setWorldbookIds] = useState<string[]>([]);
  const worldbookId = worldbookIds[0] || null;
  const isPlugin = !BUILTIN_COMBAT_MODES.includes(combatMode);
  const selectedPlugin = combatModes.find((item) => item.id === combatMode);
  const compatibilityKey = JSON.stringify([combatMode, selectedPlugin?.version, worldbookIds, compatRetry, modesRetry]);
  const currentCompatibility = compatibility?.key === compatibilityKey ? compatibility : null;
  const compatibleResult = currentCompatibility?.result;
  const trustKey = compatibleResult?.compatible
    ? JSON.stringify([compatibilityKey, compatibleResult.binding_digest, compatibleResult.package_digest]) : "";
  const pluginReady = !isPlugin || (!modesLoading && !modesError && !!selectedPlugin
    && worldbookIds.length > 0 && !!compatibleResult?.compatible
    && !!compatibleResult.binding_digest && !!trustKey && trustedDigest === trustKey);
  /** 队友（场景 NPC）。主控不在此列：主控由 identity 单独声明，避免重复入队 */
  const [teammates, setTeammates] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  // 自动预选：选中剧情 / 绑定世界书时按默认阵容自动勾选的队友名单。用于把「系统预选」和
  // 「玩家自选」在界面上明确区分开——两者此前完全同款，玩家点一下已预选的磁贴其实是在取消。
  const [autoPreset, setAutoPreset] = useState<string[]>([]);

  // ── 数据 ──
  const { plots, books, characters: charDocs, loading, error: catalogError, reload } = sessionCatalog;
  const catalogBlocked = loading || !!catalogError;
  const [plotSearch, setPlotSearch] = useState("");

  // 候选目录：自建 + 世界书角色，唯一的角色数据源（主控与队友共用）
  const catalog = useMemo(() => buildCharacterCatalog(charDocs, books), [charDocs, books]);
  const plot = useMemo(() => plots.find((p) => p.id === plotId) || null, [plots, plotId]);
  const plotBookId = trimKey(plot?.worldbook_id);
  /**
   * 候选 = 已绑定世界书的角色（含**书内角色花名册**）+ 剧情自带阵容；未绑书时 = 自建角色 +
   * 剧情自带阵容。花名册与剧情阵容必须能选：拆分出来的剧情书里，书内条目带 `character_id`，
   * 而角色卡 frontmatter 的 `worldbook_id` 仍记着来源书（如 `arknights`），只按来源书过滤
   * 会让「这本书的角色」整批消失，自动选中与手动挑选都无从谈起。
   */
  const catalogItems = useMemo(
    () => selectableCatalogItems(catalog.items, worldbookIds, plot, books),
    [catalog.items, worldbookIds, plot, books]);
  // 阵容 = 主控 + 队友（去重，主控在前）；这就是提交给后端的入队名单
  const lineup = useMemo(() => buildLineup(mainControl, teammates), [mainControl, teammates]);
  const mainControlItem = catalogItems.find((item) => item.key === mainControl) || null;
  const controlError = mainControlError(mainControl, catalogItems);

  // 最小化：已填内容（步骤/主控/剧情/阵容/名称）保留，与关闭独立
  const dialog = useDialogMinimize("create-session-wizard", "新建会话", open);

  const steps = useMemo(
    () => (mode === "story" ? ["mode", "plot", "worldbook", "lineup", "finish"] : ["mode", "worldbook", "lineup", "finish"]),
    [mode]
  );

  const filteredPlots = useMemo(() => {
    const q = plotSearch.trim().toLowerCase();
    return q ? plots.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)) : plots;
  }, [plots, plotSearch]);

  // 打开时只重置表单。目录与进行中的请求由大厅持有，重试不会清掉选择。
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setMode(useAppStore.getState().chatMode);
    setCombatMode("narrative");
    setMainControl("");
    setPlotId("");
    setWorldbookIds([]);
    setTeammates([]);
    setName("");
    setError("");
    setAutoPreset([]);
    setPlotSearch("");
    setCompatibility(null);
    setTrustedDigest("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    setModesLoading(true);
    setModesError("");
    setModesWarnings([]);
    void combatRequest("", controller.signal).then((body) => {
      if (!Array.isArray(body.modes) || !body.modes.every((item: InstalledCombatMode) =>
        item && typeof item.id === "string" && typeof item.name === "string"
        && ["builtin", "browser"].includes(item.runtime) && typeof item.enabled === "boolean"
        && typeof item.description === "string" && (item.runtime === "builtin" || typeof item.version === "string"))) {
        throw new Error("战斗插件列表格式无效，请重试");
      }
      if (!active) return;
      setCombatModes(body.modes.filter((item: InstalledCombatMode) =>
        item.runtime === "browser" && item.enabled && !BUILTIN_COMBAT_MODES.includes(item.id)));
      setModesWarnings(Array.isArray(body.errors) ? body.errors.map((item: unknown) =>
        typeof item === "string" ? item : JSON.stringify(item)) : []);
    }).catch((err: unknown) => {
      if (active) setModesError(controller.signal.aborted ? "读取战斗插件超时，请重试" : err instanceof Error ? err.message : "读取战斗插件失败");
    }).finally(() => {
      window.clearTimeout(timeout);
      if (active) setModesLoading(false);
    });
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [open, modesRetry]);

  useEffect(() => {
    setCompatibility(null);
    setTrustedDigest("");
    if (!open || !isPlugin || !selectedPlugin || modesLoading || modesError || !worldbookIds.length) return;
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    void combatRequest(`/${encodeURIComponent(combatMode)}/compatibility`, controller.signal, worldbookIds)
      .then((body: CombatCompatibility) => {
        if (typeof body.compatible !== "boolean" || !Array.isArray(body.errors)
          || !body.errors.every((item) => typeof item === "string")
          || (body.compatible && (body.errors.length > 0 || !Array.isArray(body.encounters)
            || typeof body.binding_digest !== "string" || !body.binding_digest
            || typeof body.package_digest !== "string" || !body.package_digest))) {
          throw new Error("插件预检返回无效结果，请重试");
        }
        // Rejected bindings have errors only; no usable digests exist in that case.
        if (active) setCompatibility({ key: compatibilityKey, result: body.compatible ? body : {
          compatible: false, errors: body.errors, binding_digest: "", package_digest: "", encounters: [],
        } });
      }).catch((err: unknown) => {
        if (active) setCompatibility({ key: compatibilityKey,
          error: controller.signal.aborted ? "插件预检超时，请重试" : err instanceof Error ? err.message : "插件预检失败" });
      }).finally(() => window.clearTimeout(timeout));
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [open, isPlugin, selectedPlugin, modesLoading, modesError, combatMode, worldbookIds, compatibilityKey]);

  // 阵容变化后重新解析候选范围：防抖 + 过时响应保护（旧响应不会覆盖新结果）。
  // 预览用**完整阵容**（含主控），与服务端 `SceneManager.get_roster()` 同口径，
  // 否则创建时的指纹校验会判定预览过期。
  // 书的配置在世界书工作台里调整；创建时按空追加解析，与预览保持一致。
  const { previews: scopePreviews, loading: scopeLoading, error: scopeError } = useRosterScopePreview(
    worldbookIds, lineup, [],
    open && worldbookIds.length > 0,
  );

  if (!open) return null;

  const current = steps[step];
  const isLast = step === steps.length - 1;
  // 当前阵容里仍保留的自动预选角色（玩家取消掉的不再计入）
  const presetSelected = lineup.filter((key) => autoPreset.includes(key));
  const plotLabel = plots.find((p) => p.id === plotId)?.name || plotId;
  const itemName = (key: string) => catalogItems.find((item) => item.key === key)?.name || key;

  /**
   * 改世界书绑定（世界书步骤里手动勾选）。
   *
   * 只做「摘掉已经不在候选里的选择」，**不**替玩家重算阵容：自动选中发生在选中剧情那一刻
   * （按剧情声明的那本书的花名册），手动再加一本可能是几百角色的大书时静默塞满阵容是灾难；
   * 要按当前绑定书全选，走队友区那个显式按钮。
   */
  const applyBooks = (next: string[]) => {
    const allowed = new Set(
      selectableCatalogItems(catalog.items, next, plot, books).map((item) => item.key));
    setWorldbookIds(next);
    if (mainControl && !allowed.has(mainControl)) setMainControl("");
    setTeammates((current) => current.filter((key) => allowed.has(key)));
    setAutoPreset((current) => current.filter((key) => allowed.has(key)));
  };

  /**
   * 显式全选：把**当前绑定世界书**的角色花名册并进阵容（去重、不含主控）。
   *
   * 只有点这个按钮才按「全部绑定书」取花名册 —— 绑定大书时不会静默塞进几十个队友。
   */
  const selectAllBookCharacters = () => {
    setError("");
    const defaults = resolveLineupDefaults(worldbookIds, plot, books, catalog.items);
    const main = mainControl || defaults.main;
    if (!mainControl && defaults.main) setMainControl(defaults.main);
    setTeammates((current) =>
      [...new Set([...current, ...defaults.teammates])].filter((key) => key !== main));
    setAutoPreset((current) => [...new Set([...current, ...defaults.teammates])]);
  };

  /** 选定主控：同时把它从队友里摘掉（同一个角色不走两条入队路径）。 */
  const selectMainControl = (key: string) => {
    setError("");
    setMainControl(key);
    setTeammates((prev) => prev.filter((item) => item !== key));
  };

  const toggleTeammate = (key: string) => {
    if (key === mainControl) return;   // 主控已在阵容里，队友列表不再重复收
    setTeammates((prev) => (prev.includes(key) ? prev.filter((n) => n !== key) : [...prev, key]));
  };

  /**
   * 点选剧情：自动绑定剧情声明的世界书，并把**这本书的角色花名册 + 剧情开场角色**整批选中
   * （主控取剧情 `player_identity`，见 `resolvePlotDefaults` / `resolveLineupDefaults`）。
   *
   * 「不绑定」不清掉玩家自己挑的角色：只撤销自动预选标记，并把已经不在候选里的
   * 主控 / 队友摘掉（花名册与剧情阵容带来的角色可能随剧情一起失效）。
   */
  const pickPlot = (id: string) => {
    setError("");
    setPlotId(id);
    const next = id ? plots.find((p) => p.id === id) || null : null;
    if (!next) {
      const allowed = new Set(
        selectableCatalogItems(catalog.items, worldbookIds, null, books).map((item) => item.key));
      setAutoPreset([]);
      if (mainControl && !allowed.has(mainControl)) setMainControl("");
      setTeammates((current) => current.filter((key) => allowed.has(key)));
      return;
    }
    const defaults = resolvePlotDefaults(next, books, catalog.items, worldbookIds);
    setWorldbookIds(defaults.books);
    setMainControl(defaults.main);
    setTeammates(defaults.teammates);
    setAutoPreset(defaults.teammates);
  };

  const goNext = () => {
    if (creating || (current !== "mode" && catalogBlocked)) return;
    setError("");
    // 主控是必选项：没选就不放行（前端先拦，后端另有兜底校验）
    if (current === "lineup" && controlError) {
      setError(controlError);
      return;
    }
    if (isLast) {
      if (!pluginReady) {
        setError("请完成战斗插件兼容性预检，并确认信任插件脚本后再创建");
        return;
      }
      if (controlError) {
        setError(controlError);
        return;
      }
      if (worldbookIds.length && (scopeLoading || scopeError || worldbookIds.some((id) => !scopePreviews[id]))) {
        setError(scopeError || "世界书载入范围还在计算，请稍后再创建");
        return;
      }
      void handleCreate();
      return;
    }
    setStep((s) => s + 1);
  };

  const handleCreate = async () => {
    if (!pluginReady) return;
    setCreating(true);
    setError("");
    try {
      // 主控通过 identity 声明（它同时是阵容首位），队友通过 roster_character_ids 入队；
      // 后端把两者合成阵容（`SceneManager.get_roster()`），同一角色只算一次。
      // 世界书绑定、角色入队与候选条目范围由服务端完成，首轮不会全量载入。
      // 提交空追加，与预览同一口径。
      // 带上预览指纹：预览已过期时宁可报错，也不静默用一套不同的范围创建会话。
      const session = await api.createSession(
        mode, name.trim(), mode === "story" ? plotId : "", combatMode,
        mainControl, worldbookIds, teammates, {},
        Object.fromEntries(worldbookIds.map((id) => [id, scopePreviews[id]?.draft_hash || ""])),
        ...(isPlugin ? [{ combat_binding_digest: compatibleResult!.binding_digest, trust_combat_plugin: true }] : []),
      );
      onCreated(session);
    } catch (err: any) {
      setError(err?.message || "创建失败");
      setCreating(false);
    }
  };

  return (
    <div className={`wizard-overlay ${dialog.minimizedClass}`} onClick={onClose}>
      <div
        ref={dialog.containerRef}
        tabIndex={-1}
        className="wizard-panel outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700/70 shrink-0">
          <div>
            <h2 className="text-lg font-bold text-amber-300">新建会话</h2>
            <p className="text-[12px] text-gray-500 mt-0.5">按步骤配置你的故事开端</p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={dialog.minimize}
              className="text-gray-500 hover:text-gray-300 text-xl leading-none px-2"
              title="最小化（保留已填内容）"
              aria-label="最小化对话框"
            >
              —
            </button>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-300 text-xl leading-none px-2"
              title="关闭"
              aria-label="关闭对话框"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Steps indicator */}
        <div className="flex items-center gap-2 px-6 py-3 border-b border-gray-700/50 shrink-0">
          {steps.map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div className={`step-dot ${i === step ? "active" : i < step ? "done" : ""}`}>
                {i < step ? "✓" : i + 1}
              </div>
              <span className={`step-label ${i === step ? "active" : i < step ? "done" : ""} hidden sm:inline`}>
                {STEP_LABELS[s]}
              </span>
              {i < steps.length - 1 && <div className="w-6 h-px bg-gray-700" />}
            </div>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 lobby-scroll">
          {loading && (
            <p className="py-3 text-sm text-gray-300" role="status">{current === "mode" ? "正在准备剧情、世界书与角色，可先选择模式。" : "正在加载剧情、世界书与角色…"}</p>
          )}
          {catalogError && <div className="mb-4 text-sm text-red-300" role="alert"><p>{catalogError}</p><button type="button" className="btn btn-ghost mt-2 px-3 py-2" onClick={() => { void reload(); }} disabled={loading}>重新加载目录</button></div>}

          {current === "mode" && (
            <div className="space-y-4">
              <p className="text-xs text-gray-400">选择会话模式与战斗模式（创建后不可更改）</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div
                  className={`pick-card p-4 ${mode === "story" ? "selected" : ""}`}
                  onClick={() => { setMode("story"); setPlotId(""); }}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-xl">📖</span>
                    <span className="font-semibold text-amber-300">剧情模式</span>
                  </div>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    LLM 驱动的完整叙事：绑定主线剧情、任务推进、场景切换与自动叙述。
                  </p>
                </div>
                <div
                  className={`pick-card p-4 ${mode === "free" ? "selected" : ""}`}
                  onClick={() => setMode("free")}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-xl">🕊️</span>
                    <span className="font-semibold text-purple-300">自由模式</span>
                  </div>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    开放沙盒角色扮演：不绑定剧情，自由选择角色与场景。
                  </p>
                </div>
              </div>

              <div>
                <p className="text-xs text-gray-400 mb-2">战斗模式</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div
                    className={`pick-card p-3 ${combatMode === "narrative" ? "selected" : ""}`}
                    onClick={() => setCombatMode("narrative")}
                    role="button"
                    tabIndex={0}
                    aria-pressed={combatMode === "narrative"}
                    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setCombatMode("narrative"); } }}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm">📜</span>
                      <span className="text-sm font-medium text-blue-300">纯剧情叙述</span>
                    </div>
                    <p className="text-[12px] text-gray-500">战斗由叙述呈现，不进入战术回合制。</p>
                  </div>
                  <div
                    className={`pick-card p-3 ${combatMode === "tactical" ? "selected" : ""}`}
                    onClick={() => setCombatMode("tactical")}
                    role="button"
                    tabIndex={0}
                    aria-pressed={combatMode === "tactical"}
                    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setCombatMode("tactical"); } }}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm">⚔️</span>
                      <span className="text-sm font-medium text-orange-300">战术模式</span>
                    </div>
                    <p className="text-[12px] text-gray-500">对话中触发战斗时进入自由尺寸网格的回合制战斗。</p>
                  </div>
                  <div
                    className={`pick-card p-3 ${combatMode === "sideview" ? "selected" : ""}`}
                    onClick={() => setCombatMode("sideview")}
                    role="button"
                    tabIndex={0}
                    aria-pressed={combatMode === "sideview"}
                    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setCombatMode("sideview"); } }}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm">✦</span>
                      <span className="text-sm font-medium text-cyan-300">横版动作关卡</span>
                    </div>
                    <p className="text-[12px] text-gray-500">剧情中进入独立关卡，移动、跳跃、闪避、攻击与释放技能。</p>
                  </div>
                  {!modesLoading && !modesError && combatModes.map((item) => (
                    <button key={item.id} type="button"
                      className={`pick-card p-3 text-left min-w-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300 ${combatMode === item.id ? "selected" : ""}`}
                      aria-pressed={combatMode === item.id}
                      onClick={() => setCombatMode(item.id)}>
                      <span className="flex flex-wrap items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-cyan-300 break-words">{item.name}</span>
                        <span className="text-xs text-gray-300 break-all">v{item.version}</span>
                      </span>
                      <span className="block text-xs text-gray-400 leading-relaxed break-words">{item.description || "已安装的浏览器战斗插件"}</span>
                      <span className="block text-xs text-amber-300 mt-2">插件 · 需世界书预检与脚本信任</span>
                    </button>
                  ))}
                </div>
                {modesLoading && <p className="mt-3 text-xs text-gray-300" role="status">正在读取已安装战斗插件…内置模式仍可选择。</p>}
                {!modesLoading && !modesError && combatModes.length === 0 && modesWarnings.length === 0 && (
                  <p className="mt-3 text-xs text-gray-400">暂无已启用的浏览器战斗插件，可使用以上内置模式。</p>
                )}
              </div>
            </div>
          )}

          {!catalogBlocked && current === "plot" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-400">选择要绑定的剧情（可选）· 选中后自动绑定世界书并预选主控与队友</p>
                <input
                  className="input text-xs w-48"
                  placeholder="搜索剧情..."
                  value={plotSearch}
                  onChange={(e) => setPlotSearch(e.target.value)}
                />
              </div>
              <div
                className={`pick-card p-3 ${plotId === "" ? "selected" : ""}`}
                onClick={() => pickPlot("")}
              >
                <span className="text-sm text-gray-300 font-medium">不绑定</span>
                <span className="text-[12px] text-gray-500 ml-2">自由探索，不加载任何剧情</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-72 overflow-y-auto lobby-scroll pr-1">
                {filteredPlots.map((p) => {
                  const declaredBook = trimKey(p.worldbook_id);
                  const boundBook = declaredBook ? books.find((b) => b.id === declaredBook) : null;
                  return (
                    <div
                      key={p.id}
                      className={`pick-card p-3 ${plotId === p.id ? "selected" : ""}`}
                      onClick={() => pickPlot(p.id)}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-gray-200 truncate">{p.name}</span>
                        <span className={`badge ${p.category === "main" ? "badge-plot" : "badge-story"}`}>
                          {p.category === "main" ? "主线" : p.category}
                        </span>
                      </div>
                      <div className="text-[11px] text-gray-600 mt-1">{p.id}</div>
                      {/* 自动选中的内容如实标注：绑定哪本书（几名角色）、默认主控是谁 */}
                      {declaredBook && (
                        <div className={`text-[11px] mt-1 ${boundBook ? "text-amber-300" : "text-gray-500"}`}>
                          {boundBook
                            ? `自动绑定世界书：${boundBook.name}${boundBook.character_ids?.length
                              ? `（${boundBook.character_ids.length} 名角色一并选中）` : ""}`
                            : `声明的世界书「${declaredBook}」未安装，绑定保留当前选择`}
                        </div>
                      )}
                      {!!trimKey(p.player_identity) && (
                        <div className="text-[11px] text-amber-300 mt-1">默认主控：{trimKey(p.player_identity)}</div>
                      )}
                      {!!p.initial_characters?.length && (
                        <div className="text-[11px] text-cyan-300 mt-1">
                          开场角色 {p.initial_characters.length} 名 · 选中后自动预选入队
                        </div>
                      )}
                    </div>
                  );
                })}
                {filteredPlots.length === 0 && (
                  <p className="text-gray-500 text-sm col-span-2 text-center py-6">暂无可用剧情</p>
                )}
              </div>
            </div>
          )}

          {!catalogBlocked && current === "worldbook" && (
            <div className="space-y-3">
              <p className="text-xs text-gray-300">选择本会话使用的剧情世界书，可多选。未选时不载入世界书；资料库不参与会话。</p>
              {plot && plotBookId && worldbookIds.includes(plotBookId) && (
                <p className="text-[12px] text-cyan-300" role="status">
                  已按《{plotLabel}》自动绑定：{books.find((b) => b.id === plotBookId)?.name || plotBookId}
                </p>
              )}
              {!!plot && <p className="text-[12px] text-gray-500">
                已选剧情：自动选中的是剧情声明那本书的角色；这里再手动加书只扩候选，要一并选上走「按绑定世界书全选角色」。
              </p>}
              <p className="text-xs text-amber-300" role="status">已选 {worldbookIds.length} 本{worldbookIds.length ? `：${worldbookIds.map((id) => books.find((b) => b.id === id)?.name || id).join("、")}` : " · 不使用世界书"}</p>
              {!!worldbookIds.length && <button type="button" className="text-xs text-blue-300 hover:underline" onClick={() => applyBooks([])}>清空选择</button>}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-72 overflow-y-auto lobby-scroll pr-1">
                {books.map((b) => (
                  <button type="button"
                    key={b.id}
                    aria-pressed={worldbookIds.includes(b.id)}
                    className={`pick-card p-3 text-left ${worldbookIds.includes(b.id) ? "selected" : ""}`}
                    onClick={() => applyBooks(worldbookIds.includes(b.id)
                      ? worldbookIds.filter((id) => id !== b.id) : [...worldbookIds, b.id])}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-gray-200 truncate">{b.name}</span>
                      <span className="text-xs text-amber-300">{worldbookIds.includes(b.id) ? "✓ 已选" : "选择"}</span>
                    </div>
                    <div className="text-[11px] text-gray-600 mt-1">
                      {b.entry_count} 条目 · 预算 {b.budget_tokens} tokens · {b.source_format}
                      {!!b.character_ids?.length && ` · ${b.character_ids.length} 名角色`}
                    </div>
                  </button>
                ))}
                {books.length === 0 && (
                  <p className="text-gray-500 text-sm col-span-2 text-center py-6">暂无世界书，可前往「世界书」页面创建</p>
                )}
              </div>
            </div>
          )}

          {!catalogBlocked && current === "lineup" && (
            <div className="space-y-4">
              {/* ① 主控角色：唯一的「玩家身份」选择入口，选中即入队 */}
              <section className="space-y-2" aria-label="主控角色">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-gray-400">
                    <span className="text-amber-300 font-medium">主控角色</span>
                    {" "}— 你将以该角色身份参与对话。
                  </p>
                  <button
                    type="button"
                    onClick={() => { setCharacterTab("characters"); setCurrentView("characters"); onClose(); }}
                    className="text-[12px] px-2 py-1 rounded bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors"
                  >
                    去角色库创建角色
                  </button>
                </div>

                {mainControlItem ? (
                  <div className="pick-card p-3 flex items-center gap-3 selected">
                    <EntityAvatar name={mainControlItem.name} src={characterAvatarUrl(mainControlItem.key)} size={40} />
                    <div
                      className="group relative min-w-0 flex-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70"
                      tabIndex={0}
                      aria-describedby="selected-main-control-description"
                    >
                      <div className="text-sm font-medium text-gray-200 truncate">
                        {mainControlItem.name}
                        <span className="badge badge-narrative ml-2">本次主控 · 玩家身份</span>
                        <span className="badge badge-wb ml-1.5">已入队</span>
                      </div>
                      <span
                        id="selected-main-control-description"
                        role="tooltip"
                        className="pointer-events-none absolute left-0 top-full z-30 mt-1 hidden max-w-md rounded-lg bg-gray-950 px-3 py-2 text-[11px] leading-relaxed text-gray-200 shadow-lg group-hover:block group-focus-visible:block"
                      >
                        <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-amber-300">人物简介</span>
                        {summaryText(mainControlItem)}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setMainControl("")}
                      className="text-[12px] text-gray-400 hover:text-gray-200 px-2 py-1 rounded bg-gray-700/60"
                    >
                      取消选择
                    </button>
                  </div>
                ) : (
                  <p className="text-[12px] text-amber-300" role="alert">
                    还没选主控：选一个角色才能创建会话。
                  </p>
                )}

                <CharacterPicker
                  items={catalogItems}
                  mode="single"
                  selected={mainControl ? [mainControl] : []}
                  onSelect={selectMainControl}
                  preferredBookId={worldbookId}
                  skippedCount={catalog.skipped}
                  selectedBadge="本次主控"
                  searchPlaceholder="搜索角色（自建 / 世界书）..."
                  showSearch={false}
                  showSourceFilters={false}
                  descriptionOnHover
                  emptyText="暂无可用角色，可前往「角色」页面导入角色卡"
                  listClassName="max-h-60"
                />
              </section>

              {/* ② 队友入队：与主控共用同一份候选目录与选择逻辑 */}
              <section className="space-y-2 pt-1 border-t border-gray-700/60" aria-label="队友入队">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-gray-400">
                    <span className="text-gray-200 font-medium">队友入队</span>
                    {" "}— 一起进入场景的其他角色
                    {teammates.length > 0 && <span className="text-amber-300">
                      {" "}— 已选 {teammates.length} 名
                    </span>}
                  </p>
                  {/* 手动全选：只有点它才按「全部已绑定世界书」取花名册，避免绑上大书就静默塞满阵容 */}
                  {!!worldbookIds.length && (
                    <button
                      type="button"
                      onClick={selectAllBookCharacters}
                      title="把当前已绑定世界书的角色全部加入阵容（按各书内角色花名册，不含主控）"
                      className="text-[12px] px-2 py-1 rounded bg-gray-700/60 text-gray-300 hover:bg-gray-700 transition-colors"
                    >
                      按绑定世界书全选角色
                    </button>
                  )}
                </div>

                {teammates.length === 0 && (
                  <p className="text-[12px] text-amber-300" role="alert">
                    {mode === "story" && plotId
                      ? "队友为空：本次会话只会载入主控角色。剧情开场角色只在未指定阵容时由服务端补齐，这里显式留空就不会补。"
                      : "队友为空：本次会话只载入主控角色，创建后可到会话大厅的「角色阵容」入队。"}
                  </p>
                )}

                <CharacterPicker
                  items={catalogItems}
                  mode="multi"
                  selected={teammates}
                  onSelect={toggleTeammate}
                  lockedKeys={mainControl ? [mainControl] : []}
                  lockedLabel="主控（已在阵容）"
                  preferredBookId={worldbookId}
                  selectedBadge="已入队"
                  searchPlaceholder="搜索队友（自建 / 世界书）..."
                  showSearch={false}
                  showSourceFilters={false}
                  descriptionOnHover
                  emptyText="暂无可用角色，可前往「角色」页面导入角色卡"
                  listClassName="max-h-60"
                />
              </section>

            </div>
          )}

          {!catalogBlocked && current === "finish" && (
            <div className="space-y-4">
              <div>
                <p className="text-xs text-gray-400 mb-1.5">会话名称</p>
                <input
                  className="input text-sm"
                  placeholder={mode === "story" && plotId ? (plots.find((p) => p.id === plotId)?.name || "未命名会话") : "未命名会话"}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="detail-section p-4 space-y-2">
                <p className="text-[12px] text-gray-500 tracking-wider">配置预览</p>
                <div className="flex flex-wrap gap-2">
                  <span className={`badge ${mode === "story" ? "badge-story" : "badge-free"}`}>
                    {mode === "story" ? "📖 剧情模式" : "🕊️ 自由模式"}
                  </span>
                  <span className="badge badge-narrative">
                    🎭 主控（玩家身份）：{mainControl ? itemName(mainControl) : "未选择"}
                  </span>
                  <span className={`badge ${combatMode !== "narrative" ? "badge-tactical" : "badge-narrative"}`}>
                    {isPlugin ? `${selectedPlugin?.name || combatMode} · v${selectedPlugin?.version || "未知"}` : combatMode === "tactical" ? "⚔️ 战术模式" : combatMode === "sideview" ? "✦ 横版动作" : "📜 纯剧情"}
                  </span>
                  {isPlugin && compatibleResult?.compatible && (
                    <span className="badge badge-wb">兼容遭遇 {compatibleResult.encounters.length} 个</span>
                  )}
                  {mode === "story" && plotId && (
                    <span className="badge badge-plot">🗺 {plots.find((p) => p.id === plotId)?.name || plotId}</span>
                  )}
                  {worldbookIds.map((id) => <span key={id} className="badge badge-wb">📖 {books.find((b) => b.id === id)?.name || id}</span>)}
                  {lineup.length > 0 && (
                    <>
                      <span className="badge badge-narrative">👥 阵容 {lineup.length} 名（含主控）</span>
                      {presetSelected.length > 0 && (
                        <span className="badge badge-wb">✓ 自动预选 {presetSelected.length} 名</span>
                      )}
                      <p className="text-[12px] text-gray-400 w-full mt-1">
                        角色：{lineup.map((key) =>
                          itemName(key)
                          + (key === mainControl ? "（主控）" : (autoPreset.includes(key) ? "（自动预选）" : ""))
                        ).join("、")}
                      </p>
                    </>
                  )}
                </div>
              </div>
              {/* 命名创建只报「估算 token」：候选条目明细与「候选规模减少」在世界书工作台看，
                  这里不再重复一遍，也就不会再出现「减少 0 token（0%）」这种无信息量的行 */}
              {worldbookIds.length ? worldbookIds.map((id) => (
                <div key={id} className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-gray-300">{books.find((b) => b.id === id)?.name || id}</span>
                  {scopePreviews[id]
                    ? <span className="text-gray-200">估算 token <b>{scopePreviews[id].resolved_estimated_tokens.toLocaleString()}</b></span>
                    : <span className="text-gray-400">{scopeError || "计算中…"}</span>}
                </div>
              )) : <p className="text-xs text-gray-400">未绑定世界书：此次会话不会载入世界书条目。</p>}
              {error && <p className="text-xs text-red-400">{error}</p>}
            </div>
          )}
          {(current === "mode" || isPlugin) && (modesError || modesWarnings.length > 0) && (
            <div className="mt-4 rounded-lg border border-amber-400/30 bg-gray-900/40 p-3 text-xs space-y-2" role="alert">
              {modesError && <p className="text-red-300">已安装战斗插件读取失败：{modesError}。内置模式仍可使用。</p>}
              {modesWarnings.length > 0 && <>
                <p className="text-amber-300">部分战斗插件未能载入：</p>
                <ul className="list-disc pl-4 text-amber-200 space-y-1 break-words">{modesWarnings.map((message, index) => <li key={index}>{message}</li>)}</ul>
              </>}
              <button type="button" className="btn btn-ghost px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300"
                disabled={modesLoading || creating} onClick={() => { setModesLoading(true); setModesRetry((value) => value + 1); }}>
                {modesLoading ? "正在重试…" : "重新读取战斗插件"}
              </button>
            </div>
          )}
          {isPlugin && (
            <section className="mt-4 detail-section p-4 space-y-3 text-xs" aria-label="战斗插件兼容性与信任">
              <h3 className="text-sm font-medium text-cyan-300">{selectedPlugin?.name || combatMode} · 世界书兼容性预检</h3>
              <div aria-live="polite" className="space-y-2">
                {modesLoading ? <p className="text-gray-300">正在确认插件是否可用…</p>
                  : modesError ? <p className="text-red-300">插件列表读取失败，请先重试。</p>
                  : !selectedPlugin ? <p className="text-red-300">此插件已停用或不可用，请返回模式选择。</p>
                  : !worldbookIds.length ? <p className="text-amber-300">请在「绑定世界书」步骤选择至少一本世界书。可以继续配置，但预检通过前不能创建。</p>
                  : !currentCompatibility ? <p className="text-gray-300" role="status">正在静态检查所选世界书中的战斗遭遇…</p>
                  : currentCompatibility.error ? <p className="text-red-300" role="alert">{currentCompatibility.error}</p>
                  : compatibleResult?.compatible ? <p className="text-emerald-300">预检通过 · 兼容遭遇 {compatibleResult.encounters.length} 个</p>
                  : <div className="text-red-300" role="alert">
                    <p>当前世界书与插件不兼容：</p>
                    <ul className="list-disc pl-4 mt-1 space-y-1 break-words">{(compatibleResult?.errors.length ? compatibleResult.errors : ["预检未通过，请检查世界书的战斗遭遇配置"]).map((message, index) => <li key={index}>{message}</li>)}</ul>
                  </div>}
              </div>
              {!!selectedPlugin && !modesLoading && !modesError && worldbookIds.length > 0 && currentCompatibility && (
                <button type="button" className="btn btn-ghost px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300"
                  disabled={creating} onClick={() => { setCompatibility(null); setTrustedDigest(""); setCompatRetry((value) => value + 1); }}>重新预检</button>
              )}
              <p className="text-gray-400 leading-relaxed">静态预检不会执行脚本，也不代表脚本安全。进入战斗将运行插件提供的浏览器脚本，请只信任可靠来源；创建时服务端会重新预检并校验摘要。</p>
              <label className={`flex items-start gap-2 leading-relaxed ${!trustKey || modesLoading || !!modesError ? "text-gray-500" : "text-amber-200"}`}>
                <input type="checkbox" className="mt-0.5 accent-amber-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300"
                  checked={!!trustKey && trustedDigest === trustKey}
                  disabled={!trustKey || modesLoading || !!modesError || creating}
                  onChange={(event) => setTrustedDigest(event.target.checked ? trustKey : "")} />
                我信任此战斗插件的脚本，并同意在本会话中运行。
              </label>
            </section>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-gray-700/70 shrink-0">
          <button
            onClick={onClose}
            className="text-xs text-gray-500 hover:text-gray-300 px-3 py-1.5 rounded transition-colors"
          >
            取消
          </button>
          {/* 错误条：任何步骤的提示都在按钮旁可见（例如「还没选主控」） */}
          {error && <p className="text-xs text-red-400 flex-1 text-right" role="alert">{error}</p>}
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                disabled={creating}
                className="text-xs px-4 py-2 rounded-lg bg-gray-700/60 text-gray-300 hover:bg-gray-700 transition-colors"
              >
                上一步
              </button>
            )}
            <button
              onClick={goNext}
              disabled={creating || (current !== "mode" && catalogBlocked) || (isLast && (!!controlError || !pluginReady))}
              title={isLast ? controlError || (!pluginReady ? "请先完成插件预检并确认信任脚本" : undefined) : undefined}
              className={`btn px-6 py-2 text-sm ${isLast ? "btn-hero" : "bg-blue-600 hover:bg-blue-500 text-white"}`}
            >
              {creating ? "创建中..." : isLast ? "创建并进入" : "下一步"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
