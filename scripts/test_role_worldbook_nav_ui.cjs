// 不启动浏览器：检验「内容中心 → 角色 / 世界书」两级合并后的导航结构与页面骨架。
//
// 覆盖：内容中心与旧「节点视图」整页删除（含其纯逻辑 / 样式 / UI 测试，文件不允许回流）、
// 一级导航只剩 角色 / 世界书、角色页四个模块页签（角色库 / 玩家身份 / 资产 / 卡牌）与模块切换、
// 世界书工作台页签 = 条目 / Prompt 预览 / 节点图 / 本家索引（节点图挂载迁入的 PlotGraphPage）。
//
// 业务口径：资产与卡牌原本挂在「内容中心」，现为「角色」页的模块页签；剧情节点图原本挂在
// 「内容中心 → 节点图」，现为「世界书 → 节点图」页签，并以工作台选中的书为受控书。
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
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

// ── 1. 删除物：内容中心与旧「节点视图」整页删除 ──
// 旧节点视图记录的是条目注入顺序，与「条目」页重复；本次用迁入的节点图替换其位置。
for (const relative of [
  "frontend/src/components/ContentHub.tsx",
  "frontend/src/components/worldbook/tabs/NodeViewTab.tsx",
  "frontend/src/styles/worldbook-node-view.css",
  "frontend/src/utils/worldbookNodeView.ts",
  "scripts/test_worldbook_node_view_ui.cjs",
]) {
  assert.ok(!fs.existsSync(path.join(root, relative)), `${relative} 应已删除`);
}

// ── 2. 一级导航：只剩 角色 / 世界书；内容中心入口与其 store 状态不留痕 ──
for (const relative of ["frontend/src/components/HomeMenu.tsx", "frontend/src/components/GameTopBar.tsx"]) {
  const source = read(relative);
  assert.ok(!source.includes("内容中心"), `${relative} 不应再出现「内容中心」`);
  assert.ok(!source.includes('"content"'), `${relative} 不应再有 content 一级入口`);
  assert.ok(source.includes('id: "characters"') && source.includes('id: "worldbook"'),
    `${relative} 应保留 角色 / 世界书 两个一级入口`);
}
const storeSource = read("frontend/src/stores/appStore.ts");
assert.ok(!storeSource.includes("ContentHubTab") && !storeSource.includes("contentHubTab"),
  "store 不应再有内容中心页签类型与状态");
assert.ok(!storeSource.includes("promptPreviewOrder"),
  "只服务于旧节点视图的 promptPreviewOrder 死状态不应回流");
assert.ok(storeSource.includes("CharacterTab"), "store 应提供角色页模块页签类型");

// 全库（前端源码）不允许残留内容中心 / 旧节点视图的活的引用
const collectSources = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!["node_modules", "dist"].includes(entry.name)) collectSources(target, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) out.push(target);
  }
  return out;
};
const offenders = [];
for (const file of collectSources(path.join(root, "frontend/src"))) {
  const source = fs.readFileSync(file, "utf8");
  if (/ContentHub|contentHubTab|promptPreviewOrder|worldbookNodeView/.test(source)) {
    offenders.push(path.relative(root, file).replace(/\\/g, "/"));
  }
}
assert.deepEqual(offenders, [], "不应残留内容中心 / 旧节点视图的代码引用");

// ── 3. 角色页：四个模块页签，且每个模块接的是对的组件 ──
// 注：zustand 在 renderToStaticMarkup 下只读得到初始快照（React 服务端快照语义），
// 所以「页签切换」不靠 SSR 对比 markup，改为断言 store 迁移 + 组件接线 + 两个迁入模块可渲染。
const { useAppStore } = require(path.join(root, "frontend/src/stores/appStore.ts"));
const CharacterManager = require(path.join(root, "frontend/src/components/CharacterManager.tsx")).default;
const AssetManager = require(path.join(root, "frontend/src/components/AssetManager.tsx")).default;
const CardManager = require(path.join(root, "frontend/src/components/CardManager.tsx")).default;

assert.equal(useAppStore.getState().characterTab, "characters", "角色页默认停在角色库");
useAppStore.getState().setCharacterTab("cards");
assert.equal(useAppStore.getState().characterTab, "cards", "setCharacterTab 应能落到卡牌模块");
useAppStore.getState().setCharacterTab("identities");
assert.equal(useAppStore.getState().characterTab, "identities");
useAppStore.getState().setCharacterTab("characters");

const roleMarkup = renderToStaticMarkup(React.createElement(CharacterManager));
for (const label of ["角色库", "玩家身份", "资产", "卡牌"]) {
  assert.ok(roleMarkup.includes(label), `角色页应有「${label}」模块页签`);
}
assert.ok(roleMarkup.includes('aria-label="角色页模块"'), "角色页模块栏应带语义标签");
for (const label of ["内容中心", "节点图"]) {
  assert.ok(!roleMarkup.includes(label), `角色页不应出现「${label}」`);
}
const characterSource = read("frontend/src/components/CharacterManager.tsx");
assert.ok(characterSource.includes('tab === "images" ? <AssetManager') && characterSource.includes("<CardManager"),
  "资产 / 卡牌模块应分别挂载 AssetManager / CardManager");
assert.ok(characterSource.includes("const tab = useAppStore((state) => state.characterTab)"),
  "角色页模块页签应来自 store（跨组件跳转要能指定落点）");
assert.ok(characterSource.includes('setCharacterTab("cards")'), "角色卡详情的「编辑卡牌」应落到卡牌模块");
// 两个迁入模块本体不变：仍然各自可渲染
const cardsMarkup = renderToStaticMarkup(React.createElement(CardManager));
const assetsMarkup = renderToStaticMarkup(React.createElement(AssetManager));
assert.ok(cardsMarkup.length > 100 && assetsMarkup.length > 100, "迁入的资产 / 卡牌模块应可独立渲染");
assert.notEqual(cardsMarkup, assetsMarkup, "卡牌与资产仍是两个不同的模块");

// ── 4. 世界书工作台：页签换成迁入的节点图，旧节点视图不再出现 ──
const managerModule = require(path.join(root, "frontend/src/components/WorldBookManager.tsx"));
assert.deepEqual(managerModule.WORLDBOOK_PANEL_TABS.map((tab) => tab.id),
  ["entries", "prompt", "graph", "index"], "工作台页签应为 条目 / Prompt 预览 / 节点图 / 本家索引");
assert.deepEqual(managerModule.WORLDBOOK_PANEL_TABS.map((tab) => tab.label),
  ["条目", "Prompt 预览", "节点图", "本家索引"]);
const managerSource = read("frontend/src/components/WorldBookManager.tsx");
// 判据是「没有活的旧节点视图」：页签 id 与组件挂载都不允许回来（注释里提到历史名称是允许的）
assert.ok(!/import\s+NodeViewTab/.test(managerSource) && !/id:\s*"nodes"/.test(managerSource),
  "世界书工作台不应再挂载旧的节点视图页签");
assert.ok(managerSource.includes("PlotGraphPage"), "节点图页签应挂载迁入的 PlotGraphPage");
assert.ok(managerSource.includes("sessionId={activeSessionId}") && managerSource.includes("bookId={detail.id}"),
  "节点图应以工作台当前选中的书为受控书、并带上当前会话");
const library = require(path.join(root, "frontend/src/utils/worldbookLibrary.ts"));
assert.equal(library.normalizeWorldbookTab("graph", { book_type: "story" }), "graph");
assert.equal(library.normalizeWorldbookTab("graph", { book_type: "reference" }), "entries",
  "资料库没有节点图，仍应归一到条目页");
assert.equal(library.normalizeWorldbookTab("nodes", { book_type: "story" }), "entries",
  "旧节点视图的页签值应作为脏值兜底");

// ── 5. 统一检索有归宿：原内容中心顶栏的跨书检索迁到世界书书架 ──
assert.ok(managerSource.includes("searchWorldbooks") && managerSource.includes("wber-shelf-search"),
  "跨世界书统一检索应落在世界书书架（不随内容中心一起消失）");

console.log("角色/世界书两级导航：一级入口只剩 角色 / 世界书（内容中心已删除）、"
  + "角色页四模块页签与世界书页签骨架、旧节点视图删除且节点图迁入，全部断言通过。");
