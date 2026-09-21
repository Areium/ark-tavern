// 不启动浏览器：检验世界书节点视图（A-4 / 提案 §3.4）的纯逻辑（轨道排序、灰节点去重口径、
// 确定性布局、统计、视觉映射）与真实 React 组件的服务端渲染结构。
//
// 范围与契约 R-23 对齐：节点视图的断言落在本文件，`scripts/test_worldbook_scope_ui.cjs`
// 继续承担分类树 / 批量 / Prompt 预览 / 依赖展开树。
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

const nodeView = require(path.join(root, "frontend/src/utils/worldbookNodeView.ts"));
const {
  DEFAULT_EXPAND_NODE_BUDGET, SUBTREE_NODE_LIMIT, TRACK_VIRTUALIZE_THRESHOLD,
  buildNodeViewModel, canAddRequiresEdge, defaultExpandedKeys, depthForNodeBudget, downstreamCount,
  edgeVisual, expandKeysToDepth, findCycleEdgeKeys, layoutTrack, summarize, trackOrder, truncateSubtree,
} = nodeView;
const nodeTabModule = require(path.join(root, "frontend/src/components/worldbook/tabs/NodeViewTab.tsx"));
const NodeViewTab = nodeTabModule.default;
const appStoreModule = require(path.join(root, "frontend/src/stores/appStore.ts"));

// ── 夹具：一本书 = 轨道（启用且有正文）+ 展开（多条 requires 路径 + 环 + 超深度 + 非轨道条目）──
const category = { id: "story", name: "剧情", parent_id: null, scope_type: "other", sort_order: 1 };
const makeEntry = (uid, name, over = {}) => ({
  uid, name, content: `正文：${name}`, trigger_keys: [], secondary_keys: [], always_active: false,
  selective: false, enabled: true, position: 0, depth: 4, scan_depth: 4, probability: 100,
  group: "", group_weight: 100, case_sensitive: false, match_whole_words: false,
  category_id: "story", ...over,
});
const entries = [
  makeEntry("root_a", "起点A"),
  makeEntry("root_c", "起点C", { group_weight: 120 }),
  makeEntry("shared", "共享依赖", { group_weight: 80 }),
  makeEntry("loop1", "环一", { position: 1 }),
  makeEntry("loop2", "环二", { position: 1, depth: 2 }),
  makeEntry("capped_target", "超深度目标", { position: 1 }),
  makeEntry("loose", "游离条目", { position: 1 }),
  makeEntry("offtrack", "停用依赖", { enabled: false }),
  makeEntry("blank", "空正文条目", { content: "" }),
  makeEntry("ghost_target", "深不见底", { enabled: false }),
];
const detail = {
  id: "qa-nodes", name: "节点视图夹具", book_type: "story",
  categories: [category], scope_mode: "selective",
  entries, dependency_edges: [], related_edges: [],
  import_config: { revision: 1, fixed_entry_uids: [], dependency_sources: [] },
};
const nameOf = (uid) => entries.find((item) => item.uid === uid)?.name || uid;
// `repeated` 按 WU-D 的实现口径给：闭包内 requires 入边多于一条 ⇒ 预告该 uid 还会以灰节点出现。
const row = (uid, parentUid, depth, displayIndex, childUids = [], repeated = false) => ({
  uid, name: nameOf(uid), root_uid: "root_a", depth, parent_uid: parentUid, child_uids: childUids,
  remaining: null, is_root: parentUid === null,
  repeated, first_parent_uid: parentUid, display_index: displayIndex,
});
// display_tree 按 (depth, uid) 排序（与 resolve_v3_scope 的稳定主路径树一致）
const displayTree = [
  row("root_a", null, 0, 0, ["blank", "c1", "offtrack", "shared"]),
  row("root_c", null, 0, 1, []),
  row("blank", "root_a", 1, 2, []),
  row("c1", "root_a", 1, 3, ["loop1"]),
  row("offtrack", "root_a", 1, 4, []),
  row("shared", "root_a", 1, 5, [], true),     // 入边：root_a（主路径）+ root_c（cross）
  row("loop1", "c1", 2, 6, ["loop2"], true),   // 入边：c1（主路径）+ loop2（cross）
  row("loop2", "loop1", 3, 7, []),             // 入边只有 loop1（主路径）
];
const resolvedEdges = [
  { from_uid: "root_a", to_uid: "shared", relation: "requires", active: true, status: "skeleton" },
  { from_uid: "root_a", to_uid: "c1", relation: "requires", active: true, status: "skeleton" },
  { from_uid: "root_a", to_uid: "offtrack", relation: "requires", active: true, status: "skeleton" },
  { from_uid: "root_a", to_uid: "blank", relation: "requires", active: true, status: "skeleton" },
  { from_uid: "c1", to_uid: "loop1", relation: "requires", active: true, status: "skeleton" },
  { from_uid: "loop1", to_uid: "loop2", relation: "requires", active: true, status: "skeleton" },
  { from_uid: "loop2", to_uid: "loop1", relation: "requires", active: true, status: "cross" },
  { from_uid: "root_c", to_uid: "shared", relation: "requires", active: true, status: "cross" },
  { from_uid: "root_c", to_uid: "capped_target", relation: "requires", active: false, status: "capped" },
  { from_uid: "loop2", to_uid: "ghost_target", relation: "requires", active: false, status: "capped" },
  { from_uid: "shared", to_uid: "c1", relation: "related", active: false, status: "idle" },
  { from_uid: "loose", to_uid: "capped_target", relation: "related", active: false, status: "idle" },
];
const activeRoots = [
  { entry_uid: "root_a", activation: "always", expansion: "requires_closure" },
  { entry_uid: "root_c", activation: "roster_any", expansion: "legacy_depth", max_depth: 0 },
];
const issues = [
  { code: "missing_entry", severity: "error", uid: "c1", message: "依赖引用了不存在的条目 c1" },
  { code: "disabled_entry", severity: "warning", uid: "offtrack", message: "停用依赖 已停用，不会注入" },
  { code: "empty_content", severity: "warning", uid: "blank", message: "空正文条目 正文为空" },
];
const preview = {
  scope: { book_id: detail.id, resolved_entry_uids: displayTree.map((item) => item.uid), selection_reasons: {} },
  entry_count: 8, full_entry_count: 10, full_estimated_tokens: 1000, resolved_estimated_tokens: 100,
  saved_estimated_tokens: 900, saved_percent: 90, breakdown: {}, warnings: [],
  schema_version: 3, resolver_version: 3, active_roots: activeRoots,
  resolved_edges: resolvedEdges, display_tree: displayTree, cross_references: [], issues,
};
const promptOrder = {
  bookId: detail.id, mode: "narrative",
  order: [
    { uid: "shared", seq: 0, layer: "stable", position: 0, group_weight: 80, depth: 4 },
    { uid: "root_a", seq: 1, layer: "dynamic", position: 0, group_weight: 100, depth: 4 },
    { uid: "loose", seq: 2, layer: "dynamic", position: 1, group_weight: 100, depth: 4 },
  ],
};

// ── trackOrder：与 src/world_book.py:1380 逐字一致的排序键 ────────────────────
const track = trackOrder(entries);
assert.deepEqual(track.map((item) => item.uid),
  ["root_c", "root_a", "shared", "loop2", "capped_target", "loop1", "loose"],
  "position 升序 → group_weight 降序 → depth 升序 → uid 升序");
assert.deepEqual(track.map((item) => item.seq), [0, 1, 2, 3, 4, 5, 6], "seq 是 0-based 位次");
assert.equal(track[0].group_weight, 120, "position 相同时 group_weight 大的在前（对抗用例）");
assert.equal(track.find((item) => item.uid === "loop2").depth, 2,
  "同 position 同 weight 时 depth 小的在前（对抗用例）");
assert.deepEqual(track.filter((item) => item.position === 1).map((item) => item.uid),
  ["loop2", "capped_target", "loop1", "loose"], "同名次内 uid 升序兜底");
assert.ok(!track.some((item) => item.uid === "offtrack"), "停用条目不进轨道");
assert.ok(!track.some((item) => item.uid === "blank"), "空正文条目不进轨道");
assert.deepEqual(trackOrder(entries), track, "同输入两次结果一致");
assert.deepEqual(trackOrder([entries[4], entries[0]]).map((item) => item.uid), ["root_a", "loop2"],
  "少量条目也按同一排序键");
const adversarial = trackOrder([
  makeEntry("b", "B", { position: 1, group_weight: 100, depth: 4 }),
  makeEntry("a", "A", { position: 1, group_weight: 100, depth: 4 }),
  makeEntry("c", "C", { position: 1, group_weight: 140, depth: 9 }),
  makeEntry("d", "D", { position: 0, group_weight: 1, depth: 9 }),
]);
assert.deepEqual(adversarial.map((item) => item.uid), ["d", "c", "a", "b"],
  "position 优先于 group_weight；uid 是最后的稳定兜底");

// ── buildNodeViewModel：主/灰口径（R-10 澄清：轨道优先，否则 first_parent_uid 指向的那次）──
const model = buildNodeViewModel(preview, detail, promptOrder);
const keys = model.nodes.map((node) => node.key);
assert.deepEqual(keys.slice(0, 7),
  ["track#root_c", "track#root_a", "track#shared", "track#loop2", "track#capped_target", "track#loop1", "track#loose"],
  "轨道节点按位次排在前面，且每个 uid 一个节点");
assert.equal(model.nodes.length, 16,
  "7 个轨道 + 6 个主到达展开位置 + 2 个 cross 重复到达 + 1 个 capped 只读占位");
const nodeOf = (key) => model.byKey[key];
const primaryUids = model.nodes.filter((node) => node.isPrimary).map((node) => node.uid);
assert.equal(new Set(primaryUids).size, primaryUids.length, "主节点唯一：同一 uid 只允许一个主节点");
assert.deepEqual(primaryUids.filter((uid) => uid === "shared"), ["shared"]);
assert.equal(nodeOf("track#shared").isPrimary, true, "轨道上的出现优先当主节点");
assert.equal(nodeOf("track#shared").isRepeated, false);
assert.equal(nodeOf("tree#shared#5").isRepeated, true, "轨道上的 uid：所有向下展开的出现位置一律灰");
assert.equal(nodeOf("tree#shared#5").isPrimary, false, "灰节点不是主节点");
assert.equal(nodeOf("tree#shared#5").parentKey, "track#root_a", "灰节点挂在它的到达父节点下");
assert.equal(nodeOf("tree#shared#5").arrivalFrom, "root_a", "主到达的那一次仍然是它自己的那次到达");
assert.equal(nodeOf("cross#shared#root_c").isExtraArrival, true, "cross 边带来的到达是额外出现位置");
assert.equal(nodeOf("cross#shared#root_c").isRepeated, true, "额外出现位置一律灰");
assert.equal(nodeOf("cross#shared#root_c").isPrimary, false);
assert.equal(nodeOf("cross#shared#root_c").parentKey, "track#root_c", "灰节点挂在边起点的主节点下");
assert.equal(nodeOf("cross#shared#root_c").arrivalStatus, "cross");
assert.equal(nodeOf("track#shared").hasRepeatedArrival, true, "服务端 repeated 预告该 uid 会另有灰出现");
assert.equal(nodeOf("tree#loop2#7").hasRepeatedArrival, false, "单父条目不带这个预告");
assert.equal(nodeOf("tree#c1#3").isPrimary, true, "轨道上没有（条目不存在）时，first_parent_uid 指向的那次是主节点");
assert.equal(nodeOf("tree#c1#3").isRepeated, false, "非轨道的主节点不是灰节点");
assert.equal(nodeOf("tree#offtrack#4").isPrimary, true, "轨道上没有（条目已停用）时同理");
assert.equal(nodeOf("tree#blank#2").isPrimary, true, "空正文条目同样以 first_parent_uid 指向的那次为主节点");
assert.equal(nodeOf("tree#root_a#0"), undefined, "根行与轨道主节点合并，不产生重复节点");
assert.equal(nodeOf("track#root_a").displayIndex, 0, "合并后轨道节点带上 display_tree 位次");
assert.equal(nodeOf("track#root_a").isRoot, true);
assert.equal(nodeOf("track#root_a").rootBadge.activation, "always");
assert.equal(nodeOf("track#root_a").rootBadge.expansionLabel, "补齐必要依赖");
assert.equal(nodeOf("track#root_c").rootBadge.activationLabel, "角色入队时选用");
assert.equal(nodeOf("track#root_c").rootBadge.expansionLabel, "按旧深度展开 +0",
  "legacy_depth 徽标带 +N");
assert.equal(nodeOf("track#loose").loose, true, "未被任何起点覆盖的条目留在轨道上并标游离");
assert.equal(nodeOf("track#root_a").loose, false, "被覆盖的轨道条目不是游离");
// repeated 与服务端 cross 边的一致性：有额外到达 ⇒ repeated 必须为 true
const extraArrivalUids = new Set(model.nodes.filter((node) => node.isExtraArrival).map((node) => node.uid));
assert.deepEqual([...extraArrivalUids].sort(), ["loop1", "shared"], "cross 边带来两次重复到达");
for (const uid of extraArrivalUids) {
  const ref = displayTree.find((item) => item.uid === uid);
  assert.equal(ref.repeated, true, `repeated 精确预告了 ${uid} 会另有灰出现`);
}
assert.ok(!model.warnings.some((text) => text.includes("repeated")),
  "本夹具的 repeated 与 cross 边一致，不产生不一致告警");

// 灰节点不参与序号与统计：即便本轮命中了它
assert.equal(nodeOf("track#shared").actualSeq, 0, "本轮命中序号叠在主节点上");
assert.equal(nodeOf("track#shared").actualLayer, "stable");
assert.equal(nodeOf("tree#shared#5").actualSeq, null, "灰节点不叠加本轮序号");
assert.equal(nodeOf("tree#shared#5").trackSeq, null, "灰节点没有轨道位次");
assert.equal(nodeOf("track#runtime"), undefined);
assert.equal(nodeOf("track#loose").actualSeq, 2, "不在候选范围但本轮命中的条目也能叠加实际序号");
assert.equal(model.promptOrderApplied, true);
assert.equal(model.primaryCount, 10, "主节点 = 7 轨道 + 3 个非轨道主到达");
assert.equal(model.repeatedCount, 6, "灰节点 = 3 个轨道重复展开 + 2 个 cross 重复到达 + 1 个 capped 占位");
const otherBook = buildNodeViewModel(preview, detail, { ...promptOrder, bookId: "another-book" });
assert.equal(otherBook.promptOrderApplied, false, "别本书的 Prompt 预览结果不叠加");
assert.ok(otherBook.nodes.every((node) => node.actualSeq === null));

// 问题徽标来自 preview.issues，按 uid 关联
assert.deepEqual(nodeOf("tree#c1#3").problems.map((item) => item.code), ["missing_entry"]);
assert.deepEqual(nodeOf("tree#offtrack#4").problems.map((item) => item.code), ["disabled_entry"]);
assert.deepEqual(nodeOf("tree#blank#2").problems.map((item) => item.code), ["empty_content"]);
assert.deepEqual(nodeOf("track#root_a").problems, [], "没有问题的条目不带问题徽标");

// 灰节点只读视图：保留可展开手柄（下游可能带出别处没有的节点）与首次出现跳转
assert.deepEqual(nodeOf("track#root_a").childKeys.map((key) => nodeOf(key).uid),
  ["blank", "c1", "offtrack", "shared"], "同父的子按 uid 稳定排序");
assert.deepEqual(nodeOf("tree#c1#3").childKeys, ["tree#loop1#6"]);
assert.deepEqual(nodeOf("track#loop2").childKeys, ["ghost#ghost_target", "cross#loop1#loop2"],
  "capped 目标给只读占位节点、cross 到达给灰出现位置，都挂在起点主节点下（同父按 uid 稳定排序）");
assert.equal(nodeOf("ghost#ghost_target").ghost, true);
assert.equal(nodeOf("ghost#ghost_target").isRepeated, true);
assert.equal(nodeOf("ghost#ghost_target").arrivalStatus, "capped");
assert.deepEqual(nodeOf("ghost#ghost_target").path.map((step) => step.uid), ["loop2", "ghost_target"]);
assert.deepEqual(nodeOf("tree#shared#5").path.map((step) => step.uid), ["root_a", "shared"],
  "灰节点的 breadcrumb 就是它的到达路径");

// 边：skeleton / cross / capped / related，环内边标红
const edgeOf = (kind, fromUid, toUid) => model.edges.find(
  (edge) => edge.kind === kind && edge.fromUid === fromUid && edge.toUid === toUid);
assert.equal(model.edges.filter((edge) => edge.kind === "skeleton").length, 6,
  "skeleton = display_tree 的父子关系");
const crossEdge = edgeOf("cross", "root_c", "shared");
assert.ok(crossEdge, "cross 边来自 resolved_edges");
assert.equal(crossEdge.toKey, "cross#shared#root_c", "cross 边指向这次到达自己的灰出现位置");
assert.equal(nodeOf(crossEdge.toKey).isRepeated, true, "cross 边目标渲染为灰节点（§3.4.4）");
assert.equal(nodeOf(crossEdge.toKey).parentKey, crossEdge.fromKey, "灰节点就挂在边起点的主节点下");
assert.equal(edgeVisual(crossEdge.status, crossEdge.relation).lineStyle, "solid");
assert.equal(nodeOf(edgeOf("capped", "root_c", "capped_target").toKey).uid, "capped_target",
  "capped 边指向目标主节点（在轨道上）");
const cappedGhost = edgeOf("capped", "loop2", "ghost_target");
assert.equal(cappedGhost.toKey, "ghost#ghost_target");
assert.equal(edgeVisual(cappedGhost.status, cappedGhost.relation).lineStyle, "dashed");
const relatedEdge = edgeOf("related", "shared", "c1");
assert.ok(relatedEdge, "两端都在闭包内才画 related 点线");
assert.equal(edgeVisual(relatedEdge.status, relatedEdge.relation).lineStyle, "dotted");
assert.ok(!model.edges.some((edge) => edge.kind === "related" && (edge.fromUid === "loose" || edge.toUid === "loose")),
  "related 画在闭包之外只会糊成一片，因此不画");
assert.equal(model.edges.filter((edge) => edge.inCycle).length, 2, "环内两条边");
const cycleEdge = model.edges.find((edge) => edge.inCycle);
assert.equal(edgeVisual(cycleEdge.status, cycleEdge.relation, cycleEdge.inCycle).colorRole, "cycle",
  "环内边标红虚线（覆盖 status 的默认视觉）");
assert.deepEqual(model.cycleEdgeKeys, ["loop1|loop2", "loop2|loop1"]);
assert.deepEqual(model.coveredUids,
  ["blank", "c1", "loop1", "loop2", "offtrack", "root_a", "root_c", "shared"], "范围计数去重，只算主节点");

// 服务端派生字段缺失时优雅降级（WU-D 尚未落地也不会崩）
const legacyRows = displayTree.map(({ repeated, first_parent_uid, display_index, ...rest }) => rest);
const legacyModel = buildNodeViewModel({ ...preview, display_tree: legacyRows }, detail, null);
assert.ok(legacyModel.warnings.some((text) => text.includes("派生字段")), "缺派生字段时给出降级提示");
assert.ok(legacyModel.warnings.some((text) => text.includes("first_parent_uid")), "并说明主到达按位次降级");
assert.equal(legacyModel.byKey["track#shared"].isPrimary, true, "降级后依然轨道优先");
assert.equal(legacyModel.byKey["tree#shared#5"].isRepeated, true, "降级后依然把轨道条目的展开位置标灰");
assert.equal(legacyModel.byKey["tree#c1#3"].isPrimary, true, "降级后非轨道条目仍取显示位次最早的到达为主");
assert.ok(!legacyModel.warnings.some((text) => text.includes("多父边")),
  "字段缺失时不会误报「repeated 与 cross 边不一致」");
const noTreeModel = buildNodeViewModel({ ...preview, display_tree: [] }, detail, null);
assert.equal(noTreeModel.track.length, 7, "没有 display_tree 时只渲染轨道");
assert.equal(noTreeModel.nodes.filter((node) => node.kind === "ghost").length, 1,
  "没有 display_tree 时，capped 边仍给出深度用尽的只读占位节点");
assert.equal(noTreeModel.nodes.filter((node) => node.kind === "expansion").length, 0, "不画依赖展开");
assert.ok(noTreeModel.warnings.some((text) => text.includes("display_tree")));

// ── summarize：六项统计 ─────────────────────────────────────────────────────
assert.deepEqual(summarize(model, preview, 0),
  { roots: 2, inScope: 8, uncovered: 2, cycles: 2, cappedEdges: 2, hidden: 0 },
  "起点数 / 已在范围内 / 未被任何起点覆盖 / 依赖环 / 超深度边 / 隐藏节点数");
assert.equal(summarize(model, preview, 5).hidden, 5, "隐藏节点数由布局的截断结果传入");
assert.equal(model.track.length - summarize(model, preview, 0).uncovered, 5,
  "未覆盖只算轨道上的条目");

// ── 布局：确定性、父居中、同父 uid 稳定排序、规模控制 ────────────────────────
const defaultExpanded = defaultExpandedKeys(model);
assert.deepEqual(defaultExpanded, ["track#root_a", "track#root_c"],
  "默认展开已激活起点：root_a 有主路径子节点，root_c 有 cross 重复到达");
const first = layoutTrack(model, { expanded: defaultExpanded });
const second = layoutTrack(model, { expanded: defaultExpanded });
assert.deepEqual(first, second, "同输入两次布局结果完全一致（确定性）");
assert.equal(first.nodes.length, 12, "默认只渲染已展开起点的子树（7 轨道 + 4 + 1）");
assert.equal(first.topLevelCount, 7, "轨道 7 条");
assert.equal(first.hiddenCount, 0);
assert.equal(first.width > 0 && first.height > 0, true);
const placeOf = (layout, key) => layout.nodes.find((node) => node.key === key);
assert.equal(placeOf(first, "track#root_a").y, placeOf(first, "track#root_c").y, "轨道全在 y=0 这一行");
assert.ok(placeOf(first, "track#root_a").x < placeOf(first, "track#capped_target").x,
  "轨道严格从左到右单调，不重新分组");
const parent = placeOf(first, "track#root_a");
const kids = nodeOf("track#root_a").childKeys.map((key) => placeOf(first, key)).sort((a, b) => a.x - b.x);
assert.equal(kids.map((item) => item.uid).join(","), "blank,c1,offtrack,shared", "同父的子按 uid 稳定排序");
assert.ok(Math.abs((parent.x + parent.width / 2)
  - (kids[0].x + kids[kids.length - 1].x + kids[0].width) / 2) < 0.01,
  "父节点居中于子节点群");
assert.ok(kids.every((item) => item.y === parent.y + 96), "逐层向下展开");
assert.equal(new Set(kids.map((item) => item.x)).size, kids.length, "同层子节点不重叠");
assert.deepEqual(placeOf(first, "track#root_a").bandKey, "track#root_a");
assert.deepEqual(placeOf(first, "tree#shared#5").bandKey, "track#root_a",
  "展开节点归属到它的轨道带，虚拟化按带整取整舍");
assert.deepEqual(first.bands.map((band) => band.key), model.track.map((trackRow) => trackRow.key));
assert.equal(first.bands[0].x0 <= first.bands[1].x0, true, "缩略进度条按 x 排序");

const allExpanded = layoutTrack(model, { expanded: keys });
assert.equal(allExpanded.nodes.length, 16, "全部展开渲染所有节点（含 cross 重复到达与 capped 占位）");
assert.equal(allExpanded.hiddenCount, 0);
assert.equal(allExpanded.edges.length, model.edges.length, "边两端都渲染时才画");

// 筛选：只渲染选中的轨道条目（连它的子树一起取舍）
const filtered = layoutTrack(model, { expanded: keys, trackUids: ["root_a", "loose"] });
assert.deepEqual(filtered.nodes.filter((node) => node.topLevel).map((node) => node.uid), ["root_a", "loose"]);

// 轨道 264 条（预装整合包量级）：不出现异常，也不截断轨道
const manyEntries = Array.from({ length: 264 }, (_, index) =>
  makeEntry(`e${String(index).padStart(3, "0")}`, `条目${index}`, { position: index % 2, group_weight: 100 - (index % 5) }));
const manyModel = buildNodeViewModel(null, { ...detail, entries: manyEntries }, null);
assert.equal(manyModel.track.length, 264);
const manyLayout = layoutTrack(manyModel, {});
assert.equal(manyLayout.nodes.length, 264, "轨道条目本身永不截断");
assert.equal(manyLayout.topLevelCount, 264);
assert.equal(manyLayout.hiddenCount, 0);
assert.equal(TRACK_VIRTUALIZE_THRESHOLD, 120, ">120 条启用虚拟化（R-13）");
assert.ok(manyLayout.width > 264 * 100, "轨道横向铺开");
const manyKeys = manyModel.nodes.map((node) => node.key);
const manyExpanded = layoutTrack(manyModel, { expanded: manyKeys, limit: SUBTREE_NODE_LIMIT });
assert.equal(manyExpanded.hiddenCount, 0, "没有展开子树时没有隐藏节点");

// 展开子树超过 400：只截断显示
const chainEntries = [makeEntry("root", "根")];
const chainRows = Array.from({ length: 500 }, (_, index) => {
  const uid = `r${index + 1}`;
  const parent = index === 0 ? "root" : `r${index}`;
  return { uid, name: uid, root_uid: "root", depth: index + 1, parent_uid: parent,
    child_uids: [], remaining: null, is_root: false, repeated: false,
    first_parent_uid: parent, display_index: index };
});
const chainModel = buildNodeViewModel({ ...preview, display_tree: chainRows, resolved_edges: [], issues: [] },
  { ...detail, entries: chainEntries }, null);
const chainLayout = layoutTrack(chainModel, { expanded: chainModel.nodes.map((node) => node.key) });
assert.equal(SUBTREE_NODE_LIMIT, 400);
assert.equal(chainLayout.hiddenCount, 100, "超过 400 的下游节点只隐藏显示");
assert.equal(chainLayout.nodes.length, 401, "轨道 1 条 + 400 个下游节点");
assert.deepEqual(chainLayout.truncatedKeys, ["tree#r400#399"],
  "最后一个被保留的节点标记为「下游被截断」，供 UI 提示");
assert.equal(chainLayout.nodes.filter((node) => node.truncated).length, 1);
assert.equal(chainLayout.nodes.some((node) => node.y < 0), false);

// ── 截断 / 判环 / 加依赖拦截 / 展开辅助（纯函数）────────────────────────────
assert.deepEqual(truncateSubtree([1, 2, 3, 4, 5], 3), { nodes: [1, 2, 3], hiddenCount: 2 });
assert.deepEqual(truncateSubtree([1, 2], 10), { nodes: [1, 2], hiddenCount: 0 });
assert.deepEqual(truncateSubtree([], 0), { nodes: [], hiddenCount: 0 });
assert.deepEqual(truncateSubtree(null, 5), { nodes: [], hiddenCount: 0 });

assert.deepEqual(findCycleEdgeKeys([
  { from_uid: "a", to_uid: "b" }, { from_uid: "b", to_uid: "a" },
  { from_uid: "b", to_uid: "c" }, { from_uid: "c", to_uid: "c" }, { from_uid: "d", to_uid: "e" },
]), ["a|b", "b|a", "c|c"], "互为祖先的边与自环都算环内边，DAG 上的边不算");
assert.deepEqual(findCycleEdgeKeys([]), []);
assert.deepEqual(findCycleEdgeKeys(null), []);
assert.deepEqual(findCycleEdgeKeys([{ from_uid: "a", to_uid: "a" }]), ["a|a"], "自环单独成环");

assert.equal(canAddRequiresEdge(resolvedEdges, "root_a", "root_a").ok, false, "自环被拦住");
assert.equal(canAddRequiresEdge(resolvedEdges, "root_a", "shared").ok, false, "重复边被拦住");
assert.equal(canAddRequiresEdge(resolvedEdges, "loose", "shared").ok, true);
assert.equal(canAddRequiresEdge(resolvedEdges, "", "shared").ok, false);
assert.equal(downstreamCount(resolvedEdges, "root_a"), 7, "下游规模按 requires 闭包去重");
assert.equal(downstreamCount(resolvedEdges, "loose"), 0);
assert.equal(depthForNodeBudget(model), 3, "夹具只有 8 个下游节点，取到最深层");
assert.equal(depthForNodeBudget(manyModel), 0, "没有下游节点时默认 0 层");
assert.equal(DEFAULT_EXPAND_NODE_BUDGET, 60);
assert.deepEqual(expandKeysToDepth(model, 2), ["track#loop2", "track#root_a", "track#root_c", "tree#c1#3"],
  "展开到第 2 层需要展开的节点（含轨道节点，因为根的子节点直接挂在轨道节点下）");
assert.deepEqual(expandKeysToDepth(model, 1), ["track#loop2", "track#root_a", "track#root_c"],
  "深度 < 1 的节点就是带下游的轨道节点");

// ── R-10：多源到达（最早到达者 ≠ first_parent_uid）与轨道优先 ────────────────
// offA 的主到达来自 r2（first_parent_uid），但从 r1（display_index 更早）与 onA 各还有一次
// cross 到达 —— 主节点必须归 first_parent_uid 指向的那次，另两次一律灰。
const r10Entries = [
  makeEntry("r1", "根一"), makeEntry("r2", "根二"), makeEntry("onA", "轨道上的A"),
  makeEntry("offA", "非轨道A", { enabled: false }),
  makeEntry("offB", "非轨道B", { content: "" }),
];
const r10Name = (uid) => r10Entries.find((item) => item.uid === uid)?.name || uid;
const r10Row = (uid, parentUid, depth, index, repeated) => ({
  uid, name: r10Name(uid), root_uid: "r1", depth, parent_uid: parentUid, child_uids: [],
  remaining: null, is_root: parentUid === null, repeated, first_parent_uid: parentUid, display_index: index,
});
const r10Tree = [
  r10Row("r1", null, 0, 0, false),
  r10Row("r2", null, 0, 1, false),
  r10Row("onA", "r1", 1, 2, true),
  r10Row("offA", "r2", 1, 3, true),
  r10Row("offB", "r1", 1, 4, true),
];
const r10Edges = [
  { from_uid: "r1", to_uid: "onA", relation: "requires", active: true, status: "skeleton" },
  { from_uid: "r2", to_uid: "onA", relation: "requires", active: true, status: "cross" },
  { from_uid: "r2", to_uid: "offA", relation: "requires", active: true, status: "skeleton" },
  { from_uid: "r1", to_uid: "offA", relation: "requires", active: true, status: "cross" },
  { from_uid: "onA", to_uid: "offA", relation: "requires", active: true, status: "cross" },
  { from_uid: "r1", to_uid: "offB", relation: "requires", active: true, status: "skeleton" },
  { from_uid: "r2", to_uid: "offB", relation: "requires", active: false, status: "capped" },
];
const r10Model = buildNodeViewModel({
  ...preview,
  active_roots: [
    { entry_uid: "r1", activation: "always", expansion: "requires_closure" },
    { entry_uid: "r2", activation: "always", expansion: "requires_closure" },
  ],
  resolved_edges: r10Edges, display_tree: r10Tree, issues: [],
}, { ...detail, entries: r10Entries }, null);
const r10Node = (key) => r10Model.byKey[key];

// 1) 多源到达：主节点归 first_parent_uid 指向的那次
assert.deepEqual(r10Model.track.map((item) => item.uid), ["onA", "r1", "r2"], "轨道排序不受影响");
assert.equal(r10Node("tree#offA#3").isPrimary, true, "非轨道条目：主到达 = first_parent_uid 指向的那次");
assert.equal(r10Node("tree#offA#3").isRepeated, false);
assert.equal(r10Node("tree#offA#3").arrivalFrom, "r2", "主到达的 from_uid 就是 first_parent_uid");
assert.equal(r10Node("tree#offA#3").parentKey, "track#r2", "主到达挂在 first_parent_uid 的节点下");
assert.equal(r10Node("tree#offA#3").arrivalStatus, "skeleton");
assert.equal(r10Node("cross#offA#r1").isRepeated, true, "从 r1 的到达是重复到达 → 灰");
assert.equal(r10Node("cross#offA#r1").isExtraArrival, true);
assert.equal(r10Node("cross#offA#r1").parentKey, "track#r1");
assert.equal(r10Node("cross#offA#onA").isRepeated, true, "从 onA 的到达同样是灰");
assert.equal(r10Node("cross#offA#onA").parentKey, "track#onA");
const offAPrimaries = r10Model.nodes.filter((node) => node.uid === "offA" && node.isPrimary);
assert.deepEqual(offAPrimaries.map((node) => node.key), ["tree#offA#3"],
  "最早到达（来自 display_index 更早的 r1）不是主节点，主节点只有 first_parent_uid 那一次");
assert.equal(r10Model.nodes.filter((node) => node.uid === "offA").length, 3, "offA 一共三次到达");

// 2) 轨道上已存在的 uid：主节点是轨道节点，展开出现位置全部为灰
const onAPrimaries = r10Model.nodes.filter((node) => node.uid === "onA" && node.isPrimary);
assert.deepEqual(onAPrimaries.map((node) => node.key), ["track#onA"], "轨道节点是唯一主节点");
assert.equal(r10Node("tree#onA#2").isRepeated, true, "轨道上 uid 的主到达展开位置也是灰");
assert.equal(r10Node("tree#onA#2").isPrimary, false);
assert.equal(r10Node("cross#onA#r2").isRepeated, true, "cross 重复到达为灰");
assert.equal(r10Model.nodes.filter((node) => node.uid === "onA" && !node.isRepeated).length, 1,
  "onA 的出现位置里只有轨道节点不是灰");

// 3) repeated 预告与 cross 边不一致时降级并告警（多父边被深度截断成 capped）
assert.ok(!r10Model.byKey["cross#offB#r2"], "capped 边没有发生到达，不生成灰出现位置");
assert.ok(r10Model.warnings.some((text) => text.includes("repeated") && text.includes("offB")),
  "服务端标了 repeated 却没有对应 cross 边时给出告警而不是伪造灰节点");
assert.equal(r10Node("tree#offB#4").isPrimary, true, "offB 的主到达照常渲染（空正文条目不在轨道上）");
assert.equal(r10Node("tree#offB#4").hasRepeatedArrival, true, "节点仍然带上服务端的预告标记");
const offBLayout = layoutTrack(r10Model, { expanded: r10Model.nodes.map((node) => node.key) });
assert.equal(offBLayout.hiddenCount, 0);
assert.ok(offBLayout.edges.some((edge) => edge.kind === "capped" && edge.toUid === "offB"),
  "capped 灰虚线指向 offB 的主节点");

// ── edgeVisual：五种视觉集中一处 ────────────────────────────────────────────
assert.deepEqual(edgeVisual("skeleton", "requires"),
  { lineStyle: "solid", colorRole: "primary", label: "主路径（requires · skeleton）", arrow: true });
assert.deepEqual(edgeVisual("cross", "requires"),
  { lineStyle: "solid", colorRole: "muted", label: "边已生效但目标已被覆盖（requires · cross）", arrow: true });
assert.deepEqual(edgeVisual("capped", "requires"),
  { lineStyle: "dashed", colorRole: "muted", label: "上游已到达但遍历深度用尽（requires · capped）", arrow: true });
assert.deepEqual(edgeVisual("idle", "related"),
  { lineStyle: "dotted", colorRole: "related", label: "仅图示，不参与展开（related）", arrow: false });
assert.deepEqual(edgeVisual("idle", "requires"),
  { lineStyle: "dotted", colorRole: "idle", label: "上游不在候选范围内，不参与展开（requires · idle）", arrow: false });
assert.deepEqual(edgeVisual("skeleton", "requires", true),
  { lineStyle: "dashed", colorRole: "cycle", label: "位于依赖环内（红虚线）", arrow: true },
  "环内边标红虚线，覆盖 status 的默认视觉");

// ── SSR：真实组件渲染（不发任何网络请求）────────────────────────────────────
const baseCtx = {
  detail, draft: { categories: [category], entry_moves: {}, entry_updates: {}, scope_mode: "selective",
    roots: activeRoots, requires_edges: [], related_edges: [], rejected: [], adopt_v3: true },
  patch() {}, adoptV3() {}, dirty: false, saving: false, saveError: "", conflict: false,
  save: async () => false, undo() {}, preview, previewing: false, previewError: "",
  roster: [], setRoster() {},
};
const render = (over = {}, extraProps = {}) => renderToStaticMarkup(
  React.createElement(NodeViewTab, {
    ctx: { ...baseCtx, ...over }, onNotice() {}, onReload: async () => {}, ...extraProps,
  }));

const realFetch = global.fetch;
global.fetch = () => { throw new Error("节点视图 SSR 不应发网络请求"); };
let markup;
try {
  markup = render();
} finally {
  global.fetch = realFetch;
}
for (const expected of ["静态注入顺序键", "若都被命中时的插入次序", "position 升序", "group_weight 降序",
  "起点数", "已在范围内", "未被任何起点覆盖", "依赖环", "超深度边", "隐藏节点数",
  "不重复插入", "是否实际注入仍由关键词、概率、token 预算决定", "Prompt 预览",
  "跳到首次出现", "灰色 · 不重复插入", "重复到达 · 不重复插入", "另有灰出现",
  "灰节点 = 同一 uid 的非主到达", "first_parent_uid 指向的那次到达",
  "游离", "起点", "展开到", "折叠全部",
  "只看起点与依赖闭包", "只看本轮命中", "缩略进度条", "本页只读", "不提供节点拖拽",
  "实线箭头", "灰虚线", "点线", "红虚线"]) {
  assert.ok(markup.includes(expected), `节点视图应渲染：${expected}`);
}
assert.ok(markup.includes("起点A") && markup.includes("共享依赖"), "轨道节点渲染条目名");
assert.ok(markup.includes("<b>起点数</b>2"), "统计条：起点数");
assert.ok(markup.includes("<b>已在范围内</b>8"), "统计条：已在范围内（去重后的主节点数）");
assert.ok(markup.includes("<b>未被任何起点覆盖</b>2"), "统计条：未覆盖");
assert.ok(markup.includes("<b>依赖环</b>2"), "统计条：依赖环");
assert.ok(markup.includes("<b>超深度边</b>2"), "统计条：超深度边");
assert.ok(markup.includes("<b>隐藏节点数</b>0"), "统计条：隐藏节点数");
assert.ok(markup.includes("轨道 7 条"), "工具条显示轨道条目数");
assert.ok(markup.includes("wbnv-node is-track"), "轨道节点有独立类名");
assert.ok(markup.includes("wbnv-node is-expansion is-gray"), "灰节点有独立的灰样式类名");
assert.equal((markup.match(/class="wbnv-node /g) || []).length, 12,
  "首屏渲染 12 个节点：7 个轨道 + root_a 的 4 个主到达 + root_c 的 1 个 cross 重复到达");
assert.ok(!markup.includes("世界书图谱") && !markup.includes("固定导入") && !markup.includes("导入源"),
  "R-22：旧说法不出现在节点视图文案里");
assert.ok(!markup.includes("节点视图将在后续阶段实现"), "桩文案已被真实实现替换");

// 选中一个灰节点 → 属性栏：uid / 分类 / 角标 / 到达路径 breadcrumb / 下游规模 / 问题 / 编辑入口
const grayMarkup = render({}, { initialSelectedKey: "tree#shared#5" });
for (const expected of ["共享依赖", "shared", "剧情", "requires 闭包去重", "到达路径",
  "已插入过（路径 起点A → 共享依赖），不重复插入", "编辑条目", "加依赖",
  "灰节点 = 同一 uid 的非主到达", "这次到达"]) {
  assert.ok(grayMarkup.includes(expected), `属性栏应渲染：${expected}`);
}
assert.ok(grayMarkup.includes("<dt>静态位次</dt><dd>不在轨道上</dd>"), "属性栏说明灰节点不在轨道上");
assert.ok(grayMarkup.includes("主到达 ← root_a"), "属性栏写明主到达来自哪个 from_uid");
const crossNodeMarkup = render({}, { initialSelectedKey: "cross#shared#root_c" });
assert.ok(crossNodeMarkup.includes("cross 边重复到达 ← root_c"), "属性栏写明这是 cross 边带来的重复到达");
const repeatHintMarkup = render({}, { initialSelectedKey: "track#shared" });
assert.ok(repeatHintMarkup.includes("闭包内有多条 requires 入边，另有灰出现"),
  "属性栏用服务端 repeated 预告重复到达");
const problemMarkup = render({}, { initialSelectedKey: "tree#c1#3" });
assert.ok(problemMarkup.includes("缺失") && problemMarkup.includes("依赖引用了不存在的条目 c1"),
  "属性栏列出该节点的问题");
assert.ok(problemMarkup.includes("<dt>静态位次</dt><dd>不在轨道上</dd>"));

// 空态 / 加载态 / 错误态
const emptyMarkup = render({ preview: null });
assert.ok(emptyMarkup.includes("先选一本剧情世界书"), "空态文案");
assert.ok(emptyMarkup.includes("静态注入顺序键"), "空态也保留「先后」的假设说明");
const loadingMarkup = render({ preview: null, previewing: true });
assert.ok(loadingMarkup.includes("正在按当前统一草稿计算候选范围"));
const errorMarkup = render({ preview: null, previewError: "服务端 500" });
assert.ok(errorMarkup.includes("候选范围预览失败：服务端 500") && errorMarkup.includes("重试"));

// Prompt 预览联动：走 appStore 的 promptPreviewOrder（R-6，只读）。
//
// 注意（后人不要再踩两次）：zustand 4.5.7 的服务端快照是
//   useSyncExternalStoreWithSelector(api.subscribe, api.getState, api.getServerState || api.getInitialState, …)
// （frontend/node_modules/zustand/index.js:21），而 `create` 用 `Object.assign(useBoundStore, api)` **拷贝**
// 了那些方法、`useStore` 又闭包持有内部 vanilla store，所以对 `renderToStaticMarkup` 来说
// `setState`、覆盖 `getServerState`、覆盖 `getInitialState` **全都不可见**（实测三种都无效）。
// 因此这里改用模块缓存注入一个只读的 appStore 替身，让真实组件在 SSR 里看到「已跑过 Prompt 预览」的状态。
assert.ok(markup.includes("跑一次「Prompt 预览」后，这里会叠加本轮实际命中的序号"), "没跑预览时的引导文案");
const storeModulePath = require.resolve(path.join(root, "frontend/src/stores/appStore.ts"));
const tabModulePath = require.resolve(path.join(root, "frontend/src/components/worldbook/tabs/NodeViewTab.tsx"));
const realStoreExports = require.cache[storeModulePath].exports;
const renderWithFakeStore = (promptPreview) => {
  require.cache[storeModulePath].exports = {
    useAppStore: (selector) => selector({
      promptPreviewOrder: promptPreview,
      setWorldbookEntryJump() {}, setWorldbookTab() {},
    }),
  };
  delete require.cache[tabModulePath];
  const FreshTab = require(tabModulePath).default;
  return renderToStaticMarkup(React.createElement(FreshTab, {
    ctx: baseCtx, onNotice() {}, onReload: async () => {},
  }));
};
let hitMarkup;
let foreignMarkup;
try {
  hitMarkup = renderWithFakeStore(promptOrder);
  foreignMarkup = renderWithFakeStore({ ...promptOrder, bookId: "another-book" });
} finally {
  require.cache[storeModulePath].exports = realStoreExports;
  delete require.cache[tabModulePath];
}
assert.ok(hitMarkup.includes("本轮命中叠加已生效"), "有 Prompt 预览结果时叠加上线");
assert.ok(hitMarkup.includes("本轮实际注入序号") && hitMarkup.includes("静态注入位次"),
  "两个序号的差别必须说明");
const hitNodeCount = (hitMarkup.match(/class="wbnv-hit"/g) || []).length;
const modelHitCount = model.nodes.filter((node) => node.isPrimary && node.actualSeq !== null).length;
assert.equal(modelHitCount, 3, "夹具里有三条主节点本轮命中（shared / root_a / loose）");
assert.equal(hitNodeCount, modelHitCount, "只给主节点叠加命中序号（灰出现位置不叠加）");
assert.ok(foreignMarkup.includes("跑一次「Prompt 预览」后"), "别本书的预览结果不叠加");
assert.ok(foreignMarkup.includes("当前叠加来自另一本书"), "并说明叠加来自哪本书");

// 轨道 264 条：SSR 不卡死（虚拟化只渲染视口内的轨道带）
const bigModelMarkup = renderToStaticMarkup(React.createElement(NodeViewTab, {
  ctx: { ...baseCtx, detail: { ...detail, entries: manyEntries }, preview: null },
  onNotice() {}, onReload: async () => {},
}));
assert.ok(bigModelMarkup.includes("先选一本剧情世界书"));

console.log("Worldbook node view UI: 轨道排序（position/group_weight/depth/uid）、灰节点去重（轨道优先、"
  + "cross 目标为灰、capped 占位、related 点线、环内标红）、确定性布局（父居中/子树按后代分配/同父 uid 排序）、"
  + "400 截断与 264 条轨道、六项统计、五种边视觉、真实组件 SSR（假设文案 / 灰节点口径 / 空态 / Prompt 联动）均通过。");
