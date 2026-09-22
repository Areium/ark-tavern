// 不启动浏览器：检验分类树工具、批量起点/依赖/归属的纯逻辑，以及真实 React 组件的服务端渲染结构。
//
// 画布与依赖树相关断言（图构建 / 布局 / 框选 / 角色词表 / 依赖树建模）已随 D-1 / D-3 删除；
// 节点视图、依赖展开树与 Prompt 预览的纯函数断言留给 WU-F / WU-E（见文件末尾的预留块）。
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
const { categoryDescendants, flattenCategoryTree } = require(path.join(root, "frontend/src/utils/worldbookScope.ts"));
const {
  batchAddEdges, batchMove, batchRemoveEdges, batchRoots, categoryEntryUids, knownUids,
} = require(path.join(root, "frontend/src/utils/worldbookBatch.ts"));
const { withManualExpansion } = require(path.join(root, "frontend/src/utils/worldbookRoot.ts"));
const ScopeManager = require(path.join(root, "frontend/src/components/WorldBookScopeManager.tsx")).default;
const Preview = require(path.join(root, "frontend/src/components/WorldBookScopePreview.tsx")).default;
const managerModule = require(path.join(root, "frontend/src/components/WorldBookManager.tsx"));
const Manager = managerModule.default;

// ── 分类树工具 ──────────────────────────────────────────────────────────────
const categories = [
  { id: "world", name: "世界观", parent_id: null, scope_type: "worldview", sort_order: 1 },
  { id: "characters", name: "角色", parent_id: null, scope_type: "character", sort_order: 2 },
  { id: "rhodes", name: "罗德岛", parent_id: "characters", scope_type: "character", sort_order: 1 },
  { id: "squad", name: "小队", parent_id: "rhodes", scope_type: "character", sort_order: 1 },
];
assert.deepEqual([...categoryDescendants(categories, "characters")], ["characters", "rhodes", "squad"]);
assert.deepEqual(flattenCategoryTree(categories).map((row) => row.level), [0, 0, 1, 2]);
assert.equal(categoryDescendants([{ id: "a", parent_id: "b" }, { id: "b", parent_id: "a" }], "a").size, 2);

// ── 统一草稿与书的固定夹具 ──────────────────────────────────────────────────
const detail = {
  id: "qa", name: "结构验收", book_type: "story", categories, scope_mode: "selective",
  entries: [
    { uid: "world", name: "世界设定", category_id: "world", enabled: true, trigger_keys: [] },
    { uid: "amiya", name: "阿米娅", category_id: "squad", character_id: "阿米娅", enabled: true, trigger_keys: [] },
    { uid: "kaltsit", name: "凯尔希", category_id: "rhodes", character_id: "凯尔希", enabled: true, trigger_keys: [] },
    { uid: "loose", name: "游离条目", category_id: "world", enabled: false, trigger_keys: [] },
  ],
  dependency_edges: [
    { from_uid: "amiya", to_uid: "world" },
    { from_uid: "kaltsit", to_uid: "world" },
    { from_uid: "amiya", to_uid: "loose" },
  ],
  related_edges: [{ from_uid: "world", to_uid: "loose" }],
  import_config: { revision: 1, fixed_entry_uids: ["world"], dependency_sources: [] },
};
const draft = {
  categories: categories.map((category) => ({ ...category })),
  entry_moves: {}, entry_updates: {}, scope_mode: "selective",
  roots: [{ entry_uid: "world", activation: "always", expansion: "none" }],
  requires_edges: detail.dependency_edges.map((edge) => ({ ...edge })),
  related_edges: detail.related_edges.map((edge) => ({ ...edge })),
  rejected: [], adopt_v3: true,
};
const untouched = JSON.stringify(draft);
const rootOf = (value, uid) => value.roots.find((root) => root.entry_uid === uid);

// ── 批量起点（R-17：v2 的两次批量写合并为 batchRoots）────────────────────────
const rooted = batchRoots(draft, detail, ["amiya", "amiya", "nope"], "always", "none");
assert.deepEqual(rooted.roots.map((root) => [root.entry_uid, root.activation, root.expansion]),
  [["amiya", "always", "none"], ["world", "always", "none"]],
  "替换既有起点、按 (uid, activation, expansion) 稳定排序、过滤未知 UID 与重复");
assert.notEqual(rooted, draft, "产出新草稿而不是就地改入参");
assert.equal(batchRoots(draft, detail, ["nope"], "always", "none"), draft, "没有有效 uid 时原样返回");
assert.equal(batchRoots(draft, detail, [], "always", "none"), draft);
assert.deepEqual(rootOf(batchRoots(draft, detail, ["amiya"], "roster_any", "legacy_depth", 99), "amiya"),
  { entry_uid: "amiya", activation: "roster_any", expansion: "legacy_depth", max_depth: 32 }, "深度上限钳到 32");
assert.equal(rootOf(batchRoots(draft, detail, ["amiya"], "always", "legacy_depth", -5), "amiya").max_depth, 0,
  "深度下限钳到 0");
assert.equal(rootOf(batchRoots(draft, detail, ["amiya"], "always", "legacy_depth"), "amiya").max_depth, 1,
  "legacy_depth 未给深度时按 1");
assert.deepEqual(rootOf(batchRoots(draft, detail, ["amiya"], "always", "requires_closure"), "amiya"),
  { entry_uid: "amiya", activation: "always", expansion: "requires_closure" }, "requires_closure 不带 max_depth");
assert.deepEqual(batchRoots(draft, detail, ["world"], null, "none").roots, [], "activation=null 表示移除起点");
assert.deepEqual(batchRoots(rooted, detail, ["amiya"], "manual", "none").roots.filter((root) => root.entry_uid === "amiya"),
  [{ entry_uid: "amiya", activation: "manual", expansion: "none" }], "同一 uid 只保留一个起点");
assert.equal(JSON.stringify(draft), untouched, "批量起点不得就地修改草稿");

// ── 批量依赖边 ──────────────────────────────────────────────────────────────
const linked = batchAddEdges(draft, detail, ["kaltsit", "loose", "loose"], "amiya", "to");
assert.deepEqual(linked.added, [{ from_uid: "kaltsit", to_uid: "amiya" }, { from_uid: "loose", to_uid: "amiya" }],
  "重复选中只建立一条边");
assert.equal(batchAddEdges(draft, detail, ["amiya"], "world", "to").added.length, 0, "已存在的边不重复添加");
const selfLink = batchAddEdges(draft, detail, ["amiya"], "amiya", "to");
assert.equal(selfLink.added.length, 0);
assert.equal(selfLink.skipped, 1, "自环直接跳过而不是抛错");
const unknownTarget = batchAddEdges(draft, detail, ["kaltsit"], "nope", "to");
assert.equal(unknownTarget.added.length, 0);
assert.equal(unknownTarget.requires_edges, draft.requires_edges, "目标不存在时不产出半成品");
assert.deepEqual(batchAddEdges(draft, detail, ["loose"], "kaltsit", "from").added,
  [{ from_uid: "kaltsit", to_uid: "loose" }], "反向批量连线：目标 → 所选");
assert.equal(batchRemoveEdges(draft, detail, ["world"]).removed, 2, "world 的两条入边");
assert.equal(batchRemoveEdges(draft, detail, ["amiya"]).removed, 2, "amiya 的一条出边 + 一条入边");
assert.equal(batchRemoveEdges(draft, detail, ["nope"]).removed, 0);
assert.deepEqual(batchMove(detail, ["amiya", "nope"], "world"), { amiya: "world" });
assert.deepEqual(batchMove(detail, ["amiya"], "no-such-category"), {}, "目标分类不存在时不产出 moves");
assert.deepEqual(categoryEntryUids(detail, "characters"), ["amiya", "kaltsit"]);
assert.deepEqual(categoryEntryUids(detail, "world"), ["world", "loose"]);
assert.deepEqual(categoryEntryUids(detail, "no-such-category"), []);
assert.deepEqual(knownUids(detail, ["world", "nope", "world", "", "amiya"]), ["world", "amiya"],
  "批量目标要过滤未知 UID 与重复");
assert.equal(JSON.stringify(draft), untouched, "批量操作不得就地修改统一草稿");

const aiRoot = { entry_uid: "ai", activation: "always", expansion: "requires_closure",
  origin: "llm", model: "stub", prompt_version: "p", source_content_hash: "hash",
  evidence: "evidence", review_status: "proposed", job_id: "job", reason: "AI reason", locked: true };
assert.deepEqual(withManualExpansion(aiRoot, "none"), {
  entry_uid: "ai", activation: "always", expansion: "none", origin: "manual", locked: true,
}, "概览按钮修改 AI 根语义时必须转人工来源并移除 AI 专属元数据");

// ── SSR：分类结构工作台（原 taxonomy 视图） ─────────────────────────────────
const panel = {
  detail, draft, patch() {}, adoptV3() {}, dirty: false, saving: false, saveError: "", conflict: false,
  save: async () => {}, undo() {}, preview: null, previewing: false, previewError: "", roster: [], setRoster() {},
};
const markup = renderToStaticMarkup(React.createElement(ScopeManager, { ...panel, view: "taxonomy", onChanged() {} }));
for (const expected of ["世界书分类结构工作台", "分类树", "条目归属", "全选当前列表", "自动分类",
  "起点", "导入预览", "小队 的分类批量操作", "wbg-tree-main", "wbg-tree-more", "wbg-own-row",
  "uid 前缀 / group / 名称后缀"]) {
  assert.ok(markup.includes(expected), expected);
}
assert.ok(markup.includes("勾选分类会整棵子树一起选"), "列表复选框是批量选择的唯一驱动方式");
assert.ok(!markup.includes("wbg-batch-bar"), "没有批量选择时不渲染批量操作栏");
assert.ok(!markup.includes("固定导入") && !markup.includes("导入源"),
  "旧词表（固定导入 / 导入源）不再出现在分类结构里");
assert.ok(!markup.includes("世界书依赖图谱") && !markup.includes("依赖树"),
  "画布与依赖树视图已随 D-1 删除");
assert.ok(!markup.includes("<fieldset disabled"), "编辑表单只在侧栏里按需出现");

// 历史 view 取值一律按分类结构渲染（组件只剩一种视图）
const legacyView = renderToStaticMarkup(React.createElement(ScopeManager, { ...panel, view: "dependencies", onChanged() {} }));
assert.equal(legacyView, markup, "非 taxonomy 的 view 取值也按分类结构渲染");

// ── SSR：候选范围预览 ───────────────────────────────────────────────────────
const preview = renderToStaticMarkup(React.createElement(Preview, { value: {
  scope: { resolved_entry_uids: ["a"], legacy_full_scope: false, excluded_entries: [{ uid: "x", name: "停用节点", reason: "已停用" }] },
  entry_count: 1, full_entry_count: 10, full_estimated_tokens: 1000, resolved_estimated_tokens: 100,
  saved_estimated_tokens: 900, saved_percent: 90, breakdown: { fixed: { entry_count: 1, estimated_tokens: 100 } }, warnings: [],
} }));
assert.ok(preview.includes("不是每轮实际节省量") && preview.includes("停用节点"));
assert.ok(preview.includes("基础设定") && !preview.includes("固定导入"),
  "候选范围预览的分类文案改用 v3 表述");

// ── SSR：新工作台 WorldBookManager 骨架 ─────────────────────────────────────
const managerMarkup = renderToStaticMarkup(React.createElement(Manager, {}));
assert.ok(managerMarkup.includes("从左侧书架选一本世界书"), "未选书时渲染书架与明确空状态");
assert.ok(!managerMarkup.includes(managerModule.WORLDBOOK_INDEX_SUBTITLE),
  "未选中世界书时不提前渲染本家索引内容");
assert.ok(!managerMarkup.includes("高级配置"), "「高级配置」这个说法不再出现");
assert.ok(!managerMarkup.includes("世界书图谱"), "R-22：旧说法不出现在任何 UI 文案里");
assert.equal(managerModule.WORLDBOOK_INDEX_SUBTITLE, "内置语料索引 · 依赖完整性 · 会话白名单");
assert.deepEqual(managerModule.WORLDBOOK_PANEL_TABS.map((tab) => tab.id),
  ["entries", "prompt", "graph", "index"], "分类与载入页签已移除；节点视图换为迁入的节点图");
assert.deepEqual(managerModule.visibleWorldbookTabs({ book_type: "reference" }).map((tab) => tab.id),
  ["entries", "index"], "R-4：资料库只显示 条目 / 本家索引");
assert.deepEqual(managerModule.visibleWorldbookTabs({ book_type: "story" }).map((tab) => tab.id),
  ["entries", "prompt", "graph", "index"], "剧情书的四个页签都可达");

// ── WU-E · Prompt 预览纯函数（A-2）──────────────────────────────────────────
const promptModule = require(path.join(root, "frontend/src/utils/worldbookPromptPreview.ts"));
const {
  DROP_REASON_HINTS, DROP_REASON_LABELS, DROP_REASON_ORDER, describeReasons, describeSite,
  describeTotals, findSkeletonWorldbookBlocks, groupDropped, orderUidForBlock, parseInjectionBlocks,
  previewAnchorId, recentDialogueCount, sessionRecentText, siteOf,
} = promptModule;

// 九类未插入原因：分组、中文标题与修复入口逐类断言（R-2 口径）
assert.equal(DROP_REASON_ORDER.length, 9, "dropped.reason 九类口径");
const droppedFixture = [
  { uid: "u9", name: "预算超了", reason: "budget_exceeded" },
  { uid: "u1", name: "范围外", reason: "not_in_scope" },
  { uid: "u2", name: "节点排除", reason: "node_binding_demoted" },
  { uid: "u3", name: "停用", reason: "disabled" },
  { uid: "u4", name: "空正文", reason: "empty_content" },
  { uid: "u5", name: "选择性", reason: "selective_reject" },
  { uid: "u6", name: "主键没中", reason: "keyword_miss" },
  { uid: "u7", name: "副键没中", reason: "secondary_miss" },
  { uid: "u8", name: "概率没中", reason: "probability_miss" },
];
const droppedGroups = groupDropped(droppedFixture);
assert.deepEqual(droppedGroups.map((group) => group.reason), DROP_REASON_ORDER,
  "九类分组按 R-2 判定优先级排列，与输入顺序无关");
assert.equal(droppedGroups.length, 9, "九类各自成组，一类都不会丢");
for (const group of droppedGroups) {
  assert.equal(group.items.length, 1, `${group.reason} 归组`);
  assert.ok(group.label && group.label.length >= 2, `${group.reason} 有中文标题`);
  assert.ok(group.hint && group.hint.length >= 6, `${group.reason} 有一句修复入口`);
}
assert.equal(DROP_REASON_LABELS.budget_exceeded, "超出 token 预算");
assert.ok(DROP_REASON_HINTS.budget_exceeded.includes("提高预算"));
assert.ok(DROP_REASON_HINTS.node_binding_demoted.includes("节点"));
assert.ok(DROP_REASON_HINTS.not_in_scope.includes("分类与载入"));
assert.equal(groupDropped([...droppedFixture, { uid: "x", name: "X", reason: "disabled" }])
  .find((group) => group.reason === "disabled").items.length, 2, "同类原因合并成一组");
assert.deepEqual(groupDropped([]), []);
assert.deepEqual(groupDropped(null), []);
const unknownReason = groupDropped([{ uid: "z", name: "Z", reason: "brand_new" }]);
assert.equal(unknownReason.length, 1, "服务端给出未识别原因时不静默丢弃");
assert.equal(unknownReason[0].items[0].uid, "z");

// `### 名称` 锚点解析：元字符、重名、无锚点兜底
const parsed = parseInjectionBlocks(
  "【世界书】\n### 阿米娅 (Amiya) [1.0]?\n博士，我们出发吧。\n\n### 阿米娅 (Amiya) [1.0]?\n重名块的正文。");
assert.equal(parsed.length, 3, "开头无锚点的部分单独成块");
assert.deepEqual([parsed[0].name, parsed[0].body], ["", "【世界书】"]);
assert.equal(parsed[1].name, "阿米娅 (Amiya) [1.0]?", "名称里的正则元字符原样保留");
assert.equal(parsed[1].body, "博士，我们出发吧。");
assert.equal(parsed[2].name, parsed[1].name, "重名块不合并");
assert.notEqual(previewAnchorId("stable", parsed[1].index), previewAnchorId("stable", parsed[2].index),
  "锚点 id 按层 + 序号，重名不撞车");
assert.equal(previewAnchorId("dynamic", 0), "wbpp-block-dynamic-0");
const fallbackBlock = parseInjectionBlocks("整段没有 ### 锚点的正文");
assert.deepEqual(fallbackBlock.map((block) => [block.name, block.body]), [["", "整段没有 ### 锚点的正文"]],
  "没有 `### ` 头时兜底成一个无锚点块，不吞正文");
assert.deepEqual(parseInjectionBlocks(""), []);
assert.deepEqual(parseInjectionBlocks(null), []);
assert.deepEqual(parseInjectionBlocks("   \n  "), []);

// 真实数据回归（E-2 发现）：条目正文自己也会写 `### ` 小标题 —— 预装整合包 arknights 的
// 「控制中枢（地点设定）」正文里就有 `### 视觉` / `### 氛围`，一次真实预览 70 个 `### ` 头
// 只有 20 个是条目锚点。给得出本轮条目名时只认这些名字，否则中栏会把一条条目劈成几块。
const headingsInBody = "【世界书】\n### 控制中枢（地点设定）\n正文\n\n### 视觉\n中央主屏幕……\n\n### 氛围\n空气……\n\n### 宿舍（地点设定）\n正文";
assert.equal(parseInjectionBlocks(headingsInBody).length, 5, "不给条目名时按所有 `### ` 行切分（老口径）");
const strictBlocks = parseInjectionBlocks(headingsInBody, ["控制中枢（地点设定）", "宿舍（地点设定）"]);
assert.deepEqual(strictBlocks.map((block) => block.name), ["", "控制中枢（地点设定）", "宿舍（地点设定）"],
  "给得出本轮注入的条目名时，正文里的 `### ` 小标题不再当锚点");
assert.ok(strictBlocks[1].body.includes("### 视觉") && strictBlocks[1].body.includes("### 氛围"),
  "正文小标题原样留在正文里，内容不丢");
assert.equal(parseInjectionBlocks(headingsInBody, []).length, 5, "条目名列表为空时退回老口径");
assert.equal(parseInjectionBlocks(headingsInBody, ["别的东西"]).length, 1,
  "没有任何名字命中时兜底成一个无锚点块，整段正文不丢");

// 锚点 → 右栏条目：字符串完全相等，绝不把条目名当正则
const orderFixture = [
  { uid: "u1", name: "阿米娅 (Amiya) [1.0]?", seq: 0, layer: "stable", position: 0, group_weight: 100, depth: 0, estimated_tokens: 12, reasons: ["always"], matched_keys: [] },
  { uid: "u2", name: "A.B", seq: 1, layer: "dynamic", position: 1, group_weight: 100, depth: 0, estimated_tokens: 8, reasons: ["manual"], matched_keys: ["阿米娅"] },
  { uid: "u3", name: "A.B", seq: 2, layer: "dynamic", position: 1, group_weight: 90, depth: 1, estimated_tokens: 6, reasons: ["requires"], matched_keys: [] },
];
assert.equal(orderUidForBlock(orderFixture, parsed[1]), "u1");
assert.equal(orderUidForBlock(orderFixture, parsed[2]), "u1", "重名时取 seq 最小的一条");
assert.equal(orderUidForBlock(orderFixture, { name: "AXB", index: 0, heading: "", body: "" }), null,
  "点号是字面字符而不是通配符");
assert.equal(orderUidForBlock(orderFixture, { name: "A.B", index: 0, heading: "", body: "" }), "u2");
assert.equal(orderUidForBlock(orderFixture, { name: "AAB", index: 0, heading: "", body: "" }), null,
  "加号不当量词");
assert.equal(orderUidForBlock(orderFixture, parsed[0]), null, "无锚点块没有对应条目");
assert.equal(orderUidForBlock([], parsed[1]), null);

// 宿主骨架：世界书块定位与「前插 / 后插」
const skeletonFixture = [
  { id: "system", label: "系统指令", is_worldbook: false, insert: null },
  { id: "reference", label: "<reference>", is_worldbook: true, insert: "before" },
  { id: "characters", label: "角色卡", is_worldbook: false },
  { id: "world_book", label: "<world_book>", is_worldbook: true, insert: "after" },
];
const worldbookBlocks = findSkeletonWorldbookBlocks(skeletonFixture);
assert.deepEqual(worldbookBlocks.map((block) => block.index), [1, 3], "返回骨架里的位次");
assert.deepEqual(worldbookBlocks.map((block) => block.insertLabel), ["前插", "后插"]);
assert.equal(worldbookBlocks[0].label, "<reference>");
assert.deepEqual(findSkeletonWorldbookBlocks(null), []);
assert.equal(findSkeletonWorldbookBlocks([{ id: "x", label: "x", is_worldbook: false }]).length, 0);
assert.equal(findSkeletonWorldbookBlocks([{ id: "y", label: "世界书", is_worldbook: true }])[0].insertLabel, "",
  "服务端没给 insert 时不瞎猜前插 / 后插");

// 摘要文案
const totalsFixture = {
  stable_tokens: 120, dynamic_tokens: 48, budget_tokens: 2000,
  truncated: true, candidate_count: 37, matched_count: 4,
};
const totals = describeTotals(totalsFixture, orderFixture);
assert.equal(totals.stable, "稳定层 1 条 / 120 token");
assert.equal(totals.dynamic, "动态层 2 条 / 48 token");
assert.ok(totals.budget.includes("2000"));
assert.ok(totals.truncation.includes("截断"));
assert.ok(totals.matched.includes("37") && totals.matched.includes("4"));
assert.ok(describeTotals({ ...totalsFixture, budget_tokens: 0, truncated: false }).budget.includes("不限"));
assert.equal(describeTotals(null).lines.length, 5, "没有结果时也给五条摘要，不抛错");

// 命中原因与插入位置
assert.deepEqual(describeReasons(["always", "requires"], ["阿米娅"]),
  ["起点：基础设定", "依赖带出", "关键词命中：阿米娅"]);
assert.deepEqual(describeReasons(["roster:阿米娅,凯尔希"]), ["起点：角色入队（阿米娅、凯尔希）"]);
assert.deepEqual(describeReasons(["roster:"]), ["起点：角色入队"]);
assert.deepEqual(describeReasons(["manual", "full_scope"]), ["手动追加", "全量兼容"]);
assert.deepEqual(describeReasons(["weird_code"]), ["weird_code"], "未知原因原样透出，不乱翻译");
assert.deepEqual(describeReasons(null, null), []);
const siteFixture = [
  { layer: "stable", host: "reference", after_block: "worldview", before_block: "player_identity", description: "卡前常驻设定" },
  { layer: "dynamic", host: "world_book", after_block: "scene_events", before_block: "closing_must", description: "按关键词触发" },
];
assert.ok(describeSite(siteOf(siteFixture, "stable")).includes("卡前常驻设定"));
assert.ok(describeSite(siteOf(siteFixture, "stable")).includes("worldview"));
assert.ok(describeSite(siteOf(siteFixture, "dynamic")).includes("<world_book> 块"));
assert.equal(siteOf(siteFixture, "nope"), null);
assert.equal(describeSite(null), "");

// 会话最近对话：只取真实 user / assistant，按最近 N 条
const sessionFixture = [
  { role: "narrator", content: "场景叙述" },
  { role: "user", content: "我们去哪" },
  { role: "assistant", content: "去龙门" },
  { role: "system", content: "系统提示" },
  { role: "user", content: "   " },
  { role: "user", content: "出发" },
];
assert.equal(sessionRecentText(sessionFixture, 2), "助手：去龙门\n用户：出发", "取最近 2 条真实对话");
assert.equal(sessionRecentText(sessionFixture, 10), "用户：我们去哪\n助手：去龙门\n用户：出发");
assert.equal(sessionRecentText(sessionFixture, 0), "");
assert.equal(sessionRecentText(null), "");
assert.equal(recentDialogueCount(sessionFixture), 3, "narrator / system 不算真实对话");

// ── WU-E · 依赖展开树纯函数（A-3）───────────────────────────────────────────
const depModule = require(path.join(root, "frontend/src/utils/worldbookDependencyTree.ts"));
const {
  CYCLE_STOP_NOTE, MAX_DEPENDENCY_TREE_ROWS, RELATION_LABELS, STATIC_RELATION_NOTE,
  breadcrumbLabel, breadcrumbUids, buildDependencyTree, cycleEdgeSet, cycleNodeSet, edgeKey,
  entryStatusOf, normalizeArrivals, pickStrongestArrival, rankRemaining, remainingLabel,
} = depModule;

assert.equal(remainingLabel(null), "不限深度", "无限剩余深度显示成人话而不是 null");
assert.equal(remainingLabel(undefined), "不限深度");
assert.equal(remainingLabel(3), "还剩 3 跳");
assert.ok(remainingLabel(0).includes("用尽"));
assert.equal(rankRemaining(null), Number.POSITIVE_INFINITY);
assert.ok(rankRemaining(0) < rankRemaining(null));
assert.equal(edgeKey("a", "b"), "a\u0000b");

// 多源到达：保留最大剩余深度
const multiArrival = [
  { uid: "x", name: "X", parent_uid: "a", child_uids: [], depth: 2, remaining: 0, is_root: false, relation: "requires" },
  { uid: "x", name: "X", parent_uid: "b", child_uids: [], depth: 1, remaining: 3, is_root: false, relation: "requires" },
];
const arrival = normalizeArrivals(multiArrival);
assert.equal(arrival.primary.get("x").remaining, 3, "同一 uid 保留剩余深度最大的那次到达");
assert.equal(arrival.primary.get("x").parent_uid, "b");
assert.equal(arrival.repeated.length, 1, "被覆盖的到达进 repeated");
assert.equal(pickStrongestArrival(multiArrival).remaining, 3);
assert.equal(pickStrongestArrival([{ remaining: 3 }, { remaining: null }]).remaining, null,
  "不限深度是最强的一次到达");
assert.equal(pickStrongestArrival([]), null);
assert.equal(normalizeArrivals([multiArrival[0], { ...multiArrival[1] }]).primary.size, 1);

// 主夹具：多源到达 + 状态徽标 + 环外的 related
const depFixture = {
  entry_uids: ["a"],
  nodes: [
    { uid: "a", name: "A", parent_uid: null, child_uids: ["b", "c"], depth: 0, remaining: null, is_root: true, relation: "requires" },
    { uid: "b", name: "B", parent_uid: "a", child_uids: ["d"], depth: 1, remaining: null, is_root: false, relation: "requires" },
    { uid: "c", name: "C", parent_uid: "a", child_uids: ["d"], depth: 1, remaining: 2, is_root: false, relation: "requires" },
    { uid: "d", name: "D", parent_uid: "b", child_uids: ["e"], depth: 2, remaining: null, is_root: false, relation: "requires" },
    { uid: "e", name: "E", parent_uid: "d", child_uids: [], depth: 3, remaining: 0, is_root: false, relation: "requires" },
  ],
  edges: [
    { from_uid: "a", to_uid: "b", relation: "requires", status: "skeleton" },
    { from_uid: "a", to_uid: "c", relation: "requires", status: "skeleton" },
    { from_uid: "b", to_uid: "d", relation: "requires", status: "skeleton" },
    { from_uid: "c", to_uid: "d", relation: "requires", status: "cross" },
    { from_uid: "d", to_uid: "e", relation: "requires", status: "skeleton" },
    { from_uid: "b", to_uid: "z", relation: "related", status: "idle" },
  ],
  cycles: [],
  issues: [
    { code: "disabled_entry", severity: "warning", uid: "c", message: "条目已停用" },
    { code: "empty_content", severity: "warning", uid: "e", message: "正文为空" },
  ],
};
const flatRows = (rows) => rows.flatMap((row) => [row, ...flatRows(row.children)]);
const shallow = buildDependencyTree(depFixture, { rootUids: ["a"], expandedDepth: 1 });
assert.equal(shallow.rows.length, 1);
assert.equal(shallow.rows[0].uid, "a");
assert.equal(shallow.rows[0].isRoot, true);
assert.deepEqual(shallow.rows[0].children.map((row) => row.uid), ["b", "c"], "默认展开 1 层、子节点按 uid 稳定排序");
assert.deepEqual(shallow.rows[0].children.map((row) => row.depth), [1, 1]);
assert.equal(shallow.rows[0].requiresChildCount, 2, "徽标显示 requires 出边数");
assert.equal(shallow.rows[0].children[0].expanded, false, "默认只展开一层");
assert.equal(shallow.rows[0].children[0].remainingLabel, "不限深度");
assert.equal(shallow.rows[0].children[1].remainingLabel, "还剩 2 跳");
assert.equal(shallow.rows[0].children[1].statusLabel, "停用", "issues.disabled_entry → 停用徽标");
assert.deepEqual(shallow.rows[0].children[0].relatedUids, [{ uid: "z", name: "z" }],
  "related 出边只作行内提示");
assert.equal(shallow.primaryCount, 5);
assert.equal(shallow.requiresEdgeCount, 5);
assert.equal(shallow.relatedEdgeCount, 1);
assert.ok(!flatRows(shallow.rows).some((row) => row.uid === "z"), "related 目标不成为可展开的行");

const deep = buildDependencyTree(depFixture, { rootUids: ["a"], expandedDepth: 4 });
const deepRows = flatRows(deep.rows);
assert.deepEqual(deepRows.map((row) => row.uid), ["a", "b", "d", "e", "c", "d"]);
const repeatRow = deepRows[5];
assert.equal(repeatRow.uid, "d");
assert.equal(repeatRow.repeated, true, "同一 uid 第二次到达标灰");
assert.equal(repeatRow.dimmed, true);
assert.equal(repeatRow.duplicateOf, "a\u0000b\u0000d", "记住首次到达的位置");
assert.equal(repeatRow.duplicatePath, "A → B → D", "首次到达的路径由 parent_uid 回溯得到");
assert.ok(repeatRow.stopNote.includes("重复到达"));
assert.equal(repeatRow.forceable, true, "重复行提供「仍要展开（仅查看）」");
assert.equal(repeatRow.expanded, false, "重复行默认不再展开子树");
const forcedRepeat = buildDependencyTree(depFixture, { rootUids: ["a"], expandedDepth: 4, forced: [repeatRow.key] });
const forcedRow = flatRows(forcedRepeat.rows).find((row) => row.key === repeatRow.key);
assert.equal(forcedRow.expanded, true, "强制展开后子树出现");
assert.ok(forcedRow.children.length >= 1);
assert.ok(forcedRow.children.every((row) => row.dimmed), "被强制展开的重复子树整棵同为灰色");
const leafRow = deepRows.find((row) => row.uid === "e");
assert.equal(leafRow.expandable, false);
assert.ok(leafRow.stopNote.includes("用尽"), "remaining==0 由服务端终止，前端只说明原因");
assert.equal(leafRow.statusLabel, "正文为空");
const onlyRequires = buildDependencyTree(depFixture, { rootUids: ["a"], expandedDepth: 4, requiresOnly: true });
assert.deepEqual(flatRows(onlyRequires.rows).find((row) => row.uid === "b").relatedUids, [],
  "只看 requires 时隐藏 related 提示");
assert.equal(buildDependencyTree(depFixture, { rootUids: ["a"], expandedDepth: 0 }).rows[0].children.length, 0,
  "折叠全部：只留根行");

// breadcrumb：逐级回溯 + 父链成环时终止
const depLookup = new Map(depFixture.nodes.map((node) => [node.uid, node]));
assert.deepEqual(breadcrumbUids(depLookup, "e"), ["a", "b", "d", "e"]);
assert.equal(breadcrumbLabel(depLookup, "e"), "A → B → D → E");
assert.deepEqual(breadcrumbUids(depLookup, "a"), ["a"]);
assert.deepEqual(breadcrumbUids(depLookup, "nope"), ["nope"], "未知 uid 只回自己，不猜父链");
const parentCycle = new Map([
  ["p", { uid: "p", name: "P", parent_uid: "q" }],
  ["q", { uid: "q", name: "Q", parent_uid: "p" }],
]);
assert.ok(breadcrumbUids(parentCycle, "p").length <= 2, "父链成环时立即停止，不无限循环");

// 环：环内边标红、环内节点不再向下展开
const cycleFixture = {
  entry_uids: ["r"],
  nodes: [
    { uid: "r", name: "R", parent_uid: null, child_uids: ["p"], depth: 0, remaining: null, is_root: true, relation: "requires" },
    { uid: "p", name: "P", parent_uid: "r", child_uids: ["q"], depth: 1, remaining: null, is_root: false, relation: "requires" },
    { uid: "q", name: "Q", parent_uid: "p", child_uids: ["p"], depth: 2, remaining: null, is_root: false, relation: "requires" },
  ],
  edges: [
    { from_uid: "r", to_uid: "p", relation: "requires", status: "skeleton" },
    { from_uid: "p", to_uid: "q", relation: "requires", status: "skeleton" },
    { from_uid: "q", to_uid: "p", relation: "requires", status: "cross" },
  ],
  cycles: [["p", "q", "p"]],
  issues: [],
};
assert.deepEqual([...cycleEdgeSet(cycleFixture.cycles)].sort(), [edgeKey("p", "q"), edgeKey("q", "p")].sort());
assert.deepEqual([...cycleNodeSet(cycleFixture.cycles)].sort(), ["p", "q"]);
const cycleTree = buildDependencyTree(cycleFixture, { rootUids: ["r"], expandedDepth: 32 });
const cycleRows = flatRows(cycleTree.rows);
assert.deepEqual(cycleRows.map((row) => row.uid), ["r", "p", "q"], "环的第一跳仍然显示出来");
const cycleRow = cycleRows[2];
assert.equal(cycleRow.viaCycleEdge, true, "到达边在环内 → 行标红并标「依赖环」");
assert.equal(cycleRow.inCycle, true);
assert.equal(cycleRow.expandable, false);
assert.equal(cycleRow.children.length, 0, "环内节点不再向下展开（前端不自行截断，交由服务端终止）");
assert.equal(cycleRow.stopNote, CYCLE_STOP_NOTE);
assert.equal(cycleRows[1].inCycle, true);
assert.equal(cycleRows[0].viaCycleEdge, false, "根行没有到达边");

// 条目状态徽标与悬空依赖
assert.deepEqual(entryStatusOf(depFixture.issues, "c"), { code: "disabled_entry", label: "停用" });
assert.deepEqual(entryStatusOf(depFixture.issues, "e"), { code: "empty_content", label: "正文为空" });
assert.deepEqual(entryStatusOf([{ code: "missing_entry", uid: "m" }], "m"), { code: "missing_entry", label: "不存在" });
assert.equal(entryStatusOf(depFixture.issues, "a").code, "");
assert.equal(entryStatusOf(null, "a").code, "");
const dangling = buildDependencyTree({
  nodes: depFixture.nodes,
  edges: [...depFixture.edges, { from_uid: "c", to_uid: "ghost", relation: "requires", status: "skeleton" }],
  cycles: [], issues: [],
}, { rootUids: ["a"], expandedDepth: 2, names: { ghost: "幽灵条目" } });
const ghostRow = flatRows(dangling.rows).find((row) => row.uid === "ghost");
assert.equal(ghostRow.statusLabel, "不存在", "依赖指向不存在的条目时明确标出");
assert.equal(ghostRow.name, "幽灵条目");

// 显示上限只影响渲染
const chainNodes = [];
const chainEdges = [];
for (let index = 0; index < 460; index += 1) {
  chainNodes.push({
    uid: `c${index}`, name: `C${index}`, parent_uid: index ? `c${index - 1}` : null,
    child_uids: index + 1 < 460 ? [`c${index + 1}`] : [], depth: index,
    remaining: null, is_root: index === 0, relation: "requires",
  });
  if (index) chainEdges.push({ from_uid: `c${index - 1}`, to_uid: `c${index}`, relation: "requires", status: "skeleton" });
}
const chainTree = buildDependencyTree({ nodes: chainNodes, edges: chainEdges, cycles: [], issues: [] },
  { rootUids: ["c0"], expandedDepth: 999 });
assert.equal(chainTree.truncated, true);
assert.equal(chainTree.rowCount, MAX_DEPENDENCY_TREE_ROWS, "超过显示上限只截断渲染");
assert.equal(RELATION_LABELS.requires, "必要依赖");
assert.equal(RELATION_LABELS.related, "仅提示相关");

// ── WU-E · SSR：Prompt 预览页签与依赖展开树 ────────────────────────────────
// 静态渲染不跑 effect，因此不会有网络请求：这里只断言无数据 / 加载中的骨架与写死文案。
const promptTabModule = require(path.join(root, "frontend/src/components/worldbook/tabs/PromptPreviewTab.tsx"));
const promptMarkup = renderToStaticMarkup(React.createElement(promptTabModule.default, {
  ctx: panel, onNotice() {}, onReload: async () => {},
}));
for (const expected of ["Prompt 预览", "世界书插入内容", "静态层", "动态层", "最终文本", "复制本层文本", "动态层触发方式"]) {
  assert.ok(promptMarkup.includes(expected), `Prompt 预览应包含「${expected}」`);
}
for (const removed of ["当前输入", "最近对话", "手动追加条目", "试选阵容", "未插入条目", "条目与顺序", "宿主提示词骨架", "token 预算"]) {
  assert.ok(!promptMarkup.includes(removed), `Prompt 预览不再显示「${removed}」`);
}
assert.ok(promptMarkup.includes(promptTabModule.PROMPT_PREVIEW_SCOPE_NOTE));
assert.ok(promptMarkup.includes(promptTabModule.DYNAMIC_TRIGGER_NOTE));
assert.ok(promptMarkup.includes('aria-describedby="wbpp-trigger-help"'));

const entryTreeModule = require(path.join(root, "frontend/src/components/worldbook/EntryDependencyTree.tsx"));
// 有 requires 出边：渲染折叠三角 + 出边数
const depMarkup = renderToStaticMarkup(React.createElement(entryTreeModule.default, {
  detail, rootUids: ["amiya"], draft, patch() {}, onNotice() {},
}));
assert.ok(depMarkup.includes("依赖条目"), "有 requires 出边时渲染简洁的依赖阅读入口");
assert.ok(depMarkup.includes("▸") && depMarkup.includes('aria-expanded="false"'), "默认收起，展开 1 层由组件内部状态控制");
// 没有 requires 出边：不渲染入口，避免每条卡片出现无用说明
const leafMarkup = renderToStaticMarkup(React.createElement(entryTreeModule.default, {
  detail, rootUids: ["world"], draft, patch() {}, onNotice() {},
}));
assert.equal(leafMarkup, "");
const rowsMarkup = renderToStaticMarkup(React.createElement(entryTreeModule.DependencyTreeRows, {
  tree: deep, requiresOnly: false,
}));
for (const expected of [STATIC_RELATION_NOTE, "这是静态依赖关系", "不代表该条目本轮一定载入",
  "已在上层展开（路径：", "A → B → D", "仍要展开（仅查看）", "不限深度", "必要依赖", "仅提示相关",
  "wbd-row is-dim", "wbd-children"]) {
  assert.ok(rowsMarkup.includes(expected), `依赖树渲染应包含「${expected}」`);
}
assert.ok(rowsMarkup.includes("不参与展开"), "related 行写明不参与展开");
assert.ok(!renderToStaticMarkup(React.createElement(entryTreeModule.DependencyTreeRows, {
  tree: deep, requiresOnly: true,
})).includes("仅提示相关"), "只看 requires 时隐藏 related 行");
assert.ok(renderToStaticMarkup(React.createElement(entryTreeModule.DependencyTreeRows, {
  tree: cycleTree, requiresOnly: false,
})).includes("依赖环"), "环内边标记为依赖环");
assert.ok(!renderToStaticMarkup(React.createElement(entryTreeModule.DependencyTreeRows, {
  tree: deep, requiresOnly: false,
})).includes("世界书图谱"), "R-22：旧说法不出现在依赖展开里");

console.log("Worldbook UI: 分类树工具、批量起点/依赖/归属、候选范围预览、分类结构 SSR、工作台页签骨架、"
  + "Prompt 预览与依赖展开树的纯函数与 SSR 断言全部通过。");
