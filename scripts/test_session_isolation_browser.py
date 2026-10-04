"""Deterministic session/portrait regressions; all API calls are synthetic.

Start isolated Vite with vite.config.shot.ts on :5193; no user saves or LLM calls.
"""
import argparse
import json
import os
import re
from io import BytesIO
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from PIL import Image
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("SESSION_ISOLATION_URL", "http://127.0.0.1:5193")
SESSIONS = [
    {"id": "combat-a", "name": "战斗功能测试", "combat_mode": "tactical"},
    {"id": "story-b", "name": "彼岸双生", "combat_mode": "narrative"},
]
for session in SESSIONS:
    session.update(mode="story", characters=["妮可"], roster=["程叙", "妮可"],
                   player_identity="程叙", narration_count=0, in_combat=False,
                   worldbook_ids=["beyond-twin"], created_at=1)


def run(baseline=False):
    report = {}
    image = BytesIO()
    Image.new("RGB", (32, 32), (120, 90, 180)).save(image, format="PNG")
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 960}, reduced_motion="reduce")
        errors, unexpected_console, avatar_requests = [], [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: unexpected_console.append(message.text)
                if message.type == "error" and "404" not in message.text else None)

        def api_route(route):
            parsed = urlparse(route.request.url)
            path, query = parsed.path, parse_qs(parsed.query)
            if path.endswith("/avatar"):
                avatar_requests.append(query)
                if query.get("session_id") == ["portrait-missing"]:
                    route.fulfill(status=404, body="missing scoped portrait")
                elif query.get("session_id") == ["portrait-refresh"] and query.get("v") == ["0"]:
                    route.fulfill(status=404, body="not uploaded yet")
                else:
                    route.fulfill(content_type="image/png", body=image.getvalue())
                return
            if path == "/api/sessions":
                body = SESSIONS
            elif path in ("/api/plots", "/api/characters", "/api/combat/test/suspended"):
                body = []
            elif path == "/api/worldbook":
                body = {"books": []}
            elif path.endswith("/config"):
                body = {"theme": "dark", "skin": "default"}
            elif path.endswith("/characters"):
                body = {"characters": ["妮可"], "roster": ["程叙", "妮可"], "active": "妮可"}
            elif path.endswith("/character-stats"):
                body = {"characters": [], "fields": []}
            elif path.endswith("/worldbook-dependencies"):
                body = {"entries": [], "effective_requires_edges": [], "effective_related_edges": [],
                        "suppressed_edges": [], "resolved_entry_uids": [], "book_name": "彼岸双生"}
            elif path.endswith("/memories"):
                body = {"memories": [], "narration_count": 0}
            elif path.endswith("/messages"):
                body = {"messages": []}
            elif path.endswith("/stage"):
                body = {"characters": [], "player": {"name": "程叙"}, "background": {"url": None}}
            elif path.rsplit("/", 1)[-1] in ("combat-a", "story-b"):
                body = next(s for s in SESSIONS if s["id"] == path.rsplit("/", 1)[-1])
            else:
                body = {}
            route.fulfill(json=body)

        page.route("**/api/**", api_route)
        page.add_init_script("""window.qaStreams = {}; window.qaNarrations = []; window.qaRequests = [];
          window.qaDelayRoster=false; window.qaRosters=[]; window.qaHoldSession=false; window.qaSessionReads=[];
          const originalFetch = window.fetch;
          window.fetch = async (input, init) => {
            const url = new URL(typeof input === 'string' ? input : input.url, location.href);
            if (qaDelayRoster && url.pathname === '/api/sessions/combat-a/characters') {
              return new Promise(resolve => qaRosters.push(body => resolve(new Response(JSON.stringify(body)))));
            }
            if (qaHoldSession && url.pathname === '/api/sessions/combat-a') {
              return new Promise(resolve => qaSessionReads.push(body => resolve(new Response(JSON.stringify(body)))));
            }
            if (url.pathname.endsWith('/combat/start') || url.pathname.endsWith('/resume')) {
              return new Promise(resolve => qaRequests.push({path:url.pathname,
                resolve(body, status=200) {resolve(new Response(JSON.stringify(body), {status}));}}));
            }
            if (url.pathname.endsWith('/narrate')) {
              const sid = url.pathname.split('/')[3];
              qaNarrations.push(sid);
              return new Response(new ReadableStream({start(controller) {
                qaStreams[sid] = {emit(type, data) {
                  controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type,data})+'\\n\\n'));
                }, close() {controller.close();}};
              }}), {headers:{'Content-Type':'text/event-stream'}});
            }
            return originalFetch(input, init);
          };""")
        page.goto(BASE)
        page.evaluate(r"""async () => {
          // Follow Vite's current HMR URL instead of creating a second, stale store module.
          const appSource = await (await fetch('/src/App.tsx')).text();
          const storeUrl = appSource.match(/from ["']([^"']*stores\/appStore\.ts[^"']*)["']/)[1];
          const {useAppStore} = await import(storeUrl);
          window.qaStore = useAppStore;
          const {default: React} = await import('/node_modules/.vite-shot/deps/react.js');
          const {default: ReactDOM} = await import('/node_modules/.vite-shot/deps/react-dom_client.js');
          const {default: Avatar} = await import('/src/components/chat/AvatarPlaceholder.tsx');
          const host = document.createElement('div'); host.id='qa-portrait';
          host.style='position:fixed;top:0;left:0;z-index:9999'; document.body.append(host);
          const root = ReactDOM.createRoot(host);
          window.qaPortrait = sid => root.render(React.createElement(Avatar,{name:'妮可',sessionId:sid}));
          window.qaUnmountPortrait = () => { root.unmount(); host.remove(); };
          qaPortrait('portrait-missing');
        }""")
        page.wait_for_timeout(300)
        report["no_unscoped_avatar_fallback"] = not any("session_id" not in q for q in avatar_requests)
        page.evaluate("qaPortrait('portrait-refresh')")
        page.wait_for_timeout(300)
        before = len(avatar_requests)
        page.evaluate("qaStore.getState().bumpResourceVersion()")
        page.wait_for_timeout(300)
        report["failed_avatar_retries_on_resource_change"] = any(
            q.get("session_id") == ["portrait-refresh"] and q.get("v") == ["1"]
            for q in avatar_requests[before:])
        page.evaluate("qaPortrait('story-b')")
        page.wait_for_function("document.querySelector('#qa-portrait img')?.naturalWidth === 32")
        page.evaluate("qaUnmountPortrait()")

        page.evaluate("""sessions => {
          qaStore.setState({sessions, chatMode:'story', currentView:'chat', activeSessionId:'combat-a',
            sessionMessages:{'story-b':[{role:'narrator',content:'妮可在窗边等待。',round:1}]}});
        }""", SESSIONS)
        try:
            page.wait_for_function("!!qaStreams['combat-a']", timeout=10000)
        except Exception:
            print(json.dumps({"errors": errors, "console": unexpected_console,
                              "state": page.evaluate("({view:qaStore.getState().currentView,active:qaStore.getState().activeSessionId,messages:qaStore.getState().sessionMessages})")}, ensure_ascii=False))
            raise
        page.get_by_role("button", name="返回大厅", exact=True).click()
        page.evaluate("qaStore.getState().setActiveSession('story-b'); qaStore.getState().setCurrentView('chat')")
        try:
            expect(page.locator(".chat-topbar-title")).to_have_text("彼岸双生")
        except Exception:
            print(json.dumps({"errors": errors, "console": unexpected_console}, ensure_ascii=False))
            raise
        page.evaluate("""qaStreams['combat-a'].emit('combat_briefing', {
          session_id:'combat-a',encounter_id:'gate',name:'旧会话战斗',
          approaches:[{id:'fight',label:'正面迎战',hint:'测试选项',kind:'combat'}]});""")
        page.wait_for_timeout(250)
        report["late_briefing_does_not_leak"] = page.get_by_text("⚔ 旧会话战斗", exact=True).count() == 0
        report["new_session_not_locked"] = page.locator(".chat-lock-note").count() == 0
        page.evaluate("qaStore.getState().setActiveSession('combat-a')")
        page.wait_for_timeout(200)
        report["owner_briefing_preserved"] = page.get_by_text("⚔ 旧会话战斗", exact=True).is_visible()
        page.screenshot(path=str(ROOT / ".tmp" / "session-isolation-desktop.png"))
        page.set_viewport_size({"width": 390, "height": 844})
        page.screenshot(path=str(ROOT / ".tmp" / "session-isolation-mobile.png"))
        report["mobile_no_horizontal_overflow"] = page.evaluate(
            "document.documentElement.scrollWidth <= innerWidth")
        if not baseline:
            page.set_viewport_size({"width": 1440, "height": 960})
            # Minimizing A must not leave a globally actionable dock entry in B or the lobby.
            page.get_by_role("button", name="最小化对话框", exact=True).click()
            expect(page.get_by_role("button", name=re.compile("展开战斗选项"))).to_be_visible()
            page.get_by_role("button", name="返回大厅", exact=True).click()
            expect(page.get_by_role("button", name=re.compile("展开战斗选项"))).to_have_count(0)
            page.evaluate("qaStore.getState().setActiveSession('story-b'); qaStore.getState().setCurrentView('chat')")
            report["minimized_dock_is_scoped"] = page.get_by_role("button", name=re.compile("展开战斗选项")).count() == 0

            # B's own briefing must survive A's delayed responses (check, avoid, state, error).
            page.evaluate("""window.qaBriefing = sid => ({session_id:sid,encounter_id:'gate',name:sid+' 战斗',
              approaches:[{id:'fight',label:'正面迎战',hint:'测试选项',kind:'combat'}]});
              qaStore.getState().setPendingBriefing('story-b',qaBriefing('story-b'));""")
            for kind in ("check", "avoid", "state", "error"):
                page.evaluate("""() => {
                  qaStore.getState().setPendingBriefing('combat-a',qaBriefing('combat-a'));
                  qaStore.getState().setActiveSession('combat-a');
                }""")
                expect(page.get_by_role("button", name="正面迎战 测试选项")).to_be_visible()
                count = page.evaluate("qaRequests.length")
                page.get_by_role("button", name="正面迎战 测试选项").click()
                page.wait_for_function("count => qaRequests.length > count", arg=count)
                expect(page.get_by_role("button", name="正面迎战 测试选项")).to_be_disabled()
                page.evaluate("qaStore.getState().setActiveSession('story-b')")
                check = {"d20": 10, "modifier": 2, "total": 12, "dc": 15, "success": False, "attr": "魅力", "character": "A角色"}
                payload = {"check": {"kind": "check", "check": check},
                           "avoid": {"kind": "avoid", "label": "绕行"},
                           "state": {"state": {"phase": "PLAYER_TURN"}},
                           "error": {"error": "A专属测试失败"}}[kind]
                page.evaluate("([body,status]) => qaRequests.at(-1).resolve(body,status)", [payload, 400 if kind == "error" else 200])
                page.wait_for_timeout(150)
                report[f"late_{kind}_stays_scoped"] = page.evaluate("""() =>
                  qaStore.getState().currentView === 'chat' && qaStore.getState().activeSessionId === 'story-b'
                  && qaStore.getState().sessionBriefings['story-b']?.session_id === 'story-b'
                  && !qaNarrations.includes('story-b')""")
                assert not page.get_by_text("A专属测试失败", exact=False).count()
                if kind == "check":
                    page.evaluate("qaStore.getState().setActiveSession('combat-a')")
                    expect(page.get_by_text("❌ 失败 — 敌人警觉，被迫开战", exact=True)).to_be_visible()
                    page.evaluate("qaStore.getState().setActiveSession('story-b')")
                if kind == "avoid":
                    report["background_continuation_retained"] = page.evaluate(
                        "!!qaStore.getState().sessionAutoNarrate['combat-a'] && !qaStore.getState().sessionAutoNarrate['story-b']")
                    page.evaluate("qaStore.getState().setActiveSession('combat-a')")
                    page.wait_for_function("qaNarrations.filter(sid=>sid==='combat-a').length === 2")
                    report["continuation_consumed_by_owner_once"] = page.evaluate(
                        "!qaStore.getState().sessionAutoNarrate['combat-a'] && !qaNarrations.includes('story-b')")
                    page.evaluate("qaStore.getState().setActiveSession('story-b')")

            # Full A -> B -> A navigation while starting a battle must not hijack the page on return.
            page.evaluate("""qaStore.getState().setPendingBriefing('combat-a',qaBriefing('combat-a'));
              qaStore.getState().setActiveSession('combat-a');""")
            count = page.evaluate("qaRequests.length")
            page.get_by_role("button", name="正面迎战 测试选项").click()
            page.wait_for_function("count => qaRequests.length > count", arg=count)
            page.evaluate("qaStore.getState().setActiveSession('story-b'); qaStore.getState().setActiveSession('combat-a')")
            page.evaluate("qaRequests.at(-1).resolve({state:{phase:'PLAYER_TURN'}})")
            page.wait_for_timeout(150)
            report["roundtrip_navigation_invalidates_start"] = page.evaluate("qaStore.getState().currentView === 'chat'")

            # Delayed resume uses the same navigation generation, not a stale sessions closure.
            page.evaluate(r"""async () => {
              const {default: React} = await import('/node_modules/.vite-shot/deps/react.js');
              const {default: ReactDOM} = await import('/node_modules/.vite-shot/deps/react-dom_client.js');
              const source = await (await fetch('/src/components/ChatPanel.tsx')).text();
              const url = source.match(/from ["']([^"']*hooks\/useCombatResume\.ts[^"']*)["']/)[1];
              const {useCombatResume} = await import(url);
              function Harness() {window.qaResume=useCombatResume(); return null;}
              const host=document.createElement('div');document.body.append(host);
              window.qaResumeRoot=ReactDOM.createRoot(host);qaResumeRoot.render(React.createElement(Harness));
            }""")
            page.wait_for_function("!!window.qaResume")
            for target in ("session", "test"):
                count = page.evaluate("qaRequests.length")
                page.evaluate("""target => { window.qaResumeResult=null;
                  (target==='session' ? qaResume.resumeSession('combat-a') : qaResume.resumeTest('test-a'))
                    .then(result=>window.qaResumeResult=result); }""", target)
                page.wait_for_function("count => qaRequests.length > count", arg=count)
                page.evaluate("qaStore.getState().setCurrentView('sessions'); qaStore.getState().setCurrentView('chat')")
                page.evaluate("qaRequests.at(-1).resolve({state:{phase:'PLAYER_TURN'}})")
                page.wait_for_function("qaResumeResult !== null")
                report[f"late_{target}_resume_ignored"] = page.evaluate("qaResumeResult === false && qaStore.getState().currentView === 'chat'")
            page.evaluate("qaResumeRoot.unmount()")
            page.evaluate("""qaStore.getState().setPendingBriefing('story-b',null);
              qaStore.getState().setActiveSession('story-b');""")
            expect(page.locator(".scene-char-row").filter(has_text="妮可")).to_be_visible()
            page.evaluate("qaDelayRoster=true; qaStore.getState().setActiveSession('combat-a')")
            page.wait_for_function("qaRosters.length >= 2")
            page.evaluate("qaStore.getState().setActiveSession('story-b')")
            expect(page.locator(".scene-char-row").filter(has_text="妮可")).to_be_visible()
            page.evaluate("""qaDelayRoster=false; qaRosters.forEach(resolve => resolve({
              characters:['A迟到角色'],roster:['A迟到角色'],active:'A迟到角色'}));""")
            page.wait_for_timeout(150)
            report["late_roster_does_not_replace_portraits"] = page.locator(".scene-char-row").filter(has_text="A迟到角色").count() == 0
            count = page.evaluate("qaNarrations.length")
            page.evaluate("""qaStore.getState().clearSessionStream('combat-a');
              localStorage.removeItem('ark_chat_story_combat-a'); qaHoldSession=true;
              qaStore.getState().setActiveSession('combat-a');""")
            page.wait_for_function("qaSessionReads.length > 0")
            page.evaluate("qaStore.getState().setActiveSession('story-b')")
            page.evaluate("session => {qaHoldSession=false;qaSessionReads.forEach(resolve=>resolve(session));}", SESSIONS[0])
            page.wait_for_timeout(150)
            report["cancelled_initial_load_does_not_narrate"] = page.evaluate("qaNarrations.length") == count
        report["no_page_errors"] = not errors
        report["no_unexpected_console_errors"] = not unexpected_console
        print(json.dumps({**report, "page_errors": errors, "console_errors": unexpected_console}, ensure_ascii=False, indent=2))
        browser.close()
    if not baseline:
        assert all(report.values()), report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", action="store_true")
    args = parser.parse_args()
    (ROOT / ".tmp").mkdir(exist_ok=True)
    run(args.baseline)
