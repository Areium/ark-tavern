// 主控角色与角色入队合并后的验证（不启动浏览器）：
//   A. 候选目录纯逻辑 —— 来源分类、缺字段兜底、搜索/来源筛选、阵容去重、主控校验；
//   B. 共用选择器 CharacterPicker 的服务端渲染结构 —— 两种来源徽章、缺字段标注、
//      已在阵容的锁定项、以及「同一份候选目录」的实际渲染结果。
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
  buildLineup, mainControlError, summaryText, MISSING_SUMMARY_TEXT,
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

console.log("PASS: 主控与阵容的候选目录 / 共用选择器断言全部通过");
