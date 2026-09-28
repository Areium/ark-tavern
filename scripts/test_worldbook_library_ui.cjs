// 不启动浏览器：检验资料库体验的纯逻辑与真实 WorldBookManager 的服务端渲染结构。
//
// 覆盖：用途筛选/分组/目标收敛、摘录草稿的「原文照搬 vs 编辑稿」折算、
// 校验信息，以及分组件的 SSR 骨架（资料库隐藏只会误导人的动作、默认进入条目正文）。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "..");
const fromFrontend = createRequire(path.join(root, "frontend/package.json"));
const ts = fromFrontend("typescript");
require.extensions[".css"] = () => {};
for (const extension of [".ts", ".tsx"]) {
  require.extensions[extension] = (module, filename) => {
    const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
    });
    module._compile(outputText, filename);
  };
}
const React = fromFrontend("react");
const { renderToStaticMarkup } = fromFrontend("react-dom/server");
const {
  BOOK_TYPE_HINTS, BOOK_TYPE_LABELS, bookTypeOf, draftFromEntry, excerptItemFromDraft,
  filterBooksByType, flattenLibraryHits, groupBooksByType, isReference,
  normalizeWorldbookTab, resolveCategoryForTarget, validateExcerptDraft,
} = require(path.join(root, "frontend/src/utils/worldbookLibrary.ts"));
const managerModule = require(path.join(root, "frontend/src/components/WorldBookManager.tsx"));
const WorldBookManager = managerModule.default;

// ── 用途判定：缺字段一律 story（与后端 normalize_book_type 的缺省一致）──
assert.equal(bookTypeOf(null), "story");
assert.equal(bookTypeOf(undefined), "story");
assert.equal(bookTypeOf({}), "story");
assert.equal(bookTypeOf({ book_type: undefined }), "story");
assert.equal(bookTypeOf({ book_type: "reference" }), "reference");
assert.equal(bookTypeOf({ book_type: "story" }), "story");
assert.equal(isReference({ book_type: "story" }), false);
assert.equal(isReference({ book_type: "reference" }), true);
assert.equal(BOOK_TYPE_LABELS.story, "剧情世界书");
assert.equal(BOOK_TYPE_LABELS.reference, "资料库");
assert.ok(BOOK_TYPE_HINTS.reference.includes("不参与任何会话解析"));

// ── 列表筛选 / 分组 ──
const library = [
  { id: "s1", name: "主剧情书", book_type: "story", enabled: true },
  { id: "r1", name: "大资料库", book_type: "reference", enabled: true },
  { id: "s2", name: "旧数据书", enabled: true },              // 缺字段 → story
  { id: "r2", name: "停用的资料库", book_type: "reference", enabled: false },
];
assert.deepEqual(filterBooksByType(library, "all").map((b) => b.id), ["s1", "r1", "s2", "r2"]);
assert.deepEqual(filterBooksByType(library, "story").map((b) => b.id), ["s1", "s2"]);
assert.deepEqual(filterBooksByType(library, "reference").map((b) => b.id), ["r1", "r2"]);
const grouped = groupBooksByType(library);
assert.deepEqual(grouped.story.map((b) => b.id), ["s1", "s2"]);
assert.deepEqual(grouped.reference.map((b) => b.id), ["r1", "r2"]);
assert.deepEqual(library.map((b) => b.id), ["s1", "r1", "s2", "r2"], "筛选不得改入参顺序");

// ── 命中摊平：只保留资料库 ──
const hits = flattenLibraryHits([
  { book: { id: "r1", name: "资料库", book_type: "reference" }, matches: [
    { uid: "a", name: "A", content: "a" }, { uid: "b", name: "B", content: "b" }] },
  { book: { id: "s1", name: "剧情书", book_type: "story" }, matches: [
    { uid: "c", name: "C", content: "c" }] },
]);
assert.deepEqual(hits, [
  { bookId: "r1", bookName: "资料库", entry: { uid: "a", name: "A", content: "a" } },
  { bookId: "r1", bookName: "资料库", entry: { uid: "b", name: "B", content: "b" } },
]);
assert.deepEqual(flattenLibraryHits([]), []);

// ── 摘录草稿 ──
const sourceEntry = {
  uid: "e1", name: "阿米娅", content: "罗德岛的领袖。",
  trigger_keys: ["阿米娅"], secondary_keys: ["罗德岛"],
};
const draft = draftFromEntry({ bookId: "r1", bookName: "资料库", entry: sourceEntry }, "s1");
assert.deepEqual(draft, {
  sourceBookId: "r1", sourceBookName: "资料库", sourceEntryUid: "e1",
  name: "阿米娅", content: "罗德岛的领袖。",
  triggerKeysText: "阿米娅", secondaryKeysText: "罗德岛", targetBookId: "s1",
});
assert.equal(validateExcerptDraft(draft, sourceEntry), null, "默认带入原文即可提交");

// 原文照搬：载荷只有来源定位，不下发任何编辑字段
const verbatim = excerptItemFromDraft(draft, sourceEntry);
assert.deepEqual(verbatim, { source_book_id: "r1", source_entry_uid: "e1" });

// 编辑稿：只提交真的改过的字段
const edited = excerptItemFromDraft(
  { ...draft, name: "阿米娅（第二章）", content: "改写后的剧情稿。", triggerKeysText: "阿米娅, Amiya" },
  sourceEntry,
);
assert.deepEqual(edited, {
  source_book_id: "r1", source_entry_uid: "e1",
  name: "阿米娅（第二章）", content: "改写后的剧情稿。", trigger_keys: ["阿米娅", "Amiya"],
});

// 触发词清空也是有效编辑（用户想让条目不再自动触发）
assert.deepEqual(excerptItemFromDraft({ ...draft, triggerKeysText: "  " }, sourceEntry).trigger_keys, []);

// 编辑后名称去首尾空白；正文保留原文（不改写正文内容）
const trimmed = excerptItemFromDraft({ ...draft, name: "  标题  " }, sourceEntry);
assert.equal(trimmed.name, "标题");
assert.equal(trimmed.content, undefined, "未改正文时不下发 content，避免把来源正文当编辑覆盖");

// ── 校验 ──
assert.equal(validateExcerptDraft({ ...draft, targetBookId: "" }, sourceEntry), "请选择要加入的剧情世界书");
assert.ok(validateExcerptDraft({ ...draft, content: "   " }, sourceEntry), "把正文改成空白必须被拦住");
assert.ok(validateExcerptDraft({ ...draft, content: "" }, sourceEntry), "清空正文也必须被拦住");
// 草稿与原文逐字一致时以原文为准：草稿被初始成空串、来源也真的没正文时才算无内容
assert.equal(validateExcerptDraft(draft, sourceEntry), null, "默认原文可直接提交");
assert.ok(validateExcerptDraft({ ...draft, content: "" }, { ...sourceEntry, content: "" }));

// ── 目标书分类收敛 ──
const targetCategories = [
  { id: "worldview", name: "世界观" }, { id: "unclassified", name: "未分类" },
];
assert.equal(resolveCategoryForTarget("worldview", targetCategories), "worldview");
assert.equal(resolveCategoryForTarget("source-only", targetCategories), "unclassified");
assert.equal(resolveCategoryForTarget(undefined, targetCategories), "unclassified");
assert.equal(resolveCategoryForTarget("worldview", []), "worldview", "没有分类信息时不乱改");

// ── 页签归一：旧 load 一律回到条目；资料库只允许 条目 / 本家索引 ──
assert.equal(normalizeWorldbookTab("entries", { book_type: "reference" }), "entries");
assert.equal(normalizeWorldbookTab("index", { book_type: "reference" }), "index");
assert.equal(normalizeWorldbookTab("load", { book_type: "reference" }), "entries");
assert.equal(normalizeWorldbookTab("prompt", { book_type: "reference" }), "entries");
assert.equal(normalizeWorldbookTab("graph", { book_type: "reference" }), "entries");
assert.equal(normalizeWorldbookTab("nodes", { book_type: "reference" }), "entries", "旧「节点视图」页签值已不存在");
assert.equal(normalizeWorldbookTab("load", { book_type: "story" }), "entries");
for (const tab of ["entries", "prompt", "graph", "index"]) {
  assert.equal(normalizeWorldbookTab(tab, { book_type: "story" }), tab);
  // 缺字段（旧数据）按 story 处理；没有选中书时也不做收窄
  assert.equal(normalizeWorldbookTab(tab, {}), tab);
  assert.equal(normalizeWorldbookTab(tab, null), tab);
}
// 脏值（含旧值域与未知字符串）兜底到 entries，不会渲染出不存在的视图
assert.equal(normalizeWorldbookTab(undefined, { book_type: "story" }), "entries");
assert.equal(normalizeWorldbookTab(null, { book_type: "reference" }), "entries");
assert.equal(normalizeWorldbookTab("bogus", { book_type: "story" }), "entries");
assert.equal(normalizeWorldbookTab("taxonomy", { book_type: "story" }), "entries", "旧的 detailTab 值域已不存在");

// ── SSR：组件骨架 ──
const summary = (over) => ({
  id: "x", name: "书", source_format: "manual",
  enabled: true, budget_tokens: 0, entry_count: 0,
  created_at: 0, updated_at: 0, is_default: false, ...over,
});
const apiStub = new Proxy({}, { get: () => async () => ({ books: [] }) });
const renderManager = () => renderToStaticMarkup(React.createElement(WorldBookManager, { __api: apiStub }));

// 组件挂载即走真实 useApi（会打网络）；这里只断言它在无数据时的静态骨架。
const markup = renderManager();
assert.ok(markup.includes("世界书"));
assert.ok(markup.includes(">新建</button>") && markup.includes(">导入文件</button>"), "书架提供应用内新建与文件导入入口");
assert.ok(markup.includes("刷新书架") && markup.includes("data/worldbooks/books/"), "书架说明完整文件夹的安装位置");
assert.ok(markup.includes("自动创建独立的书文件夹") && !markup.includes(".arkwb"), "酒馆文件导入说明与文件夹管理方式一致");
assert.ok(markup.includes(">剧情</button>") && markup.includes(">资料</button>"), "两种用途都可筛选");
assert.ok(markup.includes("从左侧书架选一本世界书"), "没选书时详情区给出明确指引，不留白");
assert.deepEqual(managerModule.WORLDBOOK_PANEL_TABS.map((tab) => tab.id),
  ["entries", "prompt", "graph", "index"], "工作台只保留四个页签（节点图迁入，节点视图已删除）");
assert.equal(managerModule.estimateDisplayTokens("中文"), 2, "CJK 基本区逐字计数");
assert.equal(managerModule.estimateDisplayTokens("abcd"), 1, "非中文 code point 每四个估算一 token");
assert.equal(managerModule.estimateDisplayTokens("😀😀😀😀"), 1, "emoji 按 code point 而非 UTF-16 单元计数");
assert.ok(!markup.includes("高级配置"), "「高级配置」不再是工作台的说法");
assert.ok(!markup.includes("分类图谱 · "), "分类图谱不再作为独立视图出现");

console.log("Worldbook library UI: type filtering/grouping, hit flattening, "
  + "verbatim vs edited excerpt payloads, validation, worldbook-tab normalization "
  + "and the new workbench SSR skeleton passed.");
