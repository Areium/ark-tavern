"""Production graph component QA with fully intercepted APIs; no live data writes.

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


def run():
    SHOTS.mkdir(parents=True, exist_ok=True)
    saved = []
    errors = []
    unexpected = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 960}, reduced_motion="reduce")
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)

        def route_api(route):
            request = route.request
            parsed = urlparse(request.url)
            path = parsed.path
            book = parse_qs(parsed.query).get("book_id", ["one"])[0]
            if path == "/api/worldbooks":
                body = {"books": [{"id": "one", "name": "第一本书"}, {"id": "two", "name": "第二本书"}]}
            elif path == "/api/combat/nodes/graph":
                plot = copy.deepcopy(PLOT)
                plot["worldbook_id"] = book
                if book == "two":
                    plot["chapters"][0]["beats"][0]["title"] = "第二本书独有节点"
                body = {"book_id": book, "plots": [plot], "nodes": [], "meta": {}}
            elif path == "/api/plot-graphs":
                body = {"book_id": book, "graphs": ["p"]}
            elif path == "/api/plot-graphs/p" and request.method == "GET":
                graph = copy.deepcopy(GRAPH)
                graph["worldbook_id"] = book
                if book == "two":
                    graph["nodes"] = [graph["nodes"][0]]
                    graph["edges"] = []
                body = {"graph": graph}
            elif path == "/api/plot-graphs/p" and request.method == "PUT":
                saved.append(request.post_data_json)
                body = {"ok": True, "_revision": 1}
            elif path == "/api/assets/images":
                body = []
            elif path.startswith("/api/assets/"):
                route.fulfill(content_type="image/svg+xml", body='<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#344454"/><text x="220" y="185" fill="white" font-size="28">CG fixture</text></svg>')
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
          const {default: Graph} = await import('/src/components/combat/PlotGraphPage.tsx');
          document.getElementById('root').style.display='none';
          const host=document.createElement('div');host.style.cssText='height:100dvh;width:100vw';document.body.append(host);
          const root=ReactDOM.createRoot(host);window.showBook=id=>root.render(React.createElement(Graph,{bookId:id}));showBook('one');
        }""")
        page.locator('[data-ng-node="choose"]').wait_for()
        page.get_by_role("button", name="更新 1 个移动引用").click()
        page.locator('[data-ng-node="choose"]').dblclick()
        detail = page.get_by_role("region", name="节点内容详情")
        expect(detail).to_contain_text("这是该节点的完整正文")
        expect(detail).to_contain_text("使用共鸣钥匙")
        expect(detail).to_contain_text("最少 2 轮")
        page.screenshot(path=str(SHOTS / "desktop-details.png"), full_page=True)
        page.get_by_role("button", name="关闭节点详情").click()
        edge = page.locator('[data-ng-edge="route"]')
        edge.focus()
        page.keyboard.press("Enter")
        expect(page.locator('.ng-edge-description')).to_contain_text("打开门并保留证据")
        page.locator('[data-ng-node="missing"]').dblclick()
        expect(detail).to_contain_text("引用已失效")
        page.get_by_label("重新关联资源", exact=True).select_option("2:door")
        page.get_by_role("button", name="应用关联").click()
        expect(detail).to_contain_text("门后的真相")
        page.get_by_role("button", name="关闭节点详情").click()
        page.get_by_role("button", name="撤销", exact=False).click()
        expect(page.locator('[data-ng-node="missing"]')).to_contain_text("引用已失效")
        page.get_by_role("button", name="保存", exact=False).last.click()
        page.wait_for_function("document.body.innerText.includes('已保存到')")
        assert saved[-1]["graph"]["nodes"][0]["ref"]["chapter_idx"] == 2
        assert saved[-1]["graph"]["nodes"][0]["scene_media"]["background"]["asset"].endswith("cg.png")
        # Same plot ID in a different book cannot reuse another book's draft.
        page.evaluate("showBook('two')")
        expect(page.locator('[data-ng-node]')).to_have_count(1)
        expect(page.locator('[data-ng-node="choose"]')).to_contain_text("第二本书独有节点")
        page.evaluate("showBook('one')")
        expect(page.locator('[data-ng-node]')).to_have_count(3)
        page.set_viewport_size({"width": 390, "height": 844})
        page.locator('[data-ng-node="choose"]').dblclick()
        expect(detail).to_contain_text("桥头的抉择")
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "mobile page overflow"
        page.screenshot(path=str(SHOTS / "mobile-details.png"), full_page=True)
        detail.get_by_role("button", name="演出配置").click()
        page.get_by_role("button", name="节拍 CG", exact=True).click()
        expect(page.get_by_alt_text("当前节拍 CG 预览")).to_be_visible()
        page.get_by_alt_text("当前节拍 CG 预览").evaluate("img => img.decode()")
        page.screenshot(path=str(SHOTS / "mobile-cg.png"), full_page=True)
        assert not errors, errors
        assert not unexpected, unexpected
        print(json.dumps({"result": "pass", "saved_graphs": len(saved), "viewports": ["1440x960", "390x844"], "browser_errors": errors, "screenshots": str(SHOTS)}, ensure_ascii=False))
        browser.close()


if __name__ == "__main__":
    run()
