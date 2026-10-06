// 对话页舞台 / 场景面板插件 / 角色数值的验证（不启动浏览器）：
//   A. 舞台脚本纯逻辑 —— 消息流折算成逐句步骤、长句拆分、选项收尾、流式态、立绘落位、程序化背景；
//   B. 场景面板注册表 —— 注册 / 覆盖 / 排序 / 按模式过滤 / 页签兜底 / 非法 id 拒绝；内置四个分组已登记；
//   C. 统一数值字段编辑器的行 → 字段折算与校验；数值表单的分组与自定义键；
//   D. 服务端渲染：ScenePanel 图标栏按模式出页签、StageView 骨架（对话框 / 立绘牌 / 选项）、
//      ChatView 顶栏的布局切换与面板开合按钮在左侧、气泡外观类映射。
// 转译钩子与 scripts/test_session_main_control_ui.cjs 同源（必须传 fileName，见 docs/notes.md）。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "..");
const fromFrontend = createRequire(path.join(root, "frontend/package.json"));
const ts = fromFrontend("typescript");
require.extensions[".css"] = () => {};
// plugins/index.ts 用 import.meta.glob 自动加载第三方面板，CJS 转译不了：这里用空模块顶替，
// 内置面板改由本脚本直接 require plugins/builtin.tsx 登记。
const PLUGIN_INDEX = path.join(root, "frontend/src/plugins/index.ts");
for (const extension of [".ts", ".tsx"]) {
  require.extensions[extension] = (module, filename) => {
    if (filename === PLUGIN_INDEX) { module.exports = { CUSTOM_PANEL_MODULES: [] }; return; }
    const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
      fileName: filename,
    });
    module._compile(outputText, filename);
  };
}
const React = fromFrontend("react");
const { renderToStaticMarkup } = fromFrontend("react-dom/server");

const src = (p) => path.join(root, "frontend/src", p);

// ── A. 舞台脚本 ────────────────────────────────────────────────────────────
const {
  buildStageScript, stepsForMessage, splitLongText, isChoiceMessage, speakerOfStep, stagePositions,
  proceduralBackground, STEP_MAX_CHARS,
} = require(src("utils/stageScript.ts"));

const scene = ["临光", "瑕光", "博士"];
const narrator = {
  role: "narrator", round: 3, content: "风雪停了。临光收起长枪。「我们该走了。」瑕光点点头：「好。」",
  dialogueSegments: [
    { type: "narration", text: "风雪停了。临光收起长枪。" },
    { type: "dialogue", text: "我们该走了。", speaker: "临光" },
    { type: "narration", text: "瑕光点点头：" },
    { type: "dialogue", text: "好。", speaker: "瑕光" },
  ],
};
const choices = { role: "system", content: "— 请选择 —", round: 3, choices: ["跟上", "留下"] };

let script = buildStageScript([{ role: "user", content: "出发", round: 2 }, narrator, choices], scene, "博士");
assert.equal(script.messageIndex, 1, "脚本取最后一条非选项消息");
assert.equal(script.steps.length, 4, "后端片段逐段成步");
assert.deepEqual(script.steps.map((s) => s.kind), ["narration", "dialogue", "narration", "dialogue"]);
assert.equal(speakerOfStep(script.steps[1]), "临光");
assert.equal(speakerOfStep(script.steps[0]), undefined, "叙述没有说话人");
assert.equal(script.choiceMessage, choices, "紧跟的选项消息作为收尾");
assert.equal(script.streaming, false);
assert.ok(script.key.startsWith("1:3:0:d"), "键包含下标 / 轮次 / 变体");

// 没有后端片段时走前端解析
const parsed = buildStageScript([{ role: "narrator", content: "临光说：「走吧。」", round: 1 }], scene, "博士");
assert.equal(parsed.steps.length, 1, "署名前缀被剥掉后只剩台词");
assert.equal(parsed.steps[0].kind, "dialogue");
assert.equal(parsed.steps[0].speaker, "临光");

// 玩家消息 / 流式态 / 只有选项
const playerScript = buildStageScript([{ role: "user", content: "我看向远方", round: 4 }], scene, "博士");
assert.equal(playerScript.steps[0].kind, "player");
assert.equal(playerScript.steps[0].speaker, "博士");
const streaming = buildStageScript([narrator, { role: "narrator", content: "正在生成", round: 4, streaming: true }], scene, "博士");
assert.equal(streaming.streaming, true);
assert.equal(streaming.steps.length, 1, "流式中只有一步：实时文本");
assert.ok(streaming.key.endsWith(":s"));
const onlyChoice = buildStageScript([choices], scene, "博士");
assert.equal(onlyChoice.messageIndex, -1);
assert.equal(onlyChoice.choiceMessage, choices, "只有选项时脚本为空但选项照常");
assert.equal(buildStageScript([], scene, "博士").steps.length, 0);
assert.equal(isChoiceMessage({ role: "system", content: "x", branches: [{ id: "b", label: "去" }] }), true);
assert.equal(isChoiceMessage({ role: "system", content: "x" }), false);

// 长句拆分：按句末标点、不超上限；超长无标点硬切
const long = "第一句。".repeat(60);
const pieces = splitLongText(long);
assert.ok(pieces.length > 1 && pieces.every((p) => p.length <= STEP_MAX_CHARS), "按句号拆分且不超上限");
assert.equal(pieces.join(""), long, "拆分不丢字");
const hard = splitLongText("字".repeat(400));
assert.ok(hard.length >= 3 && hard.every((p) => p.length <= STEP_MAX_CHARS));
assert.deepEqual(splitLongText("  "), []);
const userSteps = stepsForMessage({ role: "user", content: "a\n\nb" }, scene, "博士");
assert.equal(userSteps.length, 1, "短文本不拆");

// 立绘落位与程序化背景
assert.deepEqual(stagePositions(0), []);
assert.deepEqual(stagePositions(1), [50]);
const three = stagePositions(3);
assert.equal(three.length, 3);
assert.ok(three[0] < three[1] && three[1] < three[2] && three[0] >= 10 && three[2] <= 90);
assert.ok(proceduralBackground("夜晚", "").startsWith("linear-gradient"));
assert.notEqual(proceduralBackground("清晨", "晴天"), proceduralBackground("深夜", "暴雨"), "时段 / 天气影响背景");

// ── B. 场景面板注册表 ───────────────────────────────────────────────────────
const registry = require(src("plugins/scenePanels.tsx"));
require(src("plugins/builtin.tsx"));
const builtin = registry.listScenePanels();
assert.deepEqual(builtin.map((p) => p.id), ["characters", "story", "quests", "resources"],
  "内置面板按 order 排好");
const storyVisible = registry.visibleScenePanels(builtin, "story").map((p) => p.id);
const freeVisible = registry.visibleScenePanels(builtin, "free").map((p) => p.id);
assert.ok(storyVisible.includes("story") && storyVisible.includes("quests"));
assert.ok(!freeVisible.includes("story") && !freeVisible.includes("memory") && !freeVisible.includes("quests"), "自由模式没有剧情类面板");
assert.deepEqual(freeVisible, ["characters", "resources"]);
assert.equal(registry.resolveScenePanelTab(builtin, "resources"), "resources");
assert.equal(registry.resolveScenePanelTab(registry.visibleScenePanels(builtin, "free"), "story"), "characters", "页签不可见时兜底到第一个");

const Dummy = () => React.createElement("div", null, "dummy");
const off = registry.registerScenePanel({ id: "zz-test", title: "测试", icon: "star", component: Dummy });
assert.equal(registry.listScenePanels().at(-1).id, "zz-test", "第三方默认 order 100 排在内置之后");
registry.registerScenePanel({ id: "zz-test", title: "测试2", icon: "star", order: 5, component: Dummy });
assert.equal(registry.listScenePanels()[0].id, "zz-test", "同 id 重新注册覆盖并按新 order 排序");
assert.equal(registry.listScenePanels().filter((p) => p.id === "zz-test").length, 1);
off();
assert.ok(!registry.listScenePanels().some((p) => p.id === "zz-test"), "注销后消失");
assert.throws(() => registry.registerScenePanel({ id: "Bad Id", title: "x", icon: "star", component: Dummy }), /非法/);
assert.throws(() => registry.registerScenePanel({ id: "no-comp", title: "x", icon: "star" }), /component/);
// 示例插件可加载并登记
require(src("plugins/custom/sessionNotes.tsx"));
assert.ok(registry.listScenePanels().some((p) => p.id === "session-notes"), "示例插件登记为 session-notes");
registry.unregisterScenePanel("session-notes");

// ── C. 数值字段编辑器 / 数值表单纯逻辑 ─────────────────────────────────────
const { rowsToFields } = require(src("components/worldbook/StatFieldsEditor.tsx"));
const row = (o) => ({ key: "", label: "", type: "number", min: "", max: "", step: "", default: "", options: "", group: "", description: "", ...o });
let out = rowsToFields([
  row({ key: "hp", label: "体力", min: "0", max: "100", default: "100" }),
  row({ key: "mood", label: "心情", type: "select", options: "平静, 警惕、愤怒", default: "警惕" }),
  row({ key: "wounded", type: "bool", default: "是" }),
  row({ key: "note", type: "text", default: "" }),
]);
assert.equal(out.error, null);
assert.deepEqual(out.fields[0], { key: "hp", label: "体力", type: "number", min: 0, max: 100, default: 100 });
assert.deepEqual(out.fields[1].options, ["平静", "警惕", "愤怒"]);
assert.equal(out.fields[1].default, "警惕");
assert.equal(out.fields[2].default, true);
assert.equal(out.fields[2].label, "wounded", "标签缺省为键名");
assert.match(rowsToFields([row({ key: "bad key" })]).error, /键名非法/);
assert.match(rowsToFields([row({ key: "a" }), row({ key: "a" })]).error, /重复/);
assert.match(rowsToFields([row({ key: "a", min: "x" })]).error, /不是数字/);
assert.match(rowsToFields([row({ key: "s", type: "select", options: "" })]).error, /至少填一个选项/);

const { groupFields, customKeys } = require(src("components/roles/StatValuesForm.tsx"));
const grouped = groupFields([{ key: "a", label: "a", type: "number", group: "战斗" }, { key: "b", label: "b", type: "number" }, { key: "c", label: "c", type: "number", group: "战斗" }]);
assert.deepEqual(grouped.map((g) => g.group), ["", "战斗"], "无组排最前");
assert.deepEqual(grouped[1].fields.map((f) => f.key), ["a", "c"]);
assert.deepEqual(customKeys([{ key: "a", label: "a", type: "number" }], { a: 1, x: 2, y: "z" }), ["x", "y"]);

// ── D. 服务端渲染 ───────────────────────────────────────────────────────────
// zustand 只读得到初始快照（docs/notes.md），因此只断言不随 store 变化的结构。
const ScenePanel = require(src("components/scene/ScenePanel.tsx")).default;
let markup = renderToStaticMarkup(React.createElement(ScenePanel));
// 初始 chatMode = story → 四个内置分组都在图标栏；面板默认展开、无会话时给提示
for (const label of ["场景", "剧情", "任务", "资源"]) {
  assert.ok(markup.includes(`aria-label="${label}"`), `图标栏包含「${label}」`);
}
assert.ok(markup.includes("scene-rail-btn is-toggle"), "图标栏底部有收起按钮");
assert.ok(markup.includes("请先选择或创建会话"), "无会话时的提示");

const ChatView = require(src("components/ChatView.tsx")).default;
markup = renderToStaticMarkup(React.createElement(ChatView));
const backIdx = markup.indexOf("返回大厅");
const panelIdx = markup.indexOf("收起面板");
const layoutIdx = markup.indexOf('aria-label="对话布局"');
assert.ok(backIdx >= 0 && panelIdx > backIdx, "面板开合按钮紧随「返回大厅」之后（在左侧）");
assert.ok(layoutIdx > panelIdx, "布局切换在右侧");
assert.ok(markup.includes("记录") && markup.includes("舞台"), "布局切换：记录 / 舞台");
assert.ok(!markup.includes("🏛") && !markup.includes("🗂"), "会话大厅 / 会话资源两个图标按钮已撤销");
assert.ok(!markup.includes("border-l border-gray-700 overflow-y-auto p-3 shrink-0 bg-gray-900/60"), "右侧独立资源面板不再存在");

const StageView = require(src("components/stage/StageView.tsx")).default;
const stageProps = {
  sessionId: "s1", messages: [narrator, choices], sceneCharacters: scene, playerName: "博士", characterColors: { 临光: "#f8e8c0" },
  fontSize: 15, waiting: false, elapsedSeconds: 0, choicesDisabled: false, onChoice: () => {}, onOpenLog: () => {}, onStart: () => {}, chatMode: "story",
};
markup = renderToStaticMarkup(React.createElement(StageView, stageProps));
assert.match(markup, /class="stage(?:\s[^"]*)?"/, "舞台根节点");
assert.ok(markup.includes("stage-dialog"), "对话框");
assert.ok(markup.includes("stage-waiting") && !markup.includes("stage-sprite-card"), "旁白先等待历史舞台快照，避免首句使用错误场景");
const fallbackMarkup = renderToStaticMarkup(React.createElement(StageView, {
  ...stageProps, messages: [{ role: "character", character: "临光", content: "临光：「走吧。」瑕光：「好。」" }, choices],
}));
assert.ok(fallbackMarkup.includes("stage-sprite-card") && fallbackMarkup.includes("临光") && fallbackMarkup.includes("瑕光"), "没有立绘 URL 时退回头像牌");
assert.ok(!markup.includes("stage-choices"), "脚本未走到末尾时选项不显示");
assert.ok(fallbackMarkup.includes('aria-keyshortcuts="End"') && fallbackMarkup.includes("End 跳至选项"), "舞台标注一键跳至选项快捷键");
assert.ok(markup.includes("stage-env") === false, "没有舞台数据时不显示环境角标");
markup = renderToStaticMarkup(React.createElement(StageView, { ...stageProps, messages: [choices] }));
assert.ok(markup.includes("stage-choices") && markup.includes("跟上") && markup.includes("留下"), "只有选项时直接显示选项");
assert.ok(markup.indexOf('class="stage-choices"') < markup.indexOf('class="stage-dialog-wrap"'), "选项独立于底部对话区域，先于对话区域渲染");
assert.ok(!markup.includes("选择一项，或自由输入"), "选项区域不再显示操作说明标题");
markup = renderToStaticMarkup(React.createElement(StageView, { ...stageProps, messages: [] }));
assert.ok(markup.includes("开始剧情"), "空会话给「开始剧情」");
markup = renderToStaticMarkup(React.createElement(StageView, { ...stageProps, messages: [], chatMode: "free" }));
assert.ok(markup.includes("与场景中的角色对话"), "自由模式空状态");

const { bubbleClass } = require(src("components/ChatPanel.tsx"));
assert.equal(bubbleClass({ role: "user", content: "" }, false), "is-user");
assert.equal(bubbleClass({ role: "narrator", content: "" }, true), "is-narrator is-plain");
assert.equal(bubbleClass({ role: "narrator", content: "" }, false), "is-narrator");
assert.equal(bubbleClass({ role: "system", content: "", choices: ["a"] }, false), "is-choices");
assert.equal(bubbleClass({ role: "system", content: "" }, false), "is-system");

// 源码接线：ChatPanel 不再引用已删除的 resourcePanelOpen；store 不再有该字段
const chatPanelSrc = fs.readFileSync(src("components/ChatPanel.tsx"), "utf8");
assert.ok(!chatPanelSrc.includes("resourcePanelOpen"), "ChatPanel 不再引用 resourcePanelOpen");
const storeSrc = fs.readFileSync(src("stores/appStore.ts"), "utf8");
assert.ok(!storeSrc.includes("resourcePanelOpen") && storeSrc.includes("scenePanelOpen") && storeSrc.includes("chatLayout"));
const indexSrc = fs.readFileSync(src("plugins/index.ts"), "utf8");
assert.ok(indexSrc.includes('import.meta.glob("./custom/*.tsx"'), "第三方面板自动加载");

console.log("test_stage_ui: all assertions passed");
