"""Management UI QA against synthetic API fixtures, never the user's content."""
import sys
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / ".impeccable" / "review"
LONG_NAME = "长夜归途与卡瓦莱利亚基的旧城区档案：一个需要完整阅读的世界书名称"
BOOKS = [dict(id="qa-long", name=LONG_NAME, enabled=True, entry_count=0, book_type="story"),
         dict(id="qa-short", name="雨港来信", enabled=True, entry_count=0, book_type="story")]
CHARACTERS = [dict(id="qa-one", name="档案管理员", worldbook_id="qa-long"),
              dict(id="qa-two", name="雨港信使", worldbook_id="qa-short")]


def run():
    SHOTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 960}, reduced_motion="reduce")
        errors, writes = [], []
        page.on("pageerror", lambda error: errors.append(str(error)))

        def api(route):
            path = urlparse(route.request.url).path
            if route.request.method not in ("GET", "HEAD") and not path.endswith("/scope-preview"):
                writes.append((route.request.method, path))
            if path == "/api/worldbook":
                body = {"books": BOOKS}
            elif path.startswith("/api/worldbook/qa-"):
                book = next((book for book in BOOKS if path.endswith(book["id"])), BOOKS[0])
                body = {**book, "description": "合成数据，仅用于界面验收。", "entries": [], "categories": [],
                        "entry_groups": [], "entry_layout": [], "entry_group_map": {}, "stat_fields": [],
                        "edit_revision": 1, "strategy": {}, "scope_mode": "full",
                        "dependency_rules": {"roots": []}, "dependency_edges": [], "related_edges": []}
            elif path == "/api/characters":
                body = CHARACTERS
            elif path in ("/api/player-identities", "/api/sessions", "/api/plots"):
                body = []
            elif path.endswith("/config"):
                body = {"theme": "dark", "skin": "default"}
            elif "/avatar" in path:
                route.fulfill(status=404, body="Synthetic fixture has no avatar")
                return
            else:
                body = {}
            route.fulfill(json=body)

        page.route("**/api/**", api)
        page.goto("http://127.0.0.1:5182")
        page.evaluate("""async () => {
          const {useAppStore} = await import('/src/stores/appStore.ts'); window.qaStore = useAppStore;
          useAppStore.setState({currentView:'characters', characterTab:'characters'});
        }""")
        groups = page.locator(".wb-source-groups")
        title = groups.locator(".wb-source-name", has_text=LONG_NAME)
        expect(title).to_be_visible()
        assert title.evaluate("el => parseFloat(getComputedStyle(el).fontSize)") >= 15
        page.screenshot(path=str(SHOTS / "groups-desktop.png"), full_page=True)
        selector = groups.locator(".wb-source-select", has_text=LONG_NAME)
        selector.click()
        expect(selector).to_have_attribute("aria-pressed", "true")
        expect(groups.get_by_text("档案管理员", exact=True)).to_be_visible()
        expect(groups.get_by_text("雨港信使", exact=True)).not_to_be_visible()
        groups.locator(".wb-source-all").click()
        expect(groups.get_by_text("雨港信使", exact=True)).to_be_visible()
        page.set_viewport_size({"width": 390, "height": 844})
        page.screenshot(path=str(SHOTS / "groups-mobile.png"), full_page=True)
        assert title.evaluate("el => el.scrollWidth <= el.clientWidth")
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        collapse = groups.get_by_role("button", name=f"折叠 {LONG_NAME}", exact=True)
        collapse.click()
        expect(groups.get_by_text("档案管理员", exact=True)).not_to_be_visible()
        groups.get_by_role("button", name=f"展开 {LONG_NAME}", exact=True).click()
        expect(groups.get_by_text("档案管理员", exact=True)).to_be_visible()

        if "--roles-only" not in sys.argv:
            page.set_viewport_size({"width": 1440, "height": 960})
            page.evaluate("qaStore.setState({currentView:'worldbook', worldbookTab:'entries'})")
            expect(page.get_by_role("heading", name=LONG_NAME, exact=True)).to_be_visible()
            for text in ("导入示例世界书", "文件夹位置与分享", "停用整书", "启用整书"):
                expect(page.get_by_text(text, exact=True)).to_have_count(0)
            expect(page.get_by_role("button", name="导入文件", exact=True)).to_be_visible()
            page.screenshot(path=str(SHOTS / "worldbook-desktop.png"), full_page=True)
            page.locator(".wber-more summary").click()
            expect(page.get_by_role("button", name="导出酒馆 JSON", exact=True)).to_be_visible()
            page.get_by_role("button", name="删除", exact=True).first.click()
            expect(page.get_by_role("dialog", name="删除世界书")).to_be_visible()
            page.get_by_role("dialog").get_by_role("button", name="取消", exact=True).click()
            page.set_viewport_size({"width": 390, "height": 844})
            page.screenshot(path=str(SHOTS / "worldbook-mobile.png"), full_page=True)
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        assert not writes, writes
        assert not errors, errors
        browser.close()
    print("PASS: readable source headings, long names, filter/collapse, desktop/mobile; management entry checks when enabled; no writes or page errors")


if __name__ == "__main__":
    run()
