"""Deterministic session graph browser QA; mocks API, never mutates live sessions.

Run Vite web on :5178, then python scripts/test_session_graph_browser.py.
"""
import json
import os
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / ".impeccable" / "review"
BASE_URL = os.environ.get("SESSION_GRAPH_URL", "http://127.0.0.1:5178")
SESSION = {"id": "graph-qa", "name": "长夜归途 · 节点图验收", "mode": "story",
           "characters": ["临光", "瑕光"], "player_identity": "博士", "narration_count": 3,
           "combat_mode": "narrative", "worldbook_ids": [], "in_combat": False}
MESSAGES = [{"role": "narrator", "content": "雨声渐止，临光在桥头停下脚步。", "round": 3},
            {"role": "system", "content": "请选择", "round": 3,
             "branches": [{"id": "follow", "label": "沿着灯光继续前进"}]}]


def node(id_, parent, title, depth, summary=""):
    return dict(id=id_, parent_id=parent, title=title, depth=depth, summary=summary,
                children=[], branches=[], kind="beat", has_state=True,
                state="visited", round_start=depth + 1, round_end=depth + 1)


NODES = [node("entry", None, "抵达雨中的卡瓦莱利亚基", 0),
         node("bridge", "entry", "桥头的约定", 1, "临光与博士在桥头会合，决定下一步的去向。"),
         node("market", "bridge", "穿过旧城区集市", 2),
         node("tower", "bridge", "前往钟楼寻找线索", 2),
         node("dawn", "market", "天亮之前", 3)]


def run():
    SHOTS.mkdir(parents=True, exist_ok=True)
    state = {"current": "market", "error": False, "empty": False, "cast_error": False}
    requests = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 960}, reduced_motion="reduce")
        errors = []
        console_errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)

        def route_api(route):
            path = urlparse(route.request.url).path
            requests.append((route.request.method, path))
            if path.endswith("/story-state"):
                if state["error"]:
                    route.fulfill(status=503, json={"error": "验收模拟：剧情状态暂不可用"})
                    return
                current = state["current"]
                body = {"has_plot": not state["empty"], "plot_name": "长夜归途", "roads": [],
                        "chapter": {"idx": 0, "title": "雨中的约定", "total": 1},
                        "tree": {"has_tree": not state["empty"], "root_id": "entry", "current_id": current,
                                 "path": ["entry", "bridge", current], "nodes": [] if state["empty"] else NODES,
                                 "current_node": next(n for n in NODES if n["id"] == current)}}
            elif path.endswith("/stage"):
                if state["cast_error"]:
                    route.fulfill(status=503, json={"error": "验收模拟：场景暂不可用"})
                    return
                body = {"session_id": SESSION["id"], "location": "旧城区", "weather": "小雨", "time": "夜晚",
                        "atmosphere": [], "background": {"url": None, "source": "none", "bg_id": ""},
                        "characters": [{"name": name, "skin_url": None, "avatar_url": None, "color": None, "active": True}
                                       for name in SESSION["characters"]],
                        "player": {"name": "博士", "skin_url": None, "avatar_url": None, "color": None}}
            elif path == "/api/sessions":
                body = [SESSION]
            elif path == "/api/sessions/graph-qa":
                body = SESSION
            elif path.endswith("/memories"):
                body = {"memories": [], "narration_count": 3}
            elif path.endswith("/characters"):
                body = {"characters": SESSION["characters"], "character_colors": {}}
            elif path.endswith("/avatar"):
                route.fulfill(status=404, body="no avatar in synthetic fixture")
                return
            elif path.endswith("/config"):
                body = {"theme": "dark", "skin": "default"}
            else:
                body = {}
            route.fulfill(json=body)

        page.route("**/api/**", route_api)
        page.goto(BASE_URL)
        page.evaluate("""async ({session, messages}) => {
          const {useAppStore} = await import('/src/stores/appStore.ts');
          window.qaStore = useAppStore;
          useAppStore.setState({currentView:'chat', chatMode:'story', activeSessionId:session.id,
            sessions:[session], chatLayout:'stage', scenePanelOpen:false,
            sessionMessages:{[session.id]:messages}, sessionNarrationCount:{[session.id]:3}});
        }""", {"session": SESSION, "messages": MESSAGES})
        page.wait_for_timeout(500)
        assert not errors, errors
        # Enter through the requested story sidebar, not only the top-level shortcut.
        page.get_by_role("navigation", name="场景面板页签").get_by_role("button", name="剧情", exact=True).click()
        page.get_by_role("button", name="切换实时节点图", exact=True).click()
        page.locator(".session-story-graph").wait_for()
        page.get_by_text("穿过旧城区集市", exact=True).first.wait_for()
        page.get_by_role("button", name="收起场景面板", exact=True).click()
        current = page.locator(".session-story-graph [aria-current='step']")
        expect(current.locator(".session-graph-cast")).to_have_attribute("aria-label", "同处当前节点：博士、临光、瑕光")
        page.get_by_role("button", name="缩小节点图").click(click_count=2)
        expect(page.get_by_role("button", name="缩小节点图")).to_be_disabled()
        page.get_by_role("button", name="放大节点图").click(click_count=4)
        expect(page.get_by_role("button", name="放大节点图")).to_be_disabled()
        page.get_by_role("button", name="缩小节点图").click(click_count=2)
        canvas = page.get_by_role("region", name="剧情节点画布")
        canvas.focus()
        page.keyboard.press("ArrowRight")
        page.keyboard.press("Home")
        assert canvas.evaluate("el => getComputedStyle(el).outlineStyle != 'none'"), "keyboard focus visible"
        current.hover()
        current.focus()
        page.keyboard.press("Enter")
        expect(page.get_by_role("complementary", name="节点详情")).to_contain_text("只读查看")
        page.screenshot(path=str(SHOTS / "desktop.png"), full_page=True)
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(100)
        assert current.evaluate("el => { const a=el.getBoundingClientRect(); const b=el.closest('.session-graph-viewport').getBoundingClientRect(); return a.left >= b.left && a.right <= b.right; }"), "current avatar card remains visible after resize"
        page.screenshot(path=str(SHOTS / "mobile.png"), full_page=True)
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "mobile page overflow"
        state["current"] = "tower"
        page.evaluate("qaStore.getState().triggerEnvRefresh()")
        page.wait_for_timeout(300)
        # The current marker must follow rollback/branch change without remounting.
        expect(current).to_contain_text("前往钟楼寻找线索")
        page.evaluate("qaStore.setState({sessionStreaming:{'graph-qa':true}})")
        expect(page.get_by_role("button", name="刷新节点图")).to_be_disabled()
        expect(page.get_by_role("group", name="剧情分支选项").get_by_role("button")).to_be_disabled()
        expect(page.locator(".session-graph-status[role='status']")).to_contain_text("剧情生成中")
        state["current"] = "market"
        page.evaluate("qaStore.setState({sessionStreaming:{'graph-qa':false}})")
        expect(current).to_contain_text("穿过旧城区集市")
        state["cast_error"] = True
        page.evaluate("qaStore.getState().triggerEnvRefresh()")
        expect(page.get_by_role("button", name="重试角色加载")).to_be_visible()
        state["cast_error"] = False
        page.get_by_role("button", name="重试角色加载").click()
        expect(page.get_by_role("button", name="重试角色加载")).to_have_count(0)
        state["error"] = True
        page.evaluate("qaStore.getState().triggerEnvRefresh()")
        expect(page.get_by_text("验收模拟：剧情状态暂不可用", exact=False)).to_be_visible()
        state["error"] = False
        page.get_by_role("button", name="重试", exact=False).click()
        expect(current).to_contain_text("穿过旧城区集市")
        page.get_by_role("group", name="节点图操作").get_by_role("button", name="对话记录").click()
        expect(page.locator(".stage-log-overlay")).to_be_visible()
        page.locator(".stage-log-overlay").get_by_role("button", name="关闭", exact=True).click()
        page.get_by_role("group", name="对话布局").get_by_role("button", name="舞台", exact=True).click()
        expect(page.locator(".session-story-graph")).to_have_count(0)
        page.get_by_role("group", name="对话布局").get_by_role("button", name="节点图").click()
        state["empty"] = True
        page.evaluate("qaStore.getState().triggerEnvRefresh()")
        expect(page.get_by_role("heading", name="当前会话未绑定剧情")).to_be_visible()
        expect(page.get_by_role("button", name="缩小节点图")).to_be_disabled()
        page.evaluate("qaStore.setState({chatMode:'free'})")
        expect(page.locator(".session-story-graph")).to_have_count(0)
        expect(page.get_by_role("group", name="对话布局").get_by_role("button", name="节点图")).to_have_count(0)
        assert not errors, errors
        unexpected_console = [message for message in console_errors if "Failed to load resource" not in message]
        assert not unexpected_console, unexpected_console
        assert all(method == "GET" for method, _ in requests), "QA must not issue mutation requests"
        print(json.dumps({"result": "pass", "browser_errors": errors, "api_requests": len(requests),
                          "expected_resource_errors": len(console_errors), "unexpected_console_errors": unexpected_console,
                          "viewports": ["1440x960", "390x844"], "url": BASE_URL,
                          "screenshots": str(SHOTS)}, ensure_ascii=False))
        browser.close()


if __name__ == "__main__":
    run()
