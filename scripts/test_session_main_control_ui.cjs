// 主控角色与角色入队合并后的验证（不启动浏览器）：
//   A. 候选目录纯逻辑 —— 来源分类、缺字段兜底、搜索/来源筛选、阵容去重、主控校验；
//   B. 共用选择器 CharacterPicker 的服务端渲染结构 —— 两种来源徽章、缺字段标注、
//      已在阵容的锁定项、以及「同一份候选目录」的实际渲染结果；
//   C. 剧情默认阵容 —— 「点选剧情即自动选中世界书 / 主控 / 队友」的纯逻辑。
// 转译钩子与 scripts/test_worldbook_scope_ui.cjs 同源（必须传 fileName，见 docs/notes.md）。
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
      fileName: filename,
    });
    module._compile(outputText, filename);
  };
}
const React = fromFrontend("react");
const { renderToStaticMarkup } = fromFrontend("react-dom/server");

const {
  buildCharacterCatalog, catalogBooks, filterCharacterCatalog, sortCatalogForBook,
  buildLineup, mainControlError, resolvePlotDefaults, summaryText, MISSING_SUMMARY_TEXT,
} = require(path.join(root, "frontend/src/utils/characterCatalog.ts"));
const CharacterPicker = require(path.join(root, "frontend/src/components/session/CharacterPicker.tsx")).default;

// ── A. 候选目录纯逻辑 ───────────────────────────────────────────────────────
const books = [
  { id: "arknights", name: "明日方舟" },
  { id: "beyond-twin", name: "彼岸双生" },
];
const docs = [
  // 自建：没有 worldbook_id
  { id: "龙门侦探", name: "龙门侦探", title: "龙门侦探", summary: "常驻龙门的私家侦探", worldbook_id: "" },
  // 自建但缺 summary
  { id: "自建无简介", name: "自建无简介" },
  // 世界书角色
  { id: "Mon3tr", name: "Mon3tr", summary: "罗德岛特别顾问", worldbook_id: "arknights" },
  // 世界书角色，来源书已不在书列表里 → 退回 id 显示
  { id: "结城理", name: "结城理", summary: "特别课外活动小组", worldbook_id: "beyond-twin" },
  { id: "消失的书", name: "消失的书", summary: "来源书已删", worldbook_id: "gone-book" },
  // 缺 id：用名字当键
  { name: "只有名字" },
  // 既无 id 也无名字：无法作为阵容键 → 剔除
  { summary: "没有名字的角色卡" },
  // 重复键：只保留一条
  { id: "Mon3tr", name: "Mon3tr 重复" },
];

const catalog = buildCharacterCatalog(docs, books);
assert.equal(catalog.skipped, 1, "既无 id 也无名字的条目应被剔除并计数");
assert.equal(catalog.items.length, 6, "重复键只保留一条");

const byKey = Object.fromEntries(catalog.items.map((item) => [item.key, item]));

// A1. 来源分类：只有带 worldbook_id 的才算世界书角色
assert.equal(byKey["龙门侦探"].source, "own");
assert.equal(byKey["Mon3tr"].source, "worldbook");
assert.equal(byKey["Mon3tr"].bookName, "明日方舟");
assert.equal(byKey["结城理"].bookName, "彼岸双生");
// 书列表里查不到来源书时退回 id（仍能看清来源，不显示空白）
assert.equal(byKey["消失的书"].bookName, "gone-book");

// A2. 缺字段兜底：缺 id 用名字成键；缺简介给统一文案并标注
assert.ok(byKey["只有名字"], "缺 id 的条目用展示名当键");
assert.equal(byKey["只有名字"].source, "own");
assert.equal(byKey["自建无简介"].summary, "");
assert.ok(byKey["自建无简介"].missing.includes("简介"));
assert.equal(summaryText(byKey["自建无简介"]), MISSING_SUMMARY_TEXT);
assert.equal(summaryText(byKey["Mon3tr"]), "罗德岛特别顾问");

// A3. 搜索与来源筛选（自建 / 世界书 / 具体某本书）
assert.deepEqual(
  filterCharacterCatalog(catalog.items, { source: "own" }).map((i) => i.key).sort(),
  ["只有名字", "自建无简介", "龙门侦探"].sort(),
);
assert.deepEqual(
  filterCharacterCatalog(catalog.items, { source: "worldbook" }).map((i) => i.key).sort(),
  ["Mon3tr", "结城理", "消失的书"].sort(),
);
assert.deepEqual(
  filterCharacterCatalog(catalog.items, { source: "worldbook", bookId: "arknights" }).map((i) => i.key),
  ["Mon3tr"],
);
// 书筛选只在「世界书」来源下生效，避免和自建混淆
assert.equal(filterCharacterCatalog(catalog.items, { source: "all", bookId: "arknights" }).length, catalog.items.length);
// 搜索命中名字 / 简介 / 来源书名
assert.deepEqual(filterCharacterCatalog(catalog.items, { query: "侦探" }).map((i) => i.key), ["龙门侦探"]);
assert.deepEqual(filterCharacterCatalog(catalog.items, { query: "彼岸双生" }).map((i) => i.key), ["结城理"]);
assert.deepEqual(filterCharacterCatalog(catalog.items, { query: "特别顾问" }).map((i) => i.key), ["Mon3tr"]);
assert.equal(filterCharacterCatalog(catalog.items, { query: "不存在" }).length, 0);

// A4. 绑定书优先 + 书下拉（下拉按书名排序；来源书已删的条目退回 id 也进下拉）
assert.deepEqual(catalogBooks(catalog.items).map((b) => b.name), ["彼岸双生", "明日方舟", "gone-book"]);
const sorted = sortCatalogForBook(catalog.items, "beyond-twin");
assert.equal(sorted[0].key, "结城理", "绑定书的角色排最前");
assert.equal(sorted.length, catalog.items.length, "排序不丢候选");

// A5. 阵容：主控在前、同名只出现一次
assert.deepEqual(buildLineup("Mon3tr", ["阿米娅", "Mon3tr", ""]), ["Mon3tr", "阿米娅"]);
assert.deepEqual(buildLineup("", ["阿米娅"]), ["阿米娅"]);
assert.deepEqual(buildLineup(null, []), []);

// A6. 未选主控的提示唯一来源
assert.match(mainControlError("", catalog.items), /请选择一名主控角色/);
assert.match(mainControlError("已删除的角色", catalog.items), /已不在角色库中/);
assert.equal(mainControlError("Mon3tr", catalog.items), null);

// ── B. 共用选择器的 SSR 结构 ────────────────────────────────────────────────
const items = filterCharacterCatalog(catalog.items, {});
const html = renderToStaticMarkup(React.createElement(CharacterPicker, {
  items,
  mode: "multi",
  selected: ["Mon3tr"],
  onSelect: () => {},
  lockedKeys: ["龙门侦探"],
  lockedLabel: "主控（已在阵容）",
  preferredBookId: "arknights",
  skippedCount: catalog.skipped,
  selectedBadge: "已入队",
  searchPlaceholder: "搜索队友（自建 / 世界书）...",
  emptyText: "暂无可用角色",
}));

// B1. 两类角色在同一列表：来源徽章各就各位
assert.ok(html.includes(">自建<") || html.includes("自建"), "自建角色带来源标注");
assert.ok(html.includes("明日方舟"), "世界书角色显示来源书书名");
assert.ok(html.includes("彼岸双生"), "另一本书的角色同样标注来源");
assert.ok(html.includes("本次绑定"), "绑定书的角色有额外标注");
assert.ok(html.includes("缺简介"), "缺 summary 的条目有兜底标注");
assert.ok(html.includes(MISSING_SUMMARY_TEXT), "缺简介显示统一兜底文案");
// B2. 筛选与搜索入口
for (const label of ["全部", "自建", "世界书"]) assert.ok(html.includes(`>${label}<`), `来源筛选「${label}」存在`);
assert.ok(html.includes('placeholder="搜索队友（自建 / 世界书）..."'), "搜索框存在");
// B3. 已在阵容的主控不再作为候选，且如实提示被剔除的条目
assert.ok(html.includes("主控（已在阵容）"), "锁定项标注");
assert.ok(html.includes("1 个角色卡既没有 id 也没有名称"), "被剔除条目的数量如实提示");
assert.ok(html.includes('disabled=""'), "已在阵容的候选被禁用");
// B4. 头像地址按角色键拼（404 时由 EntityAvatar 切首字色块，浏览器内生效）
assert.ok(html.includes("/api/characters/Mon3tr/avatar"), "角色头像地址来自角色目录键");

// 单选模式（主控步骤 / 大厅换主控）只展示一个选中态
const singleHtml = renderToStaticMarkup(React.createElement(CharacterPicker, {
  items, mode: "single", selected: ["Mon3tr"], onSelect: () => {},
  selectedBadge: "本次主控", searchPlaceholder: "搜索角色...", emptyText: "暂无可用角色",
}));
assert.ok(singleHtml.includes("本次主控"), "单选模式显示选中角标");
// 角标只挂在一个磁贴上（来源筛选按钮同样用 aria-pressed，所以按角标数断言选中唯一）
assert.equal((singleHtml.match(/本次主控/g) || []).length, 1, "单选模式只有一个选中项");

// ── C. 剧情默认阵容：点选剧情即自动选中（resolvePlotDefaults） ────────────────
const installedBooks = [
  { id: "near-light", name: "长夜临光" },
  { id: "arknights", name: "明日方舟" },
  { id: "beyond-twin", name: "彼岸双生" },
];
// 拆分剧情书里的角色卡仍标注来源书（arknights）—— 只按来源书过滤会整份阵容消失，这是核心回归点
const item = (key, bookId, bookName) => ({
  key, name: key, summary: "", bookId, bookName,
  source: bookId ? "worldbook" : "own", missing: [],
});
const candidateItems = [
  item("临光", "arknights", "明日方舟"),
  item("瑕光", "arknights", "明日方舟"),
  item("博士", "arknights", "明日方舟"),
  item("程叙", "beyond-twin", "彼岸双生"),
  item("妮可", "beyond-twin", "彼岸双生"),
  item("自建角色", "", ""),
];

// C1. 声明了书与主控：绑定该书，主控取声明，其余开场角色入队（来源书不同照样可选中）
assert.deepEqual(
  resolvePlotDefaults(
    { worldbook_id: "near-light", player_identity: "博士", initial_characters: ["临光", "瑕光"] },
    installedBooks, candidateItems, [],
  ),
  { books: ["near-light"], main: "博士", teammates: ["临光", "瑕光"] },
  "剧情声明的主控与开场角色应被自动选中",
);

// C2. 未声明主控 → 回退开场角色首位；主控不重复出现在队友里
assert.deepEqual(
  resolvePlotDefaults({ worldbook_id: "beyond-twin", initial_characters: ["程叙", "妮可"] },
    installedBooks, candidateItems, []),
  { books: ["beyond-twin"], main: "程叙", teammates: ["妮可"] },
  "缺 player_identity 时回退 initial_characters 首位",
);

// C3. 声明的书没安装 → 保留玩家当前选择，不静默清空
assert.deepEqual(
  resolvePlotDefaults({ worldbook_id: "grey-lantern", player_identity: "博士" },
    installedBooks, candidateItems, ["near-light"]),
  { books: ["near-light"], main: "博士", teammates: [] },
  "剧情声明的书未安装时不动玩家的绑定",
);

// C4. 声明的主控不在角色库 → 顺延到开场角色首位；都不在 → 空串交给玩家手选
assert.equal(resolvePlotDefaults({ player_identity: "查无此人", initial_characters: ["瑕光"] },
  installedBooks, candidateItems).main, "瑕光", "主控不在角色库时顺延");
assert.equal(resolvePlotDefaults({ player_identity: "查无此人", initial_characters: ["也不在"] },
  installedBooks, candidateItems).main, "", "角色库里没有的角色不会被选中");

// C5. 没有剧情 / 空声明：不动世界书与阵容
assert.deepEqual(resolvePlotDefaults(null, installedBooks, candidateItems, []),
  { books: [], main: "", teammates: [] }, "未选剧情时不做任何默认选中");

console.log("PASS: 主控与阵容的候选目录 / 共用选择器断言全部通过");
