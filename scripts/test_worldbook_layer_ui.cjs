// 不启动浏览器：检验世界书「分层 + 统计 + 封面」三件事的纯逻辑，以及真实组件的 SSR 结构。
//
// 覆盖：
//   1. 三层判定（稳定 / 动态 / 系统）与「系统层优先于位置分层」的顺序；
//   2. 条目数与 token 的统计口径 —— 勾选 / 取消勾选后必须立刻跟着变；
//   2b. 展示顺序：系统层恒定沉底，且不参与拖动排序；
//   3. 前后端两张系统层常量表不许漂移（直接读 src/world_book.py 比对）；
//   4. 封面选择器只接受本地文件（不是图片地址输入框），并如实说明会压缩后内嵌；
//   5. Prompt 预览页把「系统层已排除」说出来；
//   6. 会话条目页不给系统层条目一个「拨了没用」的会话开关。
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

const layer = require(path.join(root, "frontend/src/utils/worldbookLayer.ts"));
const {
  LAYER_LABELS, SYSTEM_ENTRY_FENCES, SYSTEM_ENTRY_TYPES, bookEntryStats, entryLayer,
  entryTokens, estimateDisplayTokens, formatBytes, isSortableEntry, isSystemEntry,
  sortEntriesByLayer, summaryEntryStats,
} = layer;
const CoverPickerModule = require(path.join(root, "frontend/src/components/worldbook/CoverPicker.tsx"));
const CoverPicker = CoverPickerModule.default;
const PromptPreviewTabModule = require(path.join(root, "frontend/src/components/worldbook/tabs/PromptPreviewTab.tsx"));
const PromptPreviewTab = PromptPreviewTabModule.default;

// ── 1. token 估算仍是原口径（CJK 逐字 / 其余每 4 code point 一个）──
assert.equal(estimateDisplayTokens("中文"), 2);
assert.equal(estimateDisplayTokens("abcd"), 1);
assert.equal(estimateDisplayTokens("😀😀😀😀"), 1, "emoji 按 code point 而非 UTF-16 单元计数");
assert.equal(estimateDisplayTokens(""), 0);
assert.equal(entryTokens({ name: "世界设定", content: "泰拉世界。" }), estimateDisplayTokens("### 世界设定\n泰拉世界。"));
assert.equal(entryTokens({ name: "", content: "abcd" }), 1, "没有名称时不加标题前缀");

// ── 2. 三层判定 ──
const marker = { extensions: { arknights_tavern: { entry_type: "plot_graph", plot_id: "p" } } };
const graphEntry = { uid: "g", name: "节点图：P", content: "```json plot-graph\n{}\n```",
  raw: marker, position: 1, always_active: false, enabled: true };
const bindingEntry = { uid: "b", name: "节点绑定：book",
  content: "```json arknights_tavern_lore_bindings\n{}\n```", raw: {},
  position: 0, always_active: false, enabled: true };
const stable = { uid: "s", content: "世界观。", raw: {}, position: 0, always_active: true, enabled: true };
const dynamic = { uid: "d", content: "触发型。", raw: {}, position: 1, always_active: false, enabled: true };
const disabled = { uid: "x", content: "停用。", raw: {}, position: 1, always_active: false, enabled: false };
// 只靠 extensions 标记（没有围栏块）也要认；正文里只是提到名字则不算
const markerOnly = { uid: "m", content: "（正文被改坏了）",
  raw: { extensions: { arknights_tavern: { entry_type: "lore_bindings" } } },
  position: 1, always_active: false, enabled: true };
const mentioned = { uid: "n", content: "正文里提到 plot-graph 这个词，但没有围栏块。",
  raw: {}, position: 1, always_active: false, enabled: true };

assert.equal(isSystemEntry(graphEntry), true);
assert.equal(isSystemEntry(bindingEntry), true, "节点绑定与节点图同属系统层");
assert.equal(isSystemEntry(markerOnly), true, "extensions 标记优先，正文损坏也仍认出类型");
assert.equal(isSystemEntry(mentioned), false, "只是提到名字不算承载节点图");
assert.equal(isSystemEntry(stable), false);
assert.equal(entryLayer(stable), "stable");
assert.equal(entryLayer(dynamic), "dynamic");
assert.equal(entryLayer(graphEntry), "system");
assert.equal(entryLayer(bindingEntry), "system");
// 关键顺序：系统层条目也「非常驻」，若先按位置分层会被误报成动态层
assert.equal(entryLayer({ ...graphEntry, position: 0, always_active: true }), "system",
  "系统层优先于稳定 / 动态分层");
assert.deepEqual([LAYER_LABELS.stable, LAYER_LABELS.dynamic, LAYER_LABELS.system],
  ["稳定层", "动态层", "系统层"]);

// ── 2b. 展示顺序：系统层恒定沉底，且不参与拖动排序 ──
// 传入顺序故意打乱：系统层夹在最前面、中间、最后面，都必须沉到末尾。
const scrambled = [graphEntry, dynamic, bindingEntry, stable, disabled];
assert.deepEqual(sortEntriesByLayer(scrambled).map((item) => item.uid),
  ["s", "d", "x", "g", "b"], "稳定层 → 动态层 → 系统层；系统层条目沉底");
// 分层序号必须单调不减 —— 这才是「按层分组」的可检验含义（同层内不重排）
const ranks = { stable: 0, dynamic: 1, system: 2 };
const rankSeq = sortEntriesByLayer(scrambled).map((item) => ranks[entryLayer(item)]);
assert.deepEqual(rankSeq, [...rankSeq].sort((a, b) => a - b), "分层序号单调不减");
assert.deepEqual(sortEntriesByLayer([graphEntry, bindingEntry]).map((item) => item.uid),
  ["g", "b"], "全是系统层时保持原有顺序（稳定排序）");
assert.deepEqual(sortEntriesByLayer([dynamic, stable, disabled]).map((item) => item.uid),
  ["s", "d", "x"], "层内顺序不变：只按层分组，不做二次排序");
assert.deepEqual(sortEntriesByLayer([]), []);
assert.deepEqual(sortEntriesByLayer([stable]).map((item) => item.uid), ["s"], "单条目原样返回");
assert.deepEqual(scrambled.map((item) => item.uid), ["g", "d", "b", "s", "x"], "排序是纯函数，不就地改入参");

assert.equal(isSortableEntry(stable), true);
assert.equal(isSortableEntry(dynamic), true);
assert.equal(isSortableEntry(disabled), true, "停用与否不影响可否排序");
assert.equal(isSortableEntry(graphEntry), false, "系统层条目不可拖动排序");
assert.equal(isSortableEntry(bindingEntry), false);

// ── 3. 统计口径：勾选后实时更新 ──
const entries = [stable, dynamic, disabled, graphEntry, bindingEntry];
const base = bookEntryStats(entries);
assert.deepEqual(base, { total: 5, injectable: 2, disabled: 1, system: 2, tokens: base.tokens });
assert.equal(base.tokens, entryTokens(stable) + entryTokens(dynamic),
  "token 只累计会注入的条目：停用与系统层都不算");

// 取消勾选一条 → 条目数与 token 同时下降（界面上的「实时更新」就是这个函数）
const unchecked = bookEntryStats([stable, { ...dynamic, enabled: false }, disabled, graphEntry, bindingEntry]);
assert.equal(unchecked.injectable, 1);
assert.equal(unchecked.tokens, entryTokens(stable));
assert.ok(unchecked.tokens < base.tokens);
assert.equal(unchecked.total, 5, "总数不变，只有「会注入的」在变");
assert.equal(unchecked.system, 2, "系统层计数与勾选无关");

// 全部停用 → 0 条 0 token，但总数与系统层数仍在
const allOff = bookEntryStats(entries.map((item) => ({ ...item, enabled: false })));
assert.equal(allOff.injectable, 0);
assert.equal(allOff.tokens, 0);
assert.equal(allOff.disabled, 3);
assert.deepEqual(bookEntryStats(null), { total: 0, injectable: 0, disabled: 0, system: 0, tokens: 0 });

// 书架摘要：优先用服务端分层字段，缺字段（旧响应）时退回旧口径
assert.deepEqual(
  summaryEntryStats({ entry_count: 5, injectable_entry_count: 2, disabled_entry_count: 1,
    system_entry_count: 2, estimated_tokens: 123 }),
  { total: 5, injectable: 2, disabled: 1, system: 2, tokens: 123 });
assert.deepEqual(
  summaryEntryStats({ entry_count: 4, estimated_tokens: 44 }),
  { total: 4, injectable: 4, disabled: 0, system: 0, tokens: 44 },
  "字段缺失时不显示成 0");
assert.equal(formatBytes(0), "0 KB");
assert.equal(formatBytes(900), "900 B");
assert.equal(formatBytes(68 * 1024), "68 KB");
assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");

// ── 4. 前后端常量表不许漂移 ──
// 直接读后端源码里的两张表：任何一侧新增类型而另一侧没跟上都会在这里失败。
const backend = fs.readFileSync(path.join(root, "src/world_book.py"), "utf8");
const tableOf = (name) => {
  const match = backend.match(new RegExp(`${name}\\s*=\\s*\\(([^)]*)\\)`));
  assert.ok(match, `src/world_book.py 里找不到 ${name}`);
  return match[1].split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
};
assert.deepEqual([...SYSTEM_ENTRY_TYPES], tableOf("SYSTEM_ENTRY_TYPES"),
  "前端 SYSTEM_ENTRY_TYPES 必须与 world_book.SYSTEM_ENTRY_TYPES 一致");
assert.deepEqual([...SYSTEM_ENTRY_FENCES], tableOf("SYSTEM_ENTRY_FENCES"),
  "前端 SYSTEM_ENTRY_FENCES 必须与 world_book.SYSTEM_ENTRY_FENCES 一致");

// ── 5. SSR：封面选择器只接受本地文件 ──
const coverMarkup = renderToStaticMarkup(React.createElement(CoverPicker, {
  value: "", onChange: () => {}, emptyLabel: "选择本地图片",
}));
assert.ok(coverMarkup.includes('type="file"'), "封面必须是文件选择，不是地址输入");
assert.ok(coverMarkup.includes('accept="image/*"'));
assert.ok(!coverMarkup.includes('placeholder="https://…"'), "不再提供图片地址输入框");
assert.ok(coverMarkup.includes("选择本地图片"));
assert.ok(coverMarkup.includes("自动压缩后内嵌进这本书"), "如实说明会压缩并随书保存");

const clearedMarkup = renderToStaticMarkup(React.createElement(CoverPicker, {
  value: "data:image/webp;base64,AAAA", onChange: () => {},
}));
assert.ok(clearedMarkup.includes("<img"), "已有封面时给出预览");
assert.ok(clearedMarkup.includes("移除封面"));
assert.ok(clearedMarkup.includes("更换封面"));

// 压缩参数是「几百像素 / 一百多 KB」量级：再大就是把书 JSON 撑爆
assert.ok(CoverPickerModule.COVER_MAX_EDGE > 0 && CoverPickerModule.COVER_MAX_EDGE <= 1024);
assert.ok(CoverPickerModule.COVER_MAX_BYTES > 0 && CoverPickerModule.COVER_MAX_BYTES <= 512 * 1024);
assert.ok(CoverPickerModule.COVER_QUALITY_LADDER.length >= 2, "质量要有阶梯，才能保证压到上限以内");
assert.ok(CoverPickerModule.COVER_MIME_PREFERENCE.includes("image/webp"), "优先 WebP：同画质更小");
assert.equal(CoverPickerModule.coverCompressSummary({
  dataUrl: "", bytes: 68 * 1024, originalBytes: 3 * 1024 * 1024,
  width: 512, height: 768, mime: "image/webp",
}), "原图 3.0 MB → 68 KB（512×768）");

// ── 6. SSR：Prompt 预览把「系统层已排除」说出来 ──
const detail = {
  id: "book", name: "系统层测试书", source_format: "manual", source: "imported",
  is_preinstalled: false, enabled: true, budget_tokens: 0, created_at: 0, updated_at: 0,
  is_default: false, book_type: "story", entry_count: entries.length,
  import_config: { revision: 1 }, entries,
};
const draft = {
  categories: [], entry_moves: {}, entry_updates: {}, scope_mode: "selective",
  roots: [], requires_edges: [], related_edges: [], rejected: [], adopt_v3: false,
};
const previewMarkup = renderToStaticMarkup(React.createElement(PromptPreviewTab, {
  ctx: { detail, draft, patch: () => {}, adoptV3: () => {}, dirty: false, saving: false,
    save: async () => true, undo: () => {}, saveError: "", conflict: false,
    preview: null, previewing: false, previewError: "", roster: [], setRoster: () => {} },
  onNotice: () => {}, onReload: async () => {},
}));
assert.ok(previewMarkup.includes(PromptPreviewTabModule.SYSTEM_LAYER_PREVIEW_NOTE.slice(0, 12)));
assert.ok(previewMarkup.includes("<b>2</b> 条系统层条目，已排除"), "把被排除的条数说清楚，避免以为漏了");
assert.ok(previewMarkup.includes("<b>1</b> 条已停用"));
assert.ok(previewMarkup.includes("静态层") && previewMarkup.includes("动态层"));
assert.ok(!previewMarkup.includes("系统层</button>"), "系统层不是可切换的预览层：它根本不注入");

// ── 7. SSR：会话条目页也不给系统层条目一个「拨了没用」的开关 ──
const IndexManager = require(path.join(root, "frontend/src/components/IndexManager.tsx")).default;
const indexMarkup = renderToStaticMarkup(React.createElement(IndexManager, {
  book: {
    ...detail,
    categories: [{ id: "plots", parent_id: null, name: "剧情设定", scope_type: "other", sort_order: 32 }],
    entries: [{ ...dynamic, category_id: "plots", name: "普通剧情条目" },
      { ...graphEntry, category_id: "plots" }],
  },
  onRefresh: async () => {}, onEditDefaults: () => {},
}));
assert.ok(indexMarkup.includes("普通剧情条目"), "会注入的条目照常列出");
assert.ok(!indexMarkup.includes("节点图：P"), "系统层条目不进列表：给它会话开关只会误导");
assert.ok(indexMarkup.includes("<b>1</b> 条系统层条目"), "数量要说明，免得以为条目丢了");
assert.ok(indexMarkup.includes("1 个条目"), "分母也换成会注入的条目，不是含系统层的总数");
assert.ok(indexMarkup.includes("1 / 1 个条目"), "计数口径一致");

console.log("Worldbook layer UI: three-layer classification, live entry/token stats, "
  + "system-layer-sinks-to-bottom display order with drag locked, front-back "
  + "constant-table parity, local-file cover picker, prompt-preview and "
  + "session-entry system-layer notices passed.");
