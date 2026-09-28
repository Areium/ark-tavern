"""Dialogue attribution in real chat/stage components, with all APIs mocked (:5185)."""
import json
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
SESSION = {"id": "dialogue-qa", "name": "对话归属验收", "mode": "story", "characters": ["临光", "瑕光"],
           "player_identity": "博士", "narration_count": 1, "combat_mode": "narrative", "worldbook_ids": []}


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 960}, reduced_motion="reduce")
        errors, writes = [], []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

        def route_api(route):
            path = urlparse(route.request.url).path
            if route.request.method not in ("GET", "HEAD"):
                writes.append(path)
            if path.endswith("/avatar"):
                route.fulfill(content_type="image/svg+xml", body='<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#345"/></svg>')
                return
            if path == "/api/sessions":
                body = [SESSION]
            elif path == "/api/sessions/dialogue-qa":
                body = SESSION
            elif path.endswith("/stage"):
                body = {"session_id": SESSION["id"], "location": "桥头", "weather": "", "time": "夜晚",
                        "background": {"url": None}, "characters": [], "player": {"name": "博士", "skin_url": None}}
            elif path.endswith("/characters"):
                body = {"characters": SESSION["characters"], "character_colors": {}}
            elif path.endswith("/memories"):
                body = {"memories": [], "narration_count": 1}
            elif path.endswith("/config"):
                body = {"theme": "dark", "skin": "default"}
            else:
                body = {}
            route.fulfill(json=body)

        page.route("**/api/**", route_api)
        page.goto("http://127.0.0.1:5185")
        page.evaluate("""async session => {
          const {useAppStore} = await import('/src/stores/appStore.ts'); window.qaStore=useAppStore;
          useAppStore.setState({currentView:'chat',chatMode:'story',activeSessionId:session.id,sessions:[session],
            chatLayout:'log',dialogueBubbleMode:true,scenePanelOpen:false,
            sessionMessages:{[session.id]:[{role:'narrator',content:'验收准备',round:0}]},sessionNarrationCount:{[session.id]:1}});
        }""", SESSION)
        expect(page.get_by_text("验收准备", exact=True)).to_be_visible()

        def message(value, layout="log"):
            page.evaluate("""({value,layout}) => qaStore.setState({chatLayout:layout,
              sessionMessages:{'dialogue-qa':[value]}})""", {"value": value, "layout": layout})

        for width, height in [(1440, 960), (390, 844)]:
            page.set_viewport_size({"width": width, "height": height})
            message({"role": "narrator", "round": 1, "content": "临光对瑕光说：「跟上。」门开了。「是谁？」"})
            expect(page.locator(".dlg-bubble")).to_have_count(2)
            expect(page.locator(".dlg-name")).to_have_text(["临光"])
            expect(page.locator(".dlg-bubble").nth(1)).to_contain_text("是谁？")
            message({"role": "narrator", "round": 2, "content": "「出发」「未知」", "dialogueSegments": [
                {"type": "dialogue", "text": "出发", "speaker": "临光"},
                {"type": "dialogue", "text": "未知", "speaker": None}]})
            expect(page.locator(".dlg-name")).to_have_text(["临光"])
            message({"role": "character", "character": "临光", "round": 3, "content": "「未知说话人」",
                     "dialogueSegments": [{"type": "dialogue", "text": "未知说话人", "speaker": None}]}, "stage")
            expect(page.locator(".stage-dialog-text")).to_contain_text("未知说话人")
            expect(page.locator(".stage-name")).to_have_count(0)
            assert page.evaluate("qaStore.getState().highlightedSpeaker") is None
            message({"role": "character", "character": "临光", "round": 4, "content": "瑕光：「明确署名」"}, "stage")
            expect(page.locator(".stage-name")).to_contain_text("瑕光")
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            shots = ROOT / ".impeccable" / "review"
            shots.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(shots / f"dialogue-{width}.png"), full_page=True)
        assert not errors, errors
        assert not writes, writes
        browser.close()
    print(json.dumps({"viewports": [1440, 390], "errors": errors, "writes": writes}))
    print("PASS: chat/stage attribution, explicit unknown and message-default override")


if __name__ == "__main__":
    run()
