// Scoped color regression. --serve exposes an API-isolated, real-component desktop fixture.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const root = path.resolve(__dirname, "..");
const fromFrontend = createRequire(path.join(root, "frontend/package.json"));
const postcss = fromFrontend("postcss");
const css = postcss.parse(fs.readFileSync(path.join(root, "frontend/src/style.css"), "utf8"));
const source = fs.readFileSync(path.join(root, "frontend/src/components/session/SessionManagerView.tsx"), "utf8");

function declarations(selector) {
  let result;
  css.walkRules((rule) => {
    if (rule.selectors.includes(selector)) {
      result = Object.fromEntries(rule.nodes.filter((node) => node.type === "decl").map((node) => [node.prop, node.value]));
    }
  });
  assert.ok(result, `Missing rule: ${selector}`);
  return result;
}

function luminance(hex) {
  const rgb = hex.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

const buttons = source.match(/className="[^"]*session-delete-button[^"]*"/g) || [];
assert.equal(buttons.length, 2, "Single and batch session deletion must share the scoped palette");
for (const button of buttons) {
  assert.ok(button.includes("app-danger-button"), "Preserve shared disabled/focus behavior");
  assert.ok(!/\b(?:text-red|bg-red|border-red|text-white)/.test(button), "Remove conflicting theme color utilities");
}
for (const theme of ["light", "skin-tavern"]) {
  const selector = `html.${theme} .session-delete-button.session-delete-button`;
  const normal = declarations(selector);
  const hover = declarations(`${selector}:hover:not(:disabled)`);
  for (const [state, values] of [["normal", normal], ["hover", hover]]) {
    assert.match(values.background, /^#[a-f0-9]{6}$/i, "Solid background, not a gradient");
    const foreground = luminance(values.color);
    const background = luminance(values.background);
    const contrast = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    assert.ok(background > 0.7, "Light themes must retain a light button surface");
    assert.ok(contrast >= 4.5, `${theme}/${state}: text contrast ${contrast.toFixed(2)} < 4.5`);
    console.log(`${theme}/${state}: solid light surface, text contrast ${contrast.toFixed(2)}:1`);
  }
  assert.equal(declarations(`html.${theme} .session-delete-button:focus-visible`)["outline-color"], "currentColor");
}
css.walkRules((rule) => {
  if (!rule.selector.includes("session-delete-button")) return;
  assert.ok(rule.selectors.every((selector) => /^html\.(light|skin-tavern) /.test(selector)), "No dark/PRTS or global danger-button overrides");
});
console.log("Session deletion palette checks passed; browser verification is separate.");

async function serveFixture() {
  // Tailwind content globs and PostCSS config resolve from the frontend directory.
  process.chdir(path.join(root, "frontend"));
  const { createServer } = await import(pathToFileURL(path.join(root, "frontend/node_modules/vite/dist/node/index.js")).href);
  const session = { id: "palette-qa", name: "配色验收会话", mode: "story", characters: [], roster: [],
    player_identity: "玩家", narration_count: 0, combat_mode: "narrative", worldbook_ids: [], in_combat: false, created_at: 1791259200 };
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>会话删除配色验收</title></head>
    <body><div id="root"></div><script type="module">
    import React, { useState, useEffect } from 'react';
    import { createRoot } from 'react-dom/client';
    import SessionManagerView from '/src/components/session/SessionManagerView.tsx';
    import GlobalConfirmDialog from '/src/components/common/GlobalConfirmDialog.tsx';
    import { useAppStore } from '/src/stores/appStore.ts';
    import '/src/style.css';
    import '/src/styles/skin-prts.css';
    import '/src/styles/skin-tavern.css';
    useAppStore.setState({ sessions: [${JSON.stringify(session)}], activeSessionId: 'palette-qa', currentView: 'sessions', chatMode: 'story' });
    function Fixture() {
      const [theme, setTheme] = useState('light');
      useEffect(() => {
        document.documentElement.classList.toggle('light', theme === 'light');
        document.documentElement.classList.toggle('skin-prts', theme === 'prts');
        document.documentElement.classList.toggle('skin-tavern', theme === 'tavern');
      }, [theme]);
      return React.createElement(React.Fragment, null,
        React.createElement('nav', { 'aria-label': '验收主题', style: {display:'flex',alignItems:'center',gap:16,padding:12,height:48} },
          React.createElement('span', null, '隔离验收 · 所有 API 写入已拦截'),
          ...[['light','默认浅色'],['dark','默认深色'],['prts','PRTS'],['tavern','酒馆手札']].map(([value,label]) =>
            React.createElement('label', {key:value}, React.createElement('input', {type:'radio',name:'theme',checked:theme===value,onChange:()=>setTheme(value)}), ' ' + label))),
        React.createElement('div', {style:{height:'calc(100vh - 48px)'}}, React.createElement(SessionManagerView)),
        React.createElement(GlobalConfirmDialog));
    }
    createRoot(document.getElementById('root')).render(React.createElement(Fixture));
    </script></body></html>`;
  const server = await createServer({
    root: path.join(root, "frontend"), configFile: path.join(root, "frontend/vite.config.web.ts"),
    cacheDir: path.join(root, ".impeccable/delete-colors/vite-cache"),
    server: { host: "127.0.0.1", port: 5198, strictPort: true },
    plugins: [{ name: "session-delete-colors-fixture", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url, "http://127.0.0.1:5198").pathname;
        if (pathname.startsWith("/api/")) {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          if (req.method !== "GET") {
            res.statusCode = 409;
            res.end(JSON.stringify({ error: "配色验收只读，不执行真实删除或其他写入" }));
            return;
          }
          const data = pathname === "/api/worldbook" ? { books: [] }
            : pathname === "/api/combat/resumes" ? { sessions: [], tests: [] }
            : pathname === "/api/sessions" ? [session]
            : pathname === "/api/sessions/palette-qa" ? session : [];
          res.end(JSON.stringify(data));
          return;
        }
        if (pathname === "/__qa__/session-delete-colors.html") {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(await vite.transformIndexHtml(req.url, html));
          return;
        }
        next();
      });
    } }],
  });
  await server.listen();
  console.log("API-isolated real-component fixture: http://127.0.0.1:5198/__qa__/session-delete-colors.html");
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { await server.close(); process.exit(0); });
}
if (process.argv.includes("--serve")) serveFixture().catch((error) => { console.error(error); process.exitCode = 1; });
