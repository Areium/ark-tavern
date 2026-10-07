"""Stage integration QA: real HTTP SSE, fixture content, no user saves or LLM.

Start isolated Vite with vite.config.shot.ts on :5197 (use a private cacheDir).
Run: python scripts/test_stage_stream_browser.py
The fixture backend uses :5001; it refuses to replace an existing listener.
"""
import json
import os
import queue
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("STAGE_STREAM_URL", "http://127.0.0.1:5197")
OUT = ROOT / ".tmp" / "stage-stream-qa"
SESSION = {"id": "stream-qa", "name": "舞台阅读验收", "mode": "story", "characters": ["妮可"],
           "player_identity": "玩家", "narration_count": 1, "combat_mode": "narrative", "worldbook_ids": [], "in_combat": False}
RAW = "妮可说：「" + "".join(f"第{i}段的灯光落在窗边，她看着房间，仍然静静抱着猫玩偶。" for i in range(24)) + "」"


class Plan:
    def __init__(self):
        self.events = queue.Queue()
        self.started = threading.Event()

    def send(self, kind, data=None):
        self.events.put(None if kind == "EOF" else {"type": kind, "data": data or {}})


class Fixture(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if not urlparse(self.path).path.endswith("/rollback"):
            self.send_error(404)
            return
        self.server.rollback_started.set()
        if not self.server.rollback_gate.wait(10):
            self.send_error(500)
            return
        body = json.dumps({"narration_count":0}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path.endswith("/narrate"):
            plan = self.server.plan
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            plan.started.set()
            try:
                while True:
                    event = plan.events.get(timeout=30)
                    if event is None:
                        break
                    self.wfile.write(("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode())
                    self.wfile.flush()
                    if event["type"] in ("done", "error"):
                        break
            except (ConnectionError, queue.Empty):
                pass
            self.close_connection = True
        else:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()


def run():
    OUT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 5001), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    checks = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={"width": 1400, "height": 900})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            stage_requests = []
            resource_failure = False

            def api(route):
                path = urlparse(route.request.url).path
                if path.endswith("/narrate"):
                    route.continue_()
                    return
                if path.endswith("/rollback"):
                    route.continue_()
                    return
                if path.endswith("/avatar"):
                    route.fulfill(content_type="image/svg+xml", body='<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#746657"/></svg>')
                    return
                if path.endswith("/stage"):
                    stage_requests.append(route.request.url)
                    if resource_failure:
                        route.fulfill(status=503, json={"error": "fixture resource failure"})
                        return
                    body = {"session_id": SESSION["id"], "location": "房间", "weather": "晴", "time": "夜晚", "atmosphere": [],
                            "background": {"url": None, "source": "none", "bg_id": ""},
                            "characters": [{"name": "妮可", "skin_url": None, "avatar_url": None, "color": "#aabbcc", "active": True}],
                            "player": {"name": "玩家", "skin_url": None, "avatar_url": None, "color": None}}
                elif path == "/api/sessions":
                    body = [SESSION]
                elif path == "/api/sessions/stream-qa":
                    body = SESSION
                elif path.endswith("/config"):
                    body = {"theme": "dark", "skin": "default"}
                elif path.endswith("/memories"):
                    body = {"memories": [], "narration_count": 1}
                elif path.endswith("/characters"):
                    body = {"characters": ["妮可"], "character_colors": {"妮可": "#aabbcc"}}
                else:
                    body = {}
                route.fulfill(json=body)

            page.route("**/api/**", api)
            page.goto(BASE)
            page.evaluate("""async session => {
                const {useAppStore} = await import('/src/stores/appStore.ts'); window.qaStore = useAppStore;
                useAppStore.setState({currentView:'chat', chatMode:'story',activeSessionId:session.id,sessions:[session],
                  chatLayout:'stage',scenePanelOpen:false,editBeforeSend:false,
                  sessionMessages:{[session.id]:[{role:'narrator',content:'妮可说：「开始阅读。」',round:1}]},
                  sessionNarrationCount:{[session.id]:1}});
            }""", SESSION)
            dialog = page.locator(".stage-dialog")
            text = page.locator(".stage-dialog-text")
            progress = page.locator(".stage-progress")
            composer = page.get_by_role("textbox", name="行动或对话")
            dialog.press("End")
            expect(composer).to_be_visible()

            def begin():
                server.plan = Plan()
                composer.fill("继续")
                composer.press("Enter")
                assert server.plan.started.wait(5), "SSE request did not reach fixture"
                server.plan.send("meta", {"stream_id": "fixture"})
                return server.plan

            plan = begin()
            plan.send("attribute_roll", {"text": "检定成功", "attribute": "insight", "character": "玩家", "roll": 12, "modifier": 0, "total": 12, "dc": 10, "success": True, "source": "story", "stream_id": "fixture"})
            plan.send("reasoning", {"token": "不得展示的思考"})
            plan.send("text", {"token": RAW[:300]})
            expect(text).to_contain_text(RAW[:140])
            expect(dialog).not_to_contain_text("不得展示的思考")
            expect(dialog).not_to_contain_text("检定成功")
            expect(progress).to_contain_text("1 / 3")
            expect(progress).to_contain_text("接收中")
            expect(composer).not_to_be_visible()
            dialog.press("End")
            expect(progress).to_contain_text("3 / 3")
            expect(text).to_contain_text(RAW[280:300])
            plan.send("text", {"token": RAW[300:]})
            expect(text).to_have_text(RAW[280:420])
            assert progress.inner_text().startswith("3 / ")
            dialog.press("ArrowLeft")
            expect(progress).to_contain_text("2 / ")
            page.keyboard.down("Control")
            page.keyboard.up("Control")
            expect(progress).to_contain_text("3 / ")
            dialog.press("Control+c")
            expect(progress).to_contain_text("3 / ")
            checks.append("real SSE tokens, roll/reasoning separation, fixed pages, no auto advance, End does not unlock")

            page.evaluate("qaStore.setState({chatLayout:'log'})")
            page.evaluate("qaStore.setState({chatLayout:'stage'})")
            expect(text).to_have_text(RAW[280:420])
            checks.append("log remount retains reading page")
            before_stage_requests = len(stage_requests)
            authority = "检定结果已确认。\n\n" + RAW
            plan.send("text_complete", {"stream_id": "fixture", "narrative": authority})
            expect(progress).to_contain_text("整理中")
            expect(text).to_have_text(RAW[280:420])
            assert len(stage_requests) == before_stage_requests
            other = {**SESSION, "id":"stream-other", "name":"另一会话"}
            page.evaluate("""other => qaStore.setState(state => ({sessions:[...state.sessions,other],activeSessionId:other.id,
              sessionMessages:{...state.sessionMessages,[other.id]:[{role:'narrator',content:'另一会话的内容。',round:1}]}}))""", other)
            expect(text).not_to_contain_text(RAW[280:420])
            resource_failure = True
            plan.send("choice", {"options": ["继续阅读"], "branches": []})
            plan.send("done", {"stream_id": "fixture", "round": 2, "phase2_status": "completed"})
            page.wait_for_function("qaStore.getState().sessionMessages['stream-qa'].find(m=>m.role==='narrator' && m.generationId)?.generationPhase==='complete'")
            page.evaluate("qaStore.setState({activeSessionId:'stream-qa'})")
            expect(progress).not_to_contain_text("整理中")
            page.wait_for_function("qaStore.getState().sessionMessages['stream-qa'].find(m=>m.role==='user')?.round===2")
            expect(page.locator(".stage-name")).to_contain_text("妮可")
            # Page 3 starts at raw offset 280; its formal utterance page covers
            # raw [145,285) because the five-character speaker prefix is removed.
            expect(text).to_have_text(RAW[145:285])
            expect(page.locator(".stage-media-error")).to_be_visible()
            expect(composer).not_to_be_visible()
            checks.append("canonical prefix mapping, formal speaker, failed stage resource does not block text")

            for width, height in [(1280,720),(1400,900),(1600,900),(1920,1080),(2560,1440)]:
                page.set_viewport_size({"width": width, "height": height})
                for skin, theme in [("default","dark"),("default","light"),("prts","dark"),("tavern","dark")]:
                    page.evaluate("([skin,theme]) => qaStore.setState({skin,theme})", [skin,theme])
                    page.wait_for_function("([skin,theme]) => { const root=document.documentElement; return root.classList.contains('light') === (skin==='default' && theme==='light') && root.classList.contains('skin-prts') === (skin==='prts') && root.classList.contains('skin-tavern') === (skin==='tavern'); }", arg=[skin, theme])
                    box = dialog.bounding_box()
                    assert 0 <= box["x"] and box["x"] + box["width"] <= width + 1
                    assert 0 <= box["y"] and box["y"] + box["height"] <= height + 1
                    assert dialog.evaluate("el => el.scrollWidth <= el.clientWidth + 1")
                    page.screenshot(path=str(OUT / f"formal-{width}-{height}-{skin}-{theme}.png"))
            checks.append("five desktop viewports, dark/light/PRTS/Tavern layout and screenshots")
            dialog.press("End")
            expect(composer).to_be_visible()

            plan = begin()
            plan.send("text", {"token": "这段文字在断线后仍可阅读。"})
            expect(text).to_have_text("这段文字在断线后仍可阅读。")
            plan.send("EOF")
            expect(progress).to_contain_text("中断")
            expect(text).to_have_text("这段文字在断线后仍可阅读。")
            expect(composer).to_be_visible()
            checks.append("natural EOF preserves readable text and exposes recovery input")
            assert page.evaluate("qaStore.getState().sessionMessages['stream-qa'].filter(m=>m.role==='user').at(-1).round===undefined")
            plan = begin()
            plan.send("text", {"token":"取消后保留正文。"})
            expect(text).to_have_text("取消后保留正文。")
            page.evaluate("qaStore.getState().sessionAbortFns['stream-qa']()")
            expect(progress).to_contain_text("取消")
            plan.send("text", {"token":"迟到正文不得显示"})
            plan.send("done", {"stream_id":"fixture","round":3,"phase2_status":"completed"})
            expect(text).to_have_text("取消后保留正文。")
            expect(composer).to_be_visible()
            checks.append("cancel preserves content, rejects late events and permits retry")
            plan = begin()
            plan.send("text", {"token": '[{"type":"dialogue","speaker":"妮可","text":"等等。"}]'})
            expect(dialog).not_to_contain_text('"type"')
            plan.send("text_complete", {"stream_id":"fixture", "narrative":"妮可说：「等等。」"})
            expect(text).to_have_text("妮可说：「等等。」")
            plan.send("done", {"stream_id":"fixture","round":3,"phase2_status":"degraded"})
            expect(text).to_have_text("等等。")
            checks.append("JSON stream suppression, canonical preview, degraded completion remains readable")
            dialog.press("End")
            expect(composer).to_be_visible()
            plan = begin()
            plan.send("text", {"token":RAW[:300]})
            expect(progress).to_contain_text("1 / 3")
            dialog.press("End")
            plan.send("text", {"token":RAW[300:]})
            expect(text).to_have_text(RAW[280:420])
            # Stay mounted: coverage of a growing current page must not be lost
            # to the local cursor snapshot created by the earlier End press.
            plan.send("text_complete", {"stream_id":"fixture","narrative":RAW})
            expect(progress).to_contain_text("整理中")
            plan.send("done", {"stream_id":"fixture","round":4,"phase2_status":"completed"})
            expect(text).to_have_text(RAW[145:285])
            dialog.press("ArrowRight")
            expect(text).to_have_text(RAW[285:425], timeout=200)
            expect(page.locator(".stage-caret")).to_have_count(0, timeout=200)
            checks.append("mounted handoff retains all grown preview coverage; subsequent shown text is not retyped")
            page.evaluate("""qaStore.setState(state => ({chatMode:'free',sessionStreaming:{},sessionSending:{},sessionMessages:{
              'stream-qa':[{role:'narrator',content:'旧的失败稿',generationId:'old-failure',generationPhase:'error'},
                {role:'character',character:'妮可',content:'妮可说：「'+'新的一次完整发言。'.repeat(45)+'」'}]}}))""")
            expect(composer).not_to_be_visible(timeout=200)
            dialog.press("End")
            expect(composer).to_be_visible()
            checks.append("an older failed narration cannot unlock input during a newer character playback")
            page.evaluate("""qaStore.setState({chatMode:'story',chatLayout:'log',sessionNarrationCount:{'stream-qa':1},
              sessionMessages:{'stream-qa':[{role:'user',content:'原始输入',round:1},
                {role:'narrator',content:'原始正文',round:1}]}})""")
            server.rollback_started = threading.Event()
            server.rollback_gate = threading.Event()
            page.get_by_title("编辑此消息", exact=True).click()
            page.locator(".chat-msg textarea").fill("编辑后的输入")
            page.get_by_role("button", name="保存并继续", exact=True).click()
            assert server.rollback_started.wait(5)
            expect(composer).to_be_disabled()
            # A background narration can replace an edit even while UI sending
            # is locked; the old rollback result must not truncate or cancel it.
            server.plan = Plan()
            page.evaluate("""async () => {const {triggerNarrate}=await import('/src/components/ChatPanel.tsx');
              triggerNarrate('stream-qa','新的请求');} """)
            for _ in range(100):
                if server.plan.started.is_set():
                    break
                page.wait_for_timeout(50)
            assert server.plan.started.is_set()
            server.plan.send("meta", {"stream_id":"fixture"})
            server.plan.send("text", {"token":"新的回复内容"})
            page.wait_for_function("qaStore.getState().sessionMessages['stream-qa'].at(-1).content==='新的回复内容'")
            new_generation = page.evaluate("qaStore.getState().sessionMessages['stream-qa'].at(-1).generationId")
            with page.expect_response(lambda response: urlparse(response.url).path.endswith('/rollback')) as response:
                server.rollback_gate.set()
            response.value.body()
            page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
            assert page.evaluate("qaStore.getState().sessionMessages['stream-qa'].at(-1).generationId") == new_generation
            assert page.evaluate("!!qaStore.getState().sessionAbortFns['stream-qa']")
            server.plan.send("error", {"message":"fixture cleanup"})
            page.wait_for_function("!qaStore.getState().sessionStreaming['stream-qa']")
            page.wait_for_timeout(100)
            checks.append("pending edit locks sending and late rollback cannot cancel a replacement narration")
            assert not errors, errors
            report = {"checks": checks, "page_errors": errors, "screenshots": 20, "boundary": "fixture model/API responses with real HTTP SSE and production React transport/rendering"}
            (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps(report, ensure_ascii=False))
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    run()
