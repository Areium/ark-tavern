"""Desktop shared-canvas QA against the isolated fixture, never the live backend.

Start: node scripts/test_story_rules_ui.cjs --serve
Then: python scripts/test_session_graph_browser.py
"""
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

SHOTS = Path(__file__).resolve().parents[1] / ".impeccable" / "review"


def run():
    SHOTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 960})
        errors, writes = [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("request", lambda request: writes.append(request.url)
                if request.method != "GET" and "/api/__fixture/" not in request.url else None)
        page.goto("http://127.0.0.1:5191")
        graph = page.locator(".session-story-graph")
        current = graph.locator("[aria-current='step']")
        expect(current).to_contain_text("桥头的约定")
        expect(current.locator(".session-graph-cast")).to_have_attribute("aria-label", "当前节点角色：玩家、同伴")
        expect(graph.locator(".ng-node[data-ng-progress='locked']").filter(has_text="旧城集市")).to_be_visible()
        assert graph.locator(".ng-anchor").count() == 0
        assert page.locator(".chat-input-bar").count() == 0
        assert graph.locator("textarea").count() == 0
        assert not page.get_by_text("会话轨迹", exact=True).count()
        for zoom in ["fit", "current"]:
            graph.get_by_role("button", name="⤢ 适应" if zoom == "fit" else "定位当前节点", exact=True).click()
            box = current.bounding_box()
            before = current.get_attribute("style")
            page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            page.mouse.down()
            page.mouse.move(box["x"] + box["width"] / 2 + 80, box["y"] + box["height"] / 2 + 50, steps=8)
            page.mouse.up()
            assert current.get_attribute("style") != before
        moved = current.get_attribute("style")
        current.dblclick()
        current.click(button="right")
        assert graph.locator(".ng-menu").count() == 0
        assert graph.locator("textarea").count() == 0
        page.reload()
        expect(current).to_have_attribute("style", moved)
        page.get_by_label("模拟剧情状态").select_option("rollback")
        expect(current).to_contain_text("抵达旧城")
        page.get_by_label("模拟剧情状态").select_option("normal")
        expect(current).to_contain_text("桥头的约定")
        page.get_by_label("模拟剧情状态").select_option("stage-error")
        expect(current).to_contain_text("桥头的约定")
        page.get_by_label("模拟剧情状态").select_option("normal")
        page.get_by_role("button", name="模拟生成状态").click()
        expect(graph.get_by_role("button", name="刷新节点图")).to_be_disabled()
        expect(graph.get_by_role("status")).to_contain_text("剧情生成中")
        page.get_by_role("button", name="模拟生成状态").click()
        page.get_by_label("模拟剧情状态").select_option("error")
        expect(graph.get_by_role("alert")).to_be_visible()
        page.get_by_label("模拟剧情状态").select_option("normal")
        expect(current).to_contain_text("桥头的约定")
        graph.get_by_role("button", name="⤢ 适应", exact=True).click()
        page.screenshot(path=str(SHOTS / "session-worldbook-canvas.png"))
        graph.get_by_role("button", name="对话记录", exact=True).click()
        expect(page.locator(".stage-log-overlay")).to_be_visible()
        page.locator(".stage-log-overlay").get_by_role("button", name="关闭", exact=True).click()
        page.get_by_label("测试布局").select_option("chat")
        expect(page.locator(".chat-input-bar")).to_be_visible()
        page.get_by_label("测试布局").select_option("graph")
        page.get_by_label("模拟剧情状态").select_option("empty")
        expect(graph.get_by_role("heading", name="当前会话未绑定剧情")).to_be_visible()
        assert not errors, errors
        assert not writes, writes
        print("Desktop shared canvas: drag at two zooms, reload positions, avatar, gray future, editor isolation and state transitions passed.")
        browser.close()


if __name__ == "__main__":
    run()
