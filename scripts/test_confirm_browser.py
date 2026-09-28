"""Isolated browser QA. Requires Vite web on :5182; all API calls are synthetic."""
import re
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / ".impeccable" / "review"
SESSION = {"id": "confirm-qa", "name": "删除确认验收 · 合成存档", "mode": "story",
           "characters": [], "player_identity": "玩家", "narration_count": 0,
           "combat_mode": "narrative", "worldbook_ids": [], "in_combat": False, "created_at": 1}


def run():
    SHOTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 960}, reduced_motion="reduce")
        errors, native, deleted = [], [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("dialog", lambda dialog: (native.append(dialog.message), dialog.dismiss()))

        def route_api(route):
            path = urlparse(route.request.url).path
            if route.request.method == "DELETE":
                deleted.append(path)
                body = {"ok": True}
            elif path == "/api/sessions":
                body = [] if deleted else [SESSION]
            elif path == "/api/sessions/confirm-qa":
                body = SESSION
            elif path in ("/api/plots", "/api/characters", "/api/combat/test/suspended"):
                body = []
            elif path == "/api/worldbooks":
                body = {"books": []}
            elif path.endswith("/config"):
                body = {"theme": "dark", "skin": "default"}
            elif path.endswith("/memories"):
                body = {"memories": [], "narration_count": 0}
            elif path.endswith("/messages"):
                body = {"messages": []}
            else:
                body = {}
            route.fulfill(json=body)

        page.route("**/api/**", route_api)
        page.goto("http://127.0.0.1:5182")
        page.evaluate("""async session => {
          const {useAppStore} = await import('/src/stores/appStore.ts');
          window.qaStore = useAppStore;
          useAppStore.setState({currentView:'sessions', activeSessionId:session.id, sessions:[session], chatMode:'story'});
        }""", SESSION)
        delete_button = page.get_by_role("button", name=re.compile("删除会话"))
        delete_button.click()
        dialog = page.get_by_role("dialog", name="删除会话")
        expect(dialog).to_be_visible()
        expect(dialog.get_by_role("button", name="取消", exact=True)).to_be_focused()
        page.screenshot(path=str(SHOTS / "confirm-desktop.png"), full_page=True)
        page.keyboard.press("Shift+Tab")
        assert dialog.evaluate("el => el.contains(document.activeElement)")
        page.keyboard.press("Tab")
        assert dialog.evaluate("el => el.contains(document.activeElement)")
        page.keyboard.press("Escape")
        expect(dialog).not_to_be_visible()
        expect(delete_button).to_be_focused()
        assert not deleted, deleted

        page.set_viewport_size({"width": 390, "height": 844})
        delete_button.click()
        page.screenshot(path=str(SHOTS / "confirm-mobile.png"), full_page=True)
        box = dialog.bounding_box()
        assert box and box["x"] >= 0 and box["x"] + box["width"] <= 390
        dialog.get_by_role("button", name="取消", exact=True).click()
        assert not deleted
        delete_button.click()
        dialog.get_by_role("button", name="删除会话", exact=True).click()
        expect(dialog).not_to_be_visible()
        assert deleted == ["/api/sessions/confirm-qa"], deleted

        # A context change must not leave a stale destructive action waiting to execute.
        page.evaluate("""async () => {
          const {confirmAction} = await import('/src/stores/confirmStore.ts');
          window.qaConfirmation = null;
          confirmAction('切换页面后应自动取消', {title:'切换保护'}).then(v => window.qaConfirmation = v);
        }""")
        expect(page.get_by_role("dialog", name="切换保护")).to_be_visible()
        page.evaluate("qaStore.getState().setCurrentView('home')")
        page.wait_for_function("window.qaConfirmation === false")
        assert not native, native
        assert not errors, errors
        browser.close()
    print("PASS: real session deletion flow, safe focus, Tab trap, Escape, cancel/confirm, mobile, context cancellation; all APIs mocked")


if __name__ == "__main__":
    run()
