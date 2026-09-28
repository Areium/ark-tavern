"""Sideview browser regression; all APIs mocked, no story data touched.

Run with Vite web on :5185. --baseline records the pre-change measurements.
"""
import argparse
import json
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / ".impeccable" / "review"
SAVE_KEY = "ark_sideview_practice_v1"


def run(baseline=False):
    SHOTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 960}, has_touch=True)
        errors, writes, console_errors = [], [], []
        launch = None
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.add_init_script("""window.qaDraws = 0;
          for (const type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
            if (!type) continue;
            const draw = type.prototype.drawElements;
            type.prototype.drawElements = function(...args) { window.qaDraws++; return draw.apply(this, args); };
          }
        """)

        def route_api(route):
            path = urlparse(route.request.url).path
            if route.request.method not in ("GET", "HEAD"):
                writes.append(path)
            if path == "/api/sessions/sideview-qa/sideview/state":
                body = {"state": launch}
            elif path.endswith("/config"):
                body = {"theme": "dark", "skin": "default"}
            elif path in ("/api/sessions", "/api/characters", "/api/plots", "/api/combat/test/suspended"):
                body = []
            elif path == "/api/worldbooks":
                body = {"books": []}
            else:
                body = {}
            route.fulfill(json=body)

        page.route("**/api/**", route_api)
        page.goto("http://127.0.0.1:5185")
        page.evaluate("""async () => {
          const {useAppStore} = await import('/src/stores/appStore.ts');
          window.qaStore = useAppStore;
          useAppStore.setState({currentView:'combat', combatContext:{practiceMode:'sideview'}});
        }""")
        start = page.get_by_role("button", name="开始行动", exact=True)
        expect(start).to_be_visible()
        if not baseline:
            expect(page.locator(".sideview-battle")).to_be_focused()
        page.wait_for_function("!document.querySelector('.sv-asset-status')?.textContent.includes('正在装载')")
        page.wait_for_timeout(200)
        before = page.evaluate("qaDraws")
        page.wait_for_timeout(750)
        idle_draws = page.evaluate("qaDraws") - before
        tag = "before" if baseline else "after"
        page.screenshot(path=str(SHOTS / f"sideview-{tag}-desktop-ready.png"))
        start.click()
        page.keyboard.down("KeyD")
        page.wait_for_timeout(160)
        page.keyboard.up("KeyD")
        page.keyboard.press("Space")
        page.wait_for_timeout(120)
        page.keyboard.press("KeyK")
        page.screenshot(path=str(SHOTS / f"sideview-{tag}-desktop-action.png"))
        page.keyboard.press("Escape")
        expect(page.get_by_role("heading", name="行动已暂停")).to_be_visible()
        paused = page.evaluate("key => JSON.parse(localStorage.getItem(key)).snapshot", SAVE_KEY)
        before = page.evaluate("qaDraws")
        page.wait_for_timeout(750)
        paused_draws = page.evaluate("qaDraws") - before
        metrics = {"idle_draws_750ms": idle_draws, "paused_draws_750ms": paused_draws}
        for width, height, name in [(390, 844, "portrait"), (844, 390, "landscape")]:
            page.set_viewport_size({"width": width, "height": height})
            page.screenshot(path=str(SHOTS / f"sideview-{tag}-{name}.png"))
            metrics[f"{name}_controls_bottom"] = page.locator(".sv-controls").bounding_box()["y"] + page.locator(".sv-controls").bounding_box()["height"]
            metrics[f"{name}_viewport_height"] = height
            if not baseline:
                assert metrics[f"{name}_controls_bottom"] <= height, metrics
                assert page.locator(".sideview-battle").evaluate("e => e.scrollWidth <= e.clientWidth"), name
        if not baseline:
            assert idle_draws == 0 and paused_draws == 0, metrics
            assert paused["player"]["x"] > 110, paused
            # Remount through the real application route with a synthetic local save.
            def mount(snapshot):
                page.evaluate("qaStore.setState({currentView:'home'})")
                expect(page.locator(".sideview-battle")).not_to_be_visible()
                page.evaluate("""({key,snapshot}) => {
                  localStorage.setItem(key, JSON.stringify({runId:'browser-qa',levelId:'outskirts-01',snapshot}));
                  qaStore.setState({currentView:'combat',combatContext:{practiceMode:'sideview'}});
                }""", {"key": SAVE_KEY, "snapshot": snapshot})
                expect(page.locator(".sv-primary")).to_be_visible()

            def snapshot():
                return page.evaluate("key => JSON.parse(localStorage.getItem(key)).snapshot", SAVE_KEY)

            fresh = {**paused, "elapsedMs": 0, "player": {"x": 110, "y": 492, "hp": 120, "facing": 1},
                     "cooldowns": {"skill": 0, "dash": 0, "support": 0}}
            mount(fresh)
            page.locator(".sv-primary").click()
            # Two physical right keys: releasing one must not stop the other.
            page.keyboard.down("KeyD")
            page.keyboard.down("ArrowRight")
            page.wait_for_timeout(70)
            page.keyboard.up("KeyD")
            page.wait_for_timeout(220)
            page.keyboard.up("ArrowRight")
            page.keyboard.press("Escape")
            assert snapshot()["player"]["x"] > 165, snapshot()
            # Pause clears held inputs and does not advance the simulation clock.
            page.locator(".sv-primary").click()
            page.keyboard.down("KeyD")
            page.wait_for_timeout(60)
            page.keyboard.press("Escape")
            held = snapshot()
            page.locator(".sv-primary").click()
            page.wait_for_timeout(180)
            page.keyboard.up("KeyD")
            page.keyboard.press("Escape")
            # Existing ground friction permits <12px of coasting from full speed;
            # a stuck right input would travel >50px over this interval.
            assert 0 <= snapshot()["player"]["x"] - held["player"]["x"] < 12, (held, snapshot())

            # Real multi-touch protocol: movement + jump, independent touch release.
            page.set_viewport_size({"width": 390, "height": 844})
            mount(fresh)
            page.locator(".sv-primary").click()
            cdp = page.context.new_cdp_session(page)
            def point(label, pointer_id):
                box = page.get_by_role("button", name=label, exact=True).bounding_box()
                return {"id": pointer_id, "x": box["x"] + box["width"] / 2, "y": box["y"] + box["height"] / 2}
            right, jump = point("向右移动", 1), point("跳跃", 2)
            cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [right]})
            page.wait_for_timeout(60)
            cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [right, jump]})
            page.wait_for_timeout(80)
            cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": [right]})
            page.wait_for_timeout(180)
            cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
            page.get_by_role("button", name="暂停行动", exact=True).click()
            touched = snapshot()
            assert touched["player"]["x"] > 170 and touched["player"]["y"] < 490, touched
            cdp.detach()

            # A keyboard-activated cooldown button stays focused and receives keyup.
            mount(fresh)
            page.locator(".sv-primary").click()
            skill = page.locator(".sv-abilities .sv-skill")
            skill.focus()
            page.keyboard.down("Enter")
            page.wait_for_timeout(180)
            expect(skill).to_be_focused()
            expect(skill).to_have_attribute("aria-disabled", "true")
            page.keyboard.up("Enter")
            page.wait_for_timeout(6200)
            expect(skill).to_have_attribute("aria-disabled", "false")
            page.keyboard.press("Escape")
            assert snapshot()["cooldowns"]["skill"] == 0, snapshot()
            # Opening an abandon prompt then pressing Escape cancels, never resumes.
            page.get_by_role("button", name="放弃演练", exact=True).click()
            page.keyboard.press("Escape")
            expect(page.get_by_role("heading", name="行动已暂停")).to_be_visible()
            expect(page.get_by_role("button", name="确认放弃", exact=True)).not_to_be_visible()
            page.get_by_role("button", name="查看操作说明", exact=True).click()
            expect(page.get_by_role("region", name="操作与战术说明")).to_be_visible()

            # Pad Start is scoped to focus; held controls must release after resume.
            page.evaluate("""() => {
              window.qaPad = {connected:true,mapping:'standard',axes:[0],buttons:Array.from({length:16},()=>({pressed:false}))};
              Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[qaPad]});
              document.activeElement.blur(); qaPad.buttons[9].pressed=true;
            }""")
            page.wait_for_timeout(120)
            expect(page.get_by_role("heading", name="行动已暂停")).to_be_visible()
            page.evaluate("qaPad.buttons[9].pressed=false")
            page.wait_for_timeout(40)
            page.locator(".sv-primary").focus()
            page.evaluate("qaPad.buttons[9].pressed=true")
            expect(page.get_by_role("heading", name="行动已暂停")).not_to_be_visible()
            page.evaluate("qaPad.buttons[9].pressed=false; window.dispatchEvent(new Event('blur'))")
            expect(page.get_by_role("heading", name="行动已暂停")).to_be_visible()
            page.evaluate("Object.defineProperty(navigator,'getGamepads',{value:()=>[]})")

            # Saving exits to the hall; re-entry restores exact progress and cooldowns.
            saved = snapshot()
            page.locator(".sv-brief .sv-exit").first.click()
            expect(page.locator(".sideview-battle")).not_to_be_visible()
            page.evaluate("qaStore.setState({currentView:'combat',combatContext:{practiceMode:'sideview'}})")
            expect(page.locator(".sv-primary")).to_have_text("继续行动")
            assert snapshot() == saved
            # Late-level restored saves start at the player, show the elite HUD.
            late = {**fresh, "player": {"x": 2800, "y": 492, "hp": 120, "facing": 1}}
            mount(late)
            page.locator(".sv-primary").click()
            expect(page.locator(".sv-elite")).to_be_visible()
            page.keyboard.press("Escape")
            # Complete a legal all-enemies-defeated save at the exit.
            finish = {**fresh, "player": {"x": 3210, "y": 492, "hp": 120, "facing": 1},
                      "enemies": [{**enemy, "hp": 0} for enemy in fresh["enemies"]]}
            mount(finish)
            page.locator(".sv-primary").click()
            page.keyboard.down("KeyD")
            expect(page.get_by_role("heading", name="演练完成", exact=True)).to_be_visible()
            page.keyboard.up("KeyD")
            assert page.evaluate("key => localStorage.getItem(key)", SAVE_KEY) is None
            assert not writes, writes
            # Real session wrapper: pending suspended save must lock resume/exit.
            launch = page.evaluate("""async snapshot => {
              const {DEMO_LEVEL,DEMO_OPERATOR} = await import('/src/features/sideview/level.ts');
              return {engine:'sideview',runId:'session-browser-qa',level:DEMO_LEVEL,operator:DEMO_OPERATOR,status:'active',snapshot};
            }""", fresh)
            page.evaluate("""() => {
              const original = window.fetch;
              window.fetch = async (url, options) => {
                if (String(url).endsWith('/sideview/save')) {
                  window.qaSaveStarted = true;
                  await new Promise(resolve => window.qaSaveResolve = resolve);
                }
                return original(url, options);
              };
              qaStore.setState({currentView:'home'});
            }""")
            page.emulate_media(reduced_motion="reduce")
            page.evaluate("""() => qaStore.setState({currentView:'combat',
              sessions:[{id:'sideview-qa',name:'合成横版会话',mode:'story',combat_mode:'sideview',characters:[],worldbook_ids:[]}],
              combatContext:{sessionId:'sideview-qa',practiceMode:null}})""")
            expect(page.locator(".sv-primary")).to_be_visible()
            page.get_by_role("button", name="保存并离开", exact=True).first.click()
            page.wait_for_function("window.qaSaveStarted")
            expect(page.locator(".sv-primary")).to_be_disabled()
            page.keyboard.press("Escape")
            expect(page.get_by_role("heading", name="行动已暂停")).to_be_visible()
            assert page.locator(".sideview-battle").evaluate("el => getComputedStyle(el.querySelector('button')).transitionDuration") == "0s"
            page.evaluate("qaSaveResolve()")
            expect(page.locator(".sideview-battle")).not_to_be_visible()
            assert writes == ["/api/sessions/sideview-qa/sideview/save"], writes
        assert not errors, errors
        assert not console_errors, console_errors
        if baseline:
            assert not writes, writes
        browser.close()
    print(json.dumps(metrics, ensure_ascii=False))
    print("PASS: synthetic sideview input, touch, focus, save/re-entry, completion and delayed session save; APIs fully mocked, no page/console errors")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", action="store_true")
    run(parser.parse_args().baseline)
