// No backend or user data: state transitions, markup and native-dialog regressions.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "..");
const fromFrontend = createRequire(path.join(root, "frontend/package.json"));
const ts = fromFrontend("typescript");
require.extensions[".css"] = () => {};
for (const ext of [".ts", ".tsx"]) require.extensions[ext] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
  });
  module._compile(outputText, filename);
};
const { confirmAction, settleConfirmation, useConfirmStore } = require("../frontend/src/stores/confirmStore.ts");
const React = fromFrontend("react");
const { renderToStaticMarkup } = fromFrontend("react-dom/server");
const ConfirmDialog = require("../frontend/src/components/common/ConfirmDialog.tsx").default;

(async () => {
  const cancelled = confirmAction("删除测试内容", { title: "删除图片" });
  assert.equal(useConfirmStore.getState().pending.title, "删除图片");
  assert.equal(await confirmAction("重复请求"), false, "must not queue a second deletion");
  settleConfirmation(false);
  assert.equal(await cancelled, false);
  assert.equal(useConfirmStore.getState().pending, null);
  const confirmed = confirmAction("删除测试内容");
  settleConfirmation(true);
  settleConfirmation(false);
  assert.equal(await confirmed, true, "settlement is once only");
  const markup = renderToStaticMarkup(React.createElement(ConfirmDialog, {
    title: "删除图片", confirmLabel: "删除图片", onCancel() {}, onConfirm() {},
  }, "删除后不可恢复"));
  assert.match(markup, /<dialog[^>]+aria-labelledby=/);
  assert.match(markup, /aria-describedby=/);
  assert.ok(markup.indexOf("取消") < markup.indexOf("app-confirm-submit"));
  const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
    const filename = path.join(directory, item.name);
    return item.isDirectory() ? walk(filename) : /\.tsx?$/.test(filename) ? [filename] : [];
  });
  for (const filename of walk(path.join(root, "frontend/src"))) {
    assert.doesNotMatch(fs.readFileSync(filename, "utf8"), /(?:window\.)?\bconfirm\s*\(/,
      `${path.relative(root, filename)} still opens a system confirmation`);
  }
  assert.ok(!fs.existsSync(path.join(root, "frontend/src/styles/worldbook-delete-dialog.css")));
  console.log("PASS: confirmation state, repeated requests, accessible markup and no native confirm calls");
})().catch((error) => { console.error(error); process.exitCode = 1; });
