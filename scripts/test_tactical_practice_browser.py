"""Grid practice UI against real Flask combat routes and disposable local data."""

import json
import re
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

from flask import Flask
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

import combat_resume
import data_paths
from blueprints import combat as combat_bp
from combat_session import CombatTestSessionManager
from test_tactical_practice import _book


def run():
    screenshots = "--functional-only" not in sys.argv
    shots = ROOT / ".impeccable/review"
    shots.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="grid-practice-qa-") as temp, sync_playwright() as p:
        data_paths.PROJECT_ROOT = Path(temp)
        combat_resume.TEST_RESUME_DIR = Path(temp) / "resumes"
        app = Flask(__name__)
        app.config["TESTING"] = True
        combat_bp.register(app, {"session": SimpleNamespace(get_session=lambda _: None),
                                 "document": None, "combat_test": CombatTestSessionManager()})
        client = app.test_client()
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 960}, reduced_motion="reduce")
        errors, requests, starts, failed_requests = [], [], [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: errors.append(f"{message.text} {message.location}") if message.type == "error" else None)
        page.on("requestfailed", lambda request: failed_requests.append([request.url, request.failure]))
        page.add_init_script("""const realFetch = window.fetch;
          window.fetch = async (...args) => {
            const response = await realFetch(...args);
            if (window.qaHoldStart && String(args[0]).endsWith('/api/combat/test/start')) {
              await new Promise(resolve => { window.qaReleaseStart = resolve; });
            }
            return response;
          };
        """)
        fail_catalog = False

        def route_api(route):
            nonlocal fail_catalog
            req = route.request
            url = urlsplit(req.url)
            path = url.path
            requests.append(path + ("?" + url.query if url.query else ""))
            if path.endswith("/events"):
                route.fulfill(content_type="text/event-stream", body='data: {"type":"done","data":{}}\n\n')
                return
            if path == "/api/combat/practice" and fail_catalog:
                # Exercise application errors without expected HTTP-console noise.
                route.fulfill(json={"error": "合成演练目录读取失败"}, status=503)
                return
            if path.startswith("/api/combat/practice") or path.startswith("/api/combat/test/"):
                if path == "/api/combat/test/start":
                    starts.append(req.post_data_json)
                result = client.open(path + ("?" + url.query if url.query else ""), method=req.method,
                                     data=req.post_data, content_type="application/json")
                route.fulfill(status=result.status_code, body=result.data,
                              content_type=result.content_type)
                return
            if path in ("/api/sessions", "/api/characters", "/api/plots"):
                body = []
            elif path == "/api/worldbook":
                body = {"books": []}
            elif path.endswith("/config"):
                body = {"theme": "dark", "skin": "default"}
            elif path.endswith("spine-variants"):
                body = {"variants": {}}
            else:
                body = {}
            route.fulfill(json=body)

        page.route("**/api/**", route_api)
        page.goto("http://127.0.0.1:5192")

        def enter():
            page.evaluate("""async () => {
              const {useAppStore} = await import('/src/stores/appStore.ts');
              window.qaStore = useAppStore;
              useAppStore.setState({currentView:'sessions', activeSessionId:null, sessions:[], combatContext:null});
            }""")
            page.get_by_role("button", name="战斗演练", exact=True).click()
            page.get_by_role("button", name=re.compile("回合战术")).click()
            expect(page.get_by_role("heading", name="回合战术演练", exact=True)).to_be_visible()

        enter()
        start = page.get_by_role("button", name="开始回合战术演练", exact=True)
        expect(start).to_be_enabled()
        assert page.locator("#practice-source option").count() == 1
        assert page.get_by_role("checkbox", checked=True).count() == 4
        if screenshots:
            page.screenshot(path=str(shots / "grid-practice-desktop.png"), full_page=True)
        page.set_viewport_size({"width": 390, "height": 844})
        start.scroll_into_view_if_needed()
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        if screenshots:
            page.screenshot(path=str(shots / "grid-practice-mobile.png"), full_page=True)
        start.click()
        expect(page.get_by_role("button", name=re.compile("结束回合"))).to_be_visible()
        assert starts[-1]["practice_source"] == "builtin"
        assert set(starts[-1]["characters"]) == {"近卫训练员", "狙击训练员", "医疗训练员", "重装训练员"}
        page.set_viewport_size({"width": 1440, "height": 960})
        page.get_by_role("button", name=re.compile("结束回合")).click()
        expect(page.get_by_role("button", name=re.compile("结束回合"))).to_be_enabled()
        if screenshots:
            page.screenshot(path=str(shots / "grid-practice-battle.png"), full_page=True)
        assert not [path for path in requests if "训练员/avatar" in path or "spine-variants" in path]
        # Each book has the same node ID, but a distinct roster. A switch clears selection.
        _book(Path(temp), "first", character="First")
        _book(Path(temp), "second", hp=155, character="Second")
        empty = Path(temp) / "data/worldbooks/books/empty"
        empty.mkdir(parents=True)
        (empty / "book.json").write_text(json.dumps({"id": "empty", "enabled": True}), encoding="utf-8")
        enter()
        page.locator("#practice-source").select_option("first")
        expect(page.get_by_role("checkbox", name="First", exact=True)).to_be_visible()
        expect(start).to_be_disabled()
        page.get_by_role("checkbox", name="First", exact=True).check()
        expect(start).to_be_enabled()
        page.locator("#practice-source").select_option("second")
        expect(page.get_by_role("checkbox", name="Second", exact=True)).to_be_visible()
        expect(page.get_by_role("checkbox", name="First", exact=True)).to_have_count(0)
        expect(start).to_be_disabled()
        page.get_by_role("checkbox", name="Second", exact=True).check()
        start.click()
        expect(page.get_by_role("button", name=re.compile("结束回合"))).to_be_visible()
        assert starts[-1]["worldbook_id"] == "second"
        assert starts[-1]["characters"] == ["Second"]
        enter()
        page.locator("#practice-source").select_option("empty")
        expect(page.get_by_text(re.compile("当前内容没有可用战斗节点"))).to_be_visible()
        expect(start).to_be_disabled()
        page.locator("#practice-source").select_option("")
        expect(start).to_be_enabled()
        fail_catalog = True
        page.locator("#practice-source").select_option("first")
        expect(page.get_by_role("alert")).to_contain_text("合成演练目录读取失败")
        expect(start).to_be_disabled()
        fail_catalog = False
        page.get_by_role("button", name="重试", exact=True).click()
        expect(page.get_by_role("checkbox", name="First", exact=True)).to_be_visible()
        expect(page.get_by_role("alert")).to_have_count(0)
        # A response arriving after leaving must clean up only its own test instance.
        page.locator("#practice-source").select_option("")
        expect(start).to_be_enabled()
        page.evaluate("window.qaHoldStart = true")
        start.click()
        page.wait_for_function("typeof window.qaReleaseStart === 'function'")
        page.get_by_role("button", name="返回会话大厅", exact=True).click()
        page.evaluate("""() => {
          qaStore.getState().setCombatContext({sessionId:'new-real-session', testId:null, practiceMode:null, state:null});
          window.qaExpectedContext = qaStore.getState().combatContext;
        }""")
        with page.expect_response(lambda response: response.request.method == "DELETE"
                                  and "/api/combat/test/" in response.url) as deleted:
            page.evaluate("window.qaReleaseStart()")
        assert deleted.value.status == 200
        deleted_id = deleted.value.url.rsplit("/", 1)[-1]
        assert client.get(f"/api/combat/test/{deleted_id}/state").status_code == 404
        assert page.evaluate("qaStore.getState().combatContext === qaExpectedContext")
        expect(page.get_by_role("button", name="战斗演练", exact=True)).to_be_visible()
        assert page.evaluate("qaStore.getState().combatContext.sessionId") == "new-real-session"
        unexpected = [error for error in errors if "503 (Service Unavailable)" not in error]
        assert not unexpected, {"console": unexpected, "failed_requests": failed_requests}
        print(json.dumps({"pass": True, "viewports": [1440, 390], "real_combat_starts": len(starts),
                          "unexpected_console_errors": unexpected, "screenshots": str(shots) if screenshots else None}, ensure_ascii=False))
        browser.close()


if __name__ == "__main__":
    run()
