"""Worldbook graph authoring QA with fully intercepted APIs; no live data writes.

Run Vite web on :5188, then python scripts/test_graph_details_browser.py.
"""
import copy
import json
import os
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("GRAPH_DETAILS_URL", "http://127.0.0.1:5188")
SHOTS = Path(__file__).resolve().parents[1] / ".impeccable/review/graph-details"
PLOT = {"plot_id": "p", "name": "雨夜的抉择", "summary": "一把钥匙，两种去向。", "worldbook_id": "one", "source": "outline", "combat_nodes": [], "chapters": [
    {"idx": 2, "id": "arrival", "title": "桥头", "label": "第二幕：桥头", "kind": "main", "combat_nodes": [], "beats": [
        {"id": "choose", "title": "桥头的抉择", "summary": "听到门后的呼唤。", "content": "这是该节点的完整正文，不是剧情原文。\n门后的声音忽然停止，玩家手中的钥匙亮起。", "must_keep": "钥匙必须由玩家决定是否使用。", "guidance": "不替玩家做决定", "choice_required": True, "min_rounds": 2, "combat_nodes": [], "branches": [{"label": "使用共鸣钥匙", "intent": "打开门并保留证据", "target_beat_id": "door"}]},
        {"id": "door", "title": "门后的真相", "summary": "进入房间", "combat_nodes": [], "branches": []},
    ]},
]}
GRAPH = {"schema_version": 1, "plot_id": "p", "worldbook_id": "one", "nodes": [
    {"id": "choose", "type": "beat", "title": "旧标题", "content": "过期摘要", "x": 40, "y": 80, "ref": {"chapter_idx": 1, "beat_id": "choose"}, "scene_media": {"background": {"kind": "image", "asset": "plots/p/art/cg.png", "role": "cg", "fit": "contain", "position": [50, 50], "portraits": "hide"}}},
    {"id": "door", "type": "beat", "title": "门后", "x": 420, "y": 80, "ref": {"chapter_idx": 2, "beat_id": "door"}},
    {"id": "missing", "type": "beat", "title": "失效节点", "x": 40, "y": 320, "ref": {"chapter_idx": 8, "beat_id": "deleted"}},
], "edges": [{"id": "route", "from": "choose", "to": "door"}]}


# The same asset in multiple triggers occupies one thumbnail; distinct CGs stay visible.
visual = GRAPH["nodes"][0]["scene_media"]["background"]
GRAPH["nodes"][0]["scene_media"]["events"] = [
    {"id": "echo", "title": "回声", "trigger": {"kind": "enter"}, "repeat": "session", "priority": 0,
     "actions": [{"kind": "set_visual", "visual": copy.deepcopy(visual)},
                 {"kind": "set_visual", "visual": {**visual, "asset": "plots/p/art/echo.png"}}]},
]
SIZES = [(1280, 720), (1400, 900), (1600, 900), (1920, 1080), (2560, 1440)]


def run():
    SHOTS.mkdir(parents=True, exist_ok=True)
    saved, errors, unexpected = [], [], []
    stored = {}
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1400, "height": 900}, reduced_motion="reduce")
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)

        def route_api(route):
            request = route.request
            parsed = urlparse(request.url)
            path = parsed.path
            book = parse_qs(parsed.query).get("book_id", ["one"])[0]
            if path == "/api/worldbook":
                body = {"books": [{"id": "one", "name": "第一本书", "book_type": "story"}, {"id": "two", "name": "第二本书", "book_type": "story"}]}
            elif path in ("/api/worldbook/one", "/api/worldbook/two"):
                book_id = path.rsplit("/", 1)[1]
                body = {"id": book_id, "name": "第一本书" if book_id == "one" else "第二本书", "book_type": "story",
                        "description": "世界书简介用于检验收起后画布的可用高度。", "entries": [], "categories": [],
                        "scope_mode": "selective", "dependency_rules": {"roots": []}, "import_config": {}, "stat_fields": []}
            elif path == "/api/worldbook/data-dir":
                body = {"path": "fixture/books"}
            elif path == "/api/combat/nodes/graph":
                plot = copy.deepcopy(PLOT)
                plot["worldbook_id"] = book
                if book == "two":
                    plot["chapters"][0]["beats"][0]["title"] = "第二本书独有节点"
                body = {"book_id": book, "plots": [plot], "nodes": [], "meta": {}}
            elif path == "/api/plot-graphs":
                body = {"book_id": book, "graphs": ["p"]}
            elif path == "/api/plot-graphs/p" and request.method == "GET":
                graph = copy.deepcopy(stored.get(book, GRAPH))
                graph["worldbook_id"] = book
                if book == "two":
                    graph["nodes"] = [graph["nodes"][0]]
                    graph["nodes"][0].pop("scene_media", None)
                    graph["edges"] = []
                body = {"graph": graph}
            elif path == "/api/plot-graphs/p" and request.method == "PUT":
                saved.append(request.post_data_json)
                stored[book] = request.post_data_json["graph"]
                body = {"ok": True, "_revision": str(len(saved))}
            elif path == "/api/plot-graphs/p/media-options":
                body = {"choices": {}}
            elif path == "/api/assets/images":
                body = [{"worldbook_id": "one", "entity_name": "雨夜的抉择", "images": [
                    {"name": "新的CG", "asset_path": "plots/p/art/new.png", "url": "/api/assets/plots/p/art/new.png?worldbook_id=one"}]}]
            elif path.endswith("/presentation-image"):
                route.fulfill(content_type="image/svg+xml", body='<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#344454"/><path d="M0 260L180 90L350 280L500 120L640 260" fill="#668c93"/><text x="245" y="185" fill="white" font-size="28">CG fixture</text></svg>')
                return
            else:
                if request.method != "GET":
                    unexpected.append((request.method, path))
                body = [] if path in ("/api/sessions", "/api/llm/backends") else {}
            route.fulfill(json=body)

        page.route("**/api/**", route_api)
        page.goto(BASE)
        page.evaluate("""async () => {
          const {default: React} = await import('/node_modules/.vite/deps/react.js');
          const {default: ReactDOM} = await import('/node_modules/.vite/deps/react-dom_client.js');
          const {default: Manager} = await import('/src/components/WorldBookManager.tsx');
          const {useAppStore} = await import('/src/stores/appStore.ts');
          document.getElementById('root').style.display='none';
          localStorage.clear(); useAppStore.setState({worldbookTab:'graph', worldbookGraphJumpId:'one'});
          const host=document.createElement('div');host.style.cssText='height:100dvh;width:100vw';document.body.append(host);
          ReactDOM.createRoot(host).render(React.createElement(Manager));
        }""")
        node = page.locator('[data-ng-node="choose"]')
        node.wait_for()
        thumbs = page.locator('[data-ng-cg-node="choose"] img')
        expect(thumbs).to_have_count(2)
        thumbs.first.evaluate("img => img.decode()")
        assert page.get_by_role("button", name="演出配置", exact=True).count() == 0
        assert page.get_by_label("选择演出节点").count() == 0
        page.get_by_role("button", name="更新 1 个移动引用").click()
        page.get_by_role("button", name="扩大查看", exact=True).click()
        expect(page.locator('.wber-hero')).to_be_hidden()
        for width, height in SIZES:
            page.set_viewport_size({"width": width, "height": height})
            page.get_by_title("适应视图：把所有节点纳入可视范围", exact=True).click()
            preview = page.locator('[data-ng-cg-node="choose"]')
            box, canvas = preview.bounding_box(), page.locator('.ng-viewport').bounding_box()
            assert box["y"] >= canvas["y"] and box["x"] >= canvas["x"], (width, height, box, canvas)
            expect(page.get_by_role("button", name="还原查看", exact=True)).to_be_visible()
            expanded_height = canvas["height"]
            page.get_by_role("button", name="还原查看", exact=True).click()
            expect(page.locator('.wber-hero')).to_be_visible()
            assert page.locator('.ng-viewport').bounding_box()["height"] < expanded_height - 100
            page.get_by_role("button", name="扩大查看", exact=True).click()
            node.dblclick()
            detail = page.get_by_role("region", name="节点内容详情")
            expect(detail).to_contain_text("这是该节点的完整正文")
            expect(detail).to_contain_text("使用共鸣钥匙")
            expect(detail).to_contain_text("最少 2 轮")
            page.get_by_role("tab", name="演出", exact=True).click()
            expect(page.get_by_role("button", name="保存节点图", exact=True)).to_be_visible()
            # Header/footer remain fixed; the library is reachable by scrolling the panel.
            page.get_by_placeholder("搜索图片或所属条目").fill("新的")
            expect(page.get_by_role("button", name="新的CG", exact=False)).to_have_count(1)
            page.get_by_role("button", name="关闭演出配置").click()
            page.wait_for_timeout(300)
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            page.screenshot(path=str(SHOTS / f"expanded-{width}x{height}.png"), full_page=True)
        page.set_viewport_size({"width": 1400, "height": 900})
        page.get_by_title("适应视图：把所有节点纳入可视范围", exact=True).click()
        node.dblclick()
        page.get_by_role("tab", name="内容", exact=True).focus()
        page.keyboard.press("Delete")
        page.keyboard.press("Backspace")
        expect(page.get_by_role("dialog", name="移除图中节点")).to_have_count(0)
        page.keyboard.press("ArrowRight")
        expect(page.get_by_role("tab", name="演出", exact=True)).to_have_attribute("aria-selected", "true")
        expect(page.get_by_role("tab", name="演出", exact=True)).to_be_focused()
        page.keyboard.press("ArrowLeft")
        expect(page.get_by_role("tab", name="内容", exact=True)).to_be_focused()
        page.keyboard.press("ArrowRight")
        page.get_by_role("button", name="新的CG", exact=False).click()
        expect(thumbs).to_have_count(3)
        page.get_by_role("button", name="保存节点图", exact=True).click()
        expect(page.locator('.ng-media-save-message')).to_contain_text("已保存到")
        assert saved[-1]["graph"]["nodes"][0]["scene_media"]["background"]["asset"].endswith("new.png")
        page.screenshot(path=str(SHOTS / "node-presentation.png"), full_page=True)
        page.get_by_role("button", name="关闭演出配置").click()
        page.keyboard.press("Control+z")
        expect(thumbs).to_have_count(2)
        page.get_by_role("button", name="保存", exact=False).last.click()
        page.wait_for_function("document.body.innerText.includes('已保存到')")
        assert saved[-1]["graph"]["nodes"][0]["scene_media"]["background"]["asset"].endswith("cg.png")
        # Previews are attached to the card, and moving the card moves the CG and short lines.
        page.wait_for_timeout(300)
        before, cg_before = node.bounding_box(), thumbs.first.bounding_box()
        page.mouse.move(before["x"] + 50, before["y"] + 20)
        page.mouse.down(); page.mouse.move(before["x"] + 110, before["y"] + 55, steps=8); page.mouse.up()
        after, cg_after = node.bounding_box(), thumbs.first.bounding_box()
        assert abs((after["x"] - before["x"]) - (cg_after["x"] - cg_before["x"])) < 2
        assert abs((after["y"] - before["y"]) - (cg_after["y"] - cg_before["y"])) < 2
        expect(page.locator('[data-ng-cg-node="choose"] line')).to_have_count(2)
        # Missing references still have a repair path; layout/media remain intact through undo.
        page.locator('[data-ng-node="missing"]').dblclick()
        detail = page.get_by_role("region", name="节点内容详情")
        expect(detail).to_contain_text("引用已失效")
        page.get_by_label("重新关联资源", exact=True).select_option("2:door")
        page.get_by_role("button", name="应用关联").click()
        expect(detail).to_contain_text("门后的真相")
        page.get_by_role("button", name="关闭节点详情").click()
        page.get_by_role("button", name="撤销", exact=False).click()
        expect(page.locator('[data-ng-node="missing"]')).to_contain_text("引用已失效")
        page.get_by_role("button", name="第二本书", exact=False).click()
        expect(page.locator('[data-ng-node]')).to_have_count(1)
        expect(node).to_contain_text("第二本书独有节点")
        expect(page.locator('.ng-node-cgs')).to_have_count(0)
        expect(page.locator('.wber-hero')).to_be_visible()
        page.get_by_role("button", name="第一本书", exact=False).click()
        expect(page.locator('[data-ng-node]')).to_have_count(3)
        expect(thumbs).to_have_count(2)
        page.get_by_role("button", name="扩大查看", exact=True).click()
        page.get_by_title("适应视图：把所有节点纳入可视范围", exact=True).click()
        for theme in ["", "light", "skin-prts", "skin-tavern"]:
            page.evaluate("theme => document.documentElement.className = theme", theme)
            node.dblclick()
            page.get_by_role("tab", name="演出", exact=True).click()
            expect(page.get_by_role("button", name="保存节点图", exact=True)).to_be_visible()
            page.screenshot(path=str(SHOTS / f"presentation-{theme or 'dark'}.png"), full_page=True)
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
        assert not errors, errors
        assert not unexpected, unexpected
        print(json.dumps({"result": "pass", "saved_graphs": len(saved), "viewports": SIZES,
                          "browser_errors": errors, "screenshots": str(SHOTS)}, ensure_ascii=False))
        browser.close()


if __name__ == "__main__":
    run()
