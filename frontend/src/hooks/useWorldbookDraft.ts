import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "./useApi";
import type {
  WorldBookCategoryDTO, WorldBookConfigurationDraft, WorldBookDetail,
  WorldBookDependencyEdgeDTO, WorldBookRootDTO, WorldBookScopePreviewDTO,
} from "../types";

/**
 * 统一草稿：分类、角色关联、起点规则与依赖边**共用同一份草稿**，
 * 走同一条校验/预览/撤销/保存路径，并由 `PUT /configuration` 一次原子写入。
 *
 * 这不是「把多次旧保存请求串起来」——只有一个 draft 对象、一次提交；
 * 保存失败或版本冲突（409）时草稿原样保留，不会因为重新加载而丢失。
 */
export interface WorldBookDraft {
  categories: WorldBookCategoryDTO[];
  entry_moves: Record<string, string>;
  entry_updates: Record<string, { category_id?: string; character_id?: string }>;
  scope_mode: "selective";
  roots: WorldBookRootDTO[];
  requires_edges: WorldBookDependencyEdgeDTO[];
  related_edges: WorldBookDependencyEdgeDTO[];
}

export const draftFrom = (detail: WorldBookDetail): WorldBookDraft => ({
  categories: detail.categories ? [...detail.categories] : [],
  entry_moves: {},
  entry_updates: {},
  scope_mode: detail.scope_mode,
  roots: detail.dependency_rules.roots.map((root) => ({ ...root })),
  requires_edges: detail.dependency_edges ? [...detail.dependency_edges] : [],
  related_edges: detail.related_edges ? [...detail.related_edges] : [],
});

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function withoutMissingEntries(draft: WorldBookDraft, validUids: Set<string>): WorldBookDraft {
  return {
    ...draft,
    roots: draft.roots.filter((root) => validUids.has(root.entry_uid)),
    requires_edges: draft.requires_edges.filter((edge) => validUids.has(edge.from_uid) && validUids.has(edge.to_uid)),
    related_edges: draft.related_edges.filter((edge) => validUids.has(edge.from_uid) && validUids.has(edge.to_uid)),
    entry_moves: Object.fromEntries(Object.entries(draft.entry_moves).filter(([uid]) => validUids.has(uid))),
    entry_updates: Object.fromEntries(Object.entries(draft.entry_updates).filter(([uid]) => validUids.has(uid))),
  };
}

export function useWorldbookDraft(detail: WorldBookDetail | null) {
  const api = useApi();
  const [draft, setDraft] = useState<WorldBookDraft | null>(() => (detail ? draftFrom(detail) : null));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [baseline, setBaseline] = useState<WorldBookDraft | null>(() => (detail ? draftFrom(detail) : null));
  const [baselineRevision, setBaselineRevision] = useState(detail?.import_config?.revision ?? 0);
  const draftRef = useRef(draft);
  const baselineRef = useRef(baseline);
  const baselineRevisionRef = useRef(baselineRevision);
  const latestServerBaselineRef = useRef(baseline);
  const latestServerRevisionRef = useRef(baselineRevision);
  const bookRef = useRef(detail?.id || "");
  draftRef.current = draft;

  // 外部条目/排序/元信息写入也会推进配置 revision。刷新基线时保留用户尚未
  // 保存的节点草稿；换书或当前草稿干净时才采用服务器配置。
  const bookId = detail?.id || "";
  const revision = detail?.import_config?.revision ?? 0;
  useEffect(() => {
    const next = detail ? draftFrom(detail) : null;
    const nextRevision = detail?.import_config?.revision ?? 0;
    latestServerBaselineRef.current = next;
    latestServerRevisionRef.current = nextRevision;
    const switched = bookRef.current !== bookId;
    const current = draftRef.current;
    const previousBaseline = baselineRef.current;
    const hadUnsavedChanges = !switched && !!current && !!previousBaseline && !same(current, previousBaseline);
    bookRef.current = bookId;
    if (switched || !hadUnsavedChanges) {
      baselineRef.current = next; baselineRevisionRef.current = nextRevision;
      setBaseline(next); setBaselineRevision(nextRevision); setDraft(next);
      setError(""); setConflict(false);
      return;
    }
    if (next && previousBaseline && current) {
      const validUids = new Set((detail?.entries || []).map((entry) => entry.uid));
      const prunedPrevious = withoutMissingEntries(previousBaseline, validUids);
      if (same(next, previousBaseline) || same(next, prunedPrevious)) {
        const kept = same(next, prunedPrevious) ? withoutMissingEntries(current, validUids) : current;
        baselineRef.current = next; baselineRevisionRef.current = nextRevision;
        setBaseline(next); setBaselineRevision(nextRevision); setDraft(kept);
        setError(""); setConflict(false);
        return;
      }
    }
    // 真正的配置并发修改不能借一次外部 revision 推进绕过 CAS。
    setConflict(true);
    setError("配置已在别处变更；当前草稿已保留，请撤销并重新编辑后再保存");
  }, [bookId, revision, detail]);

  const dirty = !!draft && !!baseline && !same(draft, baseline);

  const patch = useCallback((changes: Partial<WorldBookDraft>) => {
    setDraft((current) => (current ? { ...current, ...changes } : current));
  }, []);

  /** 撤销：回到服务端已保存的版本（不是回到上一次编辑）。 */
  const undo = useCallback(() => {
    const latest = latestServerBaselineRef.current;
    const latestRevision = latestServerRevisionRef.current;
    baselineRef.current = latest; baselineRevisionRef.current = latestRevision;
    setBaseline(latest); setBaselineRevision(latestRevision);
    setDraft(latest ? { ...latest } : null);
    setError("");
    setConflict(false);
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    if (!detail || !draft || saving) return false;
    setSaving(true); setError(""); setConflict(false);
    try {
      const submitted = draft;
      const result = await api.putWorldbookConfiguration(detail.id, {
        ...buildSaveBody(draft),
        expected_revision: baselineRevision,
      });
      const next = draftFrom(result.book);
      baselineRef.current = next; baselineRevisionRef.current = result.policy_revision;
      latestServerBaselineRef.current = next; latestServerRevisionRef.current = result.policy_revision;
      setBaseline(next); setBaselineRevision(result.policy_revision);
      setDraft((current) => same(current, submitted) ? next : current);
      setSavedAt(Date.now());
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : "保存失败";
      // 冲突与失败都保留草稿：用户可以重新加载对照，或改完再存。
      if (/409|已变更/.test(message)) setConflict(true);
      setError(message);
      return false;
    } finally {
      setSaving(false);
    }
  }, [api, detail, draft, saving, baseline, baselineRevision]);

  return { draft, setDraft, patch, dirty, saving, error, conflict, savedAt, save, undo, baseline };
}

/** 保存与预览共用完整的 v3 配置草稿。 */
export const buildSaveBody = (
  draft: WorldBookDraft,
): WorldBookConfigurationDraft => {
  const body: WorldBookConfigurationDraft = {
    categories: draft.categories,
    entry_moves: draft.entry_moves,
    entry_updates: draft.entry_updates,
    scope_mode: draft.scope_mode,
    roots: draft.roots,
    requires_edges: draft.requires_edges,
    related_edges: draft.related_edges,
  };
  return body;
};

/**
 * 预览：防抖 + 过时请求保护（只接受最后一次发出的响应）。
 *
 * 依赖项刻意用**语义键**（序列化后的请求体 + 用分隔符拼起来的阵容/手动追加），
 * 而不是数组 / 对象的引用：审核反证 P2-15 —— 调用方每次渲染都传一个新的 `[]`，
 * 旧实现把它当依赖，于是 `setPreview` 触发重渲染 → 又发一次请求，
 * 空闲时形成 180ms 一次的请求循环。
 */
export function useScopePreview(
  bookId: string, detailUpdatedAt: number | undefined,
  draft: WorldBookDraft | null, roster: string[], manual: string[], enabled = true,
) {
  const api = useApi();
  const [preview, setPreview] = useState<WorldBookScopePreviewDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);

  // 预览用完整草稿：看到的就是「按这份草稿保存后」的结果。
  const body = useMemo(() => (draft ? buildSaveBody(draft) : null), [draft]);
  const bodyKey = body ? JSON.stringify(body) : "";
  const rosterKey = roster.join("\u0000");
  const manualKey = manual.join("\u0000");
  // 请求体用 ref 取最新值：依赖项只认语义键，避免「内容没变但引用变了」重发请求。
  const bodyRef = useRef<WorldBookConfigurationDraft | null>(null);
  bodyRef.current = body;

  useEffect(() => {
    const seq = ++sequence.current;
    if (!enabled || !bookId || !bodyKey) { setPreview(null); setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      api.previewWorldbookScope(bookId, rosterKey ? rosterKey.split("\u0000") : [],
        bodyRef.current as WorldBookConfigurationDraft,
        { manual_entry_uids: manualKey ? manualKey.split("\u0000") : [] })
        .then((value) => { if (seq === sequence.current) { setPreview(value); setError(""); } })
        .catch((e) => {
          if (seq !== sequence.current) return;   // 过时响应直接丢弃
          setPreview(null);
          setError(e instanceof Error ? e.message : "预览失败");
        })
        .finally(() => { if (seq === sequence.current) setLoading(false); });
    }, 180);
    return () => { clearTimeout(timer); sequence.current++; };
  }, [api, bookId, detailUpdatedAt, bodyKey, rosterKey, manualKey, enabled]);

  return { preview, loading, error };
}

/**
 * 会话向导用的预览：只有阵容 + 手动追加，没有草稿。
 * 与 `useScopePreview` 共用同一套防抖与过时响应保护，避免用户连续勾选时
 * 旧响应后到把新结果覆盖掉。
 */
export function useRosterScopePreview(
  bookIds: string[], roster: string[], manual: string[], enabled = true,
) {
  const api = useApi();
  const [previews, setPreviews] = useState<Record<string, WorldBookScopePreviewDTO>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const manualKey = manual.join("\u0000");
  const rosterKey = roster.join("\u0000");
  const bookKey = bookIds.join("\u0000");

  useEffect(() => {
    const seq = ++sequence.current;
    if (!enabled || !bookKey) { setPreviews({}); setLoading(false); setError(""); return; }
    setLoading(true);
    setPreviews({});
    const timer = setTimeout(() => {
      Promise.all(bookKey.split("\u0000").map(async (bookId, index) => [bookId,
        await api.previewWorldbookScope(bookId, rosterKey ? rosterKey.split("\u0000") : [], undefined,
          { manual_entry_uids: index === 0 && manualKey ? manualKey.split("\u0000") : [] }),
      ] as const))
        .then((values) => { if (seq === sequence.current) { setPreviews(Object.fromEntries(values)); setError(""); } })
        .catch((e) => {
          if (seq !== sequence.current) return;   // 过时响应直接丢弃
          setPreviews({});
          setError(e instanceof Error ? e.message : "候选范围预览失败");
        })
        .finally(() => { if (seq === sequence.current) setLoading(false); });
    }, 180);
    return () => { clearTimeout(timer); sequence.current++; };
  }, [api, bookKey, rosterKey, manualKey, enabled]);

  return { previews, loading, error };
}
