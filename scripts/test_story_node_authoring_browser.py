"""Browser + real Flask authoring roundtrip against temporary books only.

Start the isolated Vite web server on :5189 before running this script.
"""
import json
import os
import re
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlparse

from flask import Flask
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
import combat_nodes
import data_paths
from blueprints.plot_graphs import register
from plot_graphs import load_graph
from story_outline import load_outline
from world_book import WorldBook, WorldBookManager

SIZES = [(1280, 720), (1400, 900), (1600, 900), (1920, 1080), (2560, 1440)]
BASE = os.environ.get("STORY_NODE_URL", "http://127.0.0.1:5189")
SHOTS = ROOT / ".impeccable/review/story-node-authoring"


def run():
    with TemporaryDirectory(prefix="story-node-qa-") as directory, sync_playwright() as playwright:
        data_paths.PROJECT_ROOT = Path(directory)
        manager = WorldBookManager(Path(directory) / "data/worldbooks")
        for book_id, body in [("outline", "## 第一幕：桥头\n原始故事\n"),
                              ("narrative", "## 章节 7：桥头\n#### beat_old\n**内容**：旧标题\n旧正文\n"),
                              ("empty", "# 空白剧情\n")]:
            manager.save(WorldBook(book_id, name=book_id))
            path = manager._path(book_id).parent / "plots/p/index.md"
            path.parent.mkdir(parents=True)
            path.write_text("---\nid: p\nname: 测试剧情\n---\n\n" + body, encoding="utf-8")
        app = Flask(__name__)
        register(app, {"worldbook": manager})
        client = app.test_client()
        errors, writes = [], []
        browser = playwright.chromium.launch()
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        page.on("pageerror", lambda error: errors.append(str(error)))

        def api(route):
            req = route.request
            parsed = urlparse(req.url)
            if parsed.path.startswith("/api/plot-graphs"):
                if req.method != "GET":
                    writes.append((req.method, parsed.path))
                response = client.open(parsed.path + ("?" + parsed.query if parsed.query else ""),
                                       method=req.method, data=req.post_data,
                                       content_type="application/json")
                route.fulfill(status=response.status_code, content_type="application/json", body=response.data)
            elif parsed.path == "/api/combat/nodes/graph":
                from urllib.parse import parse_qs
                book = parse_qs(parsed.query)["book_id"][0]
                route.fulfill(json={"book_id": book, "plots": combat_nodes.plot_flows(manager, book_id=book),
                                    "nodes": [], "meta": {}})
            elif parsed.path == "/api/worldbook":
                route.fulfill(json={"books": [{"id": b, "name": b} for b in ["outline", "narrative", "empty"]]})
            else:
                assert req.method == "GET", (req.method, parsed.path)
                route.fulfill(json=[] if parsed.path in ["/api/sessions", "/api/llm/backends"] else {})

        page.route("**/api/**", api)
        page.goto(BASE)
        page.evaluate("""async () => {
          const {default: React} = await import('/node_modules/.vite/deps/react.js');
          const {default: ReactDOM} = await import('/node_modules/.vite/deps/react-dom_client.js');
          const {default: Graph} = await import('/src/components/combat/PlotGraphPage.tsx');
          document.getElementById('root').style.display = 'none'; localStorage.clear();
          const host = document.createElement('div'); host.style.cssText='height:100dvh;width:100vw';
          document.body.append(host); const root = ReactDOM.createRoot(host);
          window.qaMount = book => root.render(React.createElement(Graph, {bookId:book,key:Math.random()}));
          window.qaMount('outline');
        }""")
        SHOTS.mkdir(parents=True, exist_ok=True)
        created = []
        for width, height in SIZES:
            page.set_viewport_size({"width": width, "height": height})
            page.get_by_title("新建剧情节点并同步到世界书", exact=True).click()
            dialog = page.get_by_role("dialog", name="新建剧情节点")
            title = f"桥头相遇{width}"
            dialog.get_by_label("剧情节点标题").fill(title)
            dialog.get_by_label("剧情节点正文").fill("听见门后的呼唤。\n玩家决定是否开门。")
            dialog.get_by_role("button", name="创建并上图").focus()
            page.keyboard.press("Tab")
            expect(dialog.get_by_role("button", name="关闭", exact=True)).to_be_focused()
            page.keyboard.press("Delete")
            page.keyboard.press("Backspace")
            expect(page.get_by_role("dialog", name="移除图中节点")).to_have_count(0)
            assert dialog.bounding_box()["height"] <= height
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            page.screenshot(path=str(SHOTS / f"create-{width}x{height}.png"))
            dialog.get_by_role("button", name="创建并上图").click()
            expect(dialog).to_have_count(0)
            detail = page.get_by_role("region", name="节点内容详情")
            expect(detail).to_contain_text("玩家决定是否开门。")
            graph = load_graph(manager, "outline", "p")
            node = graph["nodes"][-1]
            created.append(node["id"])
            expect(page.locator(f'[data-ng-node="{node["id"]}"]')).to_have_class(re.compile(r".*ng-node-beat.*"))
            expect(detail).not_to_contain_text("引用已失效")
            page.get_by_role("button", name="关闭节点详情").click()
        # Edit the underlying outline from the newly created blue node.
        node_id = created[-1]
        page.locator(f'[data-ng-node="{node_id}"]').dblclick()
        page.get_by_role("button", name="编辑剧情节点").click()
        editor = page.get_by_role("form", name="编辑剧情节点")
        editor.get_by_label("剧情节点标题").fill("新的抉择")
        editor.get_by_label("剧情节点正文").fill("编辑后的正文")
        editor.get_by_role("button", name="保存剧情节点").click()
        expect(editor).to_contain_text("已保存到世界书")
        manager._cache.clear()
        assert load_outline(manager, "outline", "p")["chapters"][0]["beats"][-1]["content"] == "编辑后的正文"
        page.evaluate("window.qaMount('outline')")
        expect(page.locator(f'[data-ng-node="{node_id}"]')).to_contain_text("新的抉择")
        for book in ["narrative", "empty"]:
            page.evaluate("book => window.qaMount(book)", book)
            page.get_by_title("新建剧情节点并同步到世界书", exact=True).click()
            dialog = page.get_by_role("dialog", name="新建剧情节点")
            dialog.get_by_label("剧情节点标题").fill(f"新剧情{book}")
            dialog.get_by_label("剧情节点正文").fill("世界书同步正文")
            dialog.get_by_role("button", name="创建并上图").click()
            expect(dialog).to_have_count(0)
            expect(page.get_by_role("region", name="节点内容详情")).to_contain_text("世界书同步正文")
            page.get_by_role("button", name="编辑剧情节点").click()
            editor = page.get_by_role("form", name="编辑剧情节点")
            editor.get_by_label("剧情节点正文").fill("世界书同步正文二次编辑")
            editor.get_by_role("button", name="保存剧情节点").click()
            expect(editor).to_contain_text("已保存到世界书")
            manager._cache.clear()
            node = load_graph(manager, book, "p")["nodes"][-1]
            page.evaluate("book => window.qaMount(book)", book)
            expect(page.locator(f'[data-ng-node="{node["id"]}"]')).to_be_visible()
            page.locator(f'[data-ng-node="{node["id"]}"]').dblclick()
            expect(page.get_by_role("region", name="节点内容详情")).to_contain_text("世界书同步正文二次编辑")
        page.get_by_role("button", name="关闭节点详情").click()
        for theme in ["light", "skin-prts", "skin-tavern"]:
            page.evaluate("theme => document.documentElement.className = theme", theme)
            page.get_by_title("新建剧情节点并同步到世界书", exact=True).click()
            dialog = page.get_by_role("dialog", name="新建剧情节点")
            dialog.get_by_label("剧情节点标题").fill("主题检查")
            dialog.get_by_label("剧情节点正文").fill("可读正文")
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            page.screenshot(path=str(SHOTS / f"create-{theme}.png"))
            page.keyboard.press("Escape")
            expect(dialog).to_have_count(0)
        # The blank-canvas context menu exposes the same creation form.
        viewport = page.locator('.ng-viewport')
        viewport.click(button="right", position={"x": 30, "y": 30})
        page.locator('.ng-menu').get_by_role("button", name="新建剧情节点", exact=True).click()
        expect(page.get_by_role("dialog", name="新建剧情节点")).to_be_visible()
        page.keyboard.press("Escape")
        assert not errors, errors
        print(json.dumps({"result": "pass", "viewports": SIZES, "writes": writes, "errors": errors,
                          "screenshots": str(SHOTS)}, ensure_ascii=False))
        browser.close()


if __name__ == "__main__":
    run()
