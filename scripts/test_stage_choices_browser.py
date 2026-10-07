"""Desktop stage choice regression; all API requests are mocked, no real saves.

Start: npm run dev:web -- --host 127.0.0.1 --port 5178 --strictPort
Run: python scripts/test_stage_choices_browser.py
"""
import json
import os
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE_URL = os.environ.get("STAGE_CHOICES_URL", "http://127.0.0.1:5178")
SESSION = {"id": "choices-qa", "name": "雨夜归途", "mode": "story", "characters": [],
           "player_identity": "玩家", "narration_count": 1, "combat_mode": "narrative",
           "worldbook_ids": [], "in_combat": False}
BRANCHES = [
    {"id": "follow /灯火", "label": "沿着灯火，去桥的另一端寻找她", "source": "author", "intent": "情报",
     "available": True, "condition_summary": ["信任 ≥ 3"], "effect_summary": ["信任 + 1"]},
    {"id": "wait", "label": "留在雨棚下，等她把话说完", "source": "llm", "intent": "等待", "available": True},
    {"id": "gate", "label": "出示通行证，进入封锁的街区", "available": False,
     "blocked_reasons": ["尚未取得街区通行证"]},
]
TEXT = "雨沿着伞骨缓缓落下，远处桥上的灯火忽明忽暗。" * 5


def messages(round_, branches=BRANCHES):
    return [{"role": "narrator", "round": round_, "content": TEXT,
             "dialogueSegments": [{"type": "dialogue", "speaker": "旅人", "text": TEXT}]},
            {"role": "system", "content": "请选择", "round": round_, "branches": branches}]


def run():
    shots = ROOT / ".impeccable" / "review" / "stage-choices"
    shots.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 960}, reduced_motion="reduce")
        errors, requests = [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
        # System fonts keep this isolated UI regression independent of Google
        # Fonts availability (including screenshot font-loading waits).
        page.route("https://fonts.googleapis.com/**", lambda route: route.fulfill(content_type="text/css", body=""))

        def route_api(route):
            url = urlparse(route.request.url)
            path = url.path
            if path.endswith("/narrate"):
                requests.append(parse_qs(url.query))
                narrative = "她回过头，向你伸出了手。"
                events = [{"type":"text","data":{"token":narrative}},
                          {"type":"text_complete","data":{"stream_id":"choices-test","narrative":narrative}},
                          {"type":"done","data":{"stream_id":"choices-test","round":2,"phase2_status":"completed"}}]
                route.fulfill(content_type="text/event-stream", body="".join(f'data: {json.dumps(event,ensure_ascii=False)}\n\n' for event in events))
                return
            if path.endswith("/avatar"):
                route.fulfill(content_type="image/svg+xml", body='<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#6d665d"/></svg>')
                return
            if path.endswith("/stage"):
                body = {"session_id": SESSION["id"], "location": "旧城区 · 石桥", "weather": "小雨", "time": "夜晚",
                        "atmosphere": [], "background": {"url": None, "source": "none", "bg_id": ""},
                        "characters": [], "player": {"name": "玩家", "skin_url": None, "avatar_url": None, "color": None}}
            elif path == "/api/sessions":
                body = [SESSION]
            elif path == "/api/sessions/choices-qa":
                body = SESSION
            elif path.endswith("/memories"):
                body = {"memories": [], "narration_count": 1}
            elif path.endswith("/characters"):
                body = {"characters": [], "character_colors": {}}
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
            sessions:[session], chatLayout:'stage', scenePanelOpen:false, editBeforeSend:false,
            sessionMessages:{[session.id]:messages}, sessionNarrationCount:{[session.id]:1}});
        }""", {"session": SESSION, "messages": messages(1)})
        dialogue = page.locator(".stage-dialog")
        choices = page.get_by_role("group", name="剧情选项", exact=True)
        composer = page.get_by_role("textbox", name="行动或对话")

        def reset(round_, branches=BRANCHES):
            page.evaluate("""({messages, round}) => qaStore.setState({
              sessionMessages:{'choices-qa':messages}, sessionNarrationCount:{'choices-qa':round},
              sessionStreaming:{},sessionSending:{}})""", {"messages": messages(round_, branches), "round": round_})
            expect(choices).to_have_count(0)

        def stable_completion():
            expect(dialogue).to_be_visible()
            expect(choices).to_have_count(0)
            expect(composer).not_to_be_visible()
            before = dialogue.bounding_box()
            dialogue.click()
            expect(choices).to_be_visible()
            expect(composer).to_be_visible()
            after = dialogue.bounding_box()
            assert all(abs(before[key] - after[key]) <= 1 for key in before), (before, after)
            box = choices.bounding_box()
            stage = page.locator(".stage").bounding_box()
            assert box["y"] >= stage["y"] + 48
            assert box["y"] + box["height"] <= after["y"] - 10, (box, after)
            assert abs((box["x"] + box["width"] / 2) - (stage["x"] + stage["width"] / 2)) <= 1
            assert choices.evaluate("el => !el.closest('.stage-dialog-wrap')")
            assert not any(word in choices.inner_text() for word in ["作者预设分支", "情报", "信任", "条件：", "效果："])
            expect(choices.get_by_role("button").nth(2)).to_be_disabled()
            expect(choices).to_contain_text("尚未取得街区通行证")
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")

        stable_completion()
        choices.get_by_role("button").first.hover()
        choices.get_by_role("button").first.focus()
        page.keyboard.press("Tab")
        page.keyboard.press("Shift+Tab")
        assert choices.get_by_role("button").first.evaluate("el => getComputedStyle(el).outlineStyle != 'none'")
        page.screenshot(path=str(shots / "desktop.png"))
        # Editing a choice fills the same composer but does not start a request.
        page.evaluate("qaStore.setState({editBeforeSend:true})")
        choices.get_by_role("button").first.click()
        expect(composer).to_have_value(BRANCHES[0]["label"])
        assert not requests
        page.get_by_role("button", name="发送", exact=True).click()
        page.wait_for_function("!qaStore.getState().sessionStreaming['choices-qa']")
        assert len(requests) == 1 and requests[-1]["branch_id"] == [BRANCHES[0]["id"]], requests
        page.evaluate("qaStore.setState({editBeforeSend:false})")

        for index, size in enumerate([(1366, 768), (1280, 720)], start=2):
            page.set_viewport_size({"width": size[0], "height": size[1]})
            reset(index)
            stable_completion()
        page.get_by_role("button", name="进入纯舞台模式").click()
        reset(4)
        stable_completion()
        page.screenshot(path=str(shots / "pure-stage.png"))
        # A long list scrolls independently and never covers/moves the dialogue.
        many = BRANCHES + [{"id": f"long-{i}", "label": f"第{i + 1}条小路：" + "循着雨中断续的脚步声，走向桥下的旧书店。" * 5} for i in range(10)]
        reset(5, many)
        stable_completion()
        before = dialogue.bounding_box()
        assert choices.evaluate("el => el.scrollHeight > el.clientHeight")
        choices.get_by_role("button").last.focus()
        assert choices.evaluate("el => el.scrollTop > 0"), "keyboard focus scrolls to the final choice"
        assert dialogue.bounding_box() == before
        page.screenshot(path=str(shots / "long-options.png"))
        page.keyboard.press("Enter")
        page.wait_for_function("!qaStore.getState().sessionStreaming['choices-qa']")
        assert len(requests) == 2 and requests[-1]["branch_id"] == ["long-9"]
        expect(choices).to_have_count(0)

        reset(6)
        stable_completion()
        composer.fill("我把伞递给她，问她是否愿意同行。")
        page.get_by_role("button", name="发送", exact=True).click()
        page.wait_for_function("!qaStore.getState().sessionStreaming['choices-qa']")
        assert len(requests) == 3 and "branch_id" not in requests[-1]
        assert requests[-1]["action"] == ["我把伞递给她，问她是否愿意同行。"]
        # Waiting and a completed narration without choices keep the same dock.
        reset(7)
        before = dialogue.bounding_box()
        page.evaluate("qaStore.setState({sessionStreaming:{'choices-qa':true}})")
        expect(dialogue).not_to_contain_text("正在排演下一幕")
        expect(choices).to_have_count(0)
        expect(composer).not_to_be_visible()
        assert dialogue.bounding_box() == before
        page.evaluate("""qaStore.setState({sessionStreaming:{}, sessionMessages:{'choices-qa':[
          {role:'narrator', content:'雨停了。', round:8}]}})""")
        expect(composer).to_be_visible()
        expect(choices).to_have_count(0)
        assert dialogue.bounding_box() == before

        # End skips the whole current script, including the final typewriter.
        # Use several long steps so a normal advance/natural completion cannot
        # accidentally satisfy these assertions.
        stage = page.get_by_label("对话舞台", exact=True)
        progress = page.locator(".stage-progress")
        final_text = "她停在桥的另一端，安静地等待你的回答。" * 6
        round_ = 20

        def reset_skip(*, with_choices=True, count=3, variant=0, waiting=False, locked=False):
            nonlocal round_
            round_ += 1
            segments = [{"type": "narration", "text": TEXT} for _ in range(count - 1)]
            segments.append({"type": "dialogue", "speaker": "旅人", "text": final_text})
            script = [{"role": "narrator", "round": round_, "variantIndex": variant,
                       "content": "\n".join(s["text"] for s in segments), "dialogueSegments": segments}]
            if with_choices:
                script.append({"role": "system", "round": round_, "content": "请选择", "branches": BRANCHES})
            page.evaluate("""({messages, round, waiting, locked, session}) => qaStore.setState({
              sessions:[{...session,in_combat:locked}], sessionMessages:{'choices-qa':messages},
              sessionNarrationCount:{'choices-qa':round},sessionStreaming:{'choices-qa':waiting},sessionSending:{}
            })""", {"messages": script, "round": round_, "waiting": waiting, "locked": locked, "session": SESSION})
            expect(choices).to_have_count(0)
            expect(composer).not_to_be_visible()
            if not waiting:
                expect(progress).to_contain_text(f"1 / {count}")

        def assert_skipped(*, with_choices=True, count=3):
            expect(progress).to_have_text(f"{count} / {count}")
            expect(page.locator(".stage-dialog-text")).to_have_text(final_text)
            expect(composer).to_be_visible()
            if with_choices:
                expect(choices).to_be_visible()
            else:
                expect(choices).to_have_count(0)
            # Observe several animation frames after passive effects have run:
            # skip must never reset the last sentence back to its typewriter.
            assert page.evaluate("""async () => {
              for(let i=0;i<8;i++) {
                await new Promise(requestAnimationFrame);
                if(document.querySelector('.stage-caret')) return false;
              }
              return true;
            }""")
            assert len(requests) == 3, "skip never sends/chooses/starts a new narration"
            assert page.evaluate("qaStore.getState().sessionNarrationCount['choices-qa']") == round_

        # The existing checks left us in pure-stage mode; cover both layouts.
        page.get_by_role("button", name="退出纯舞台", exact=True).click()
        for pure in [False, True]:
            if pure:
                page.get_by_role("button", name="进入纯舞台模式").click()
            reset_skip()
            expect(progress).to_contain_text("End 跳至选项")
            if not pure:
                page.screenshot(path=str(shots / "skip-hint.png"))
            dialogue.focus()
            page.keyboard.press("End")
            assert_skipped()
            page.keyboard.press("End")
            assert_skipped()
            page.screenshot(path=str(shots / ("skip-pure-stage.png" if pure else "skip-desktop.png")))
            # Returning to an earlier step must restore normal playback.
            page.get_by_role("button", name="上一句", exact=True).click()
            expect(progress).to_contain_text("2 / 3")
            expect(choices).to_have_count(0)
            page.keyboard.press("End")  # Native toolbar button retains its keyboard semantics.
            expect(progress).to_contain_text("2 / 3")
            stage.focus()
            page.keyboard.press("End")
            assert_skipped()

        reset_skip(with_choices=False)
        expect(progress).to_contain_text("End 跳至输入")
        stage.press("End")
        assert_skipped(with_choices=False)
        composer.fill("测试文本")
        composer.press("Home")
        composer.press("End")
        assert composer.evaluate("el => el.selectionStart === el.value.length")
        assert len(requests) == 3

        reset_skip(count=1)
        dialogue.press("End")
        assert_skipped(count=1)
        # A variant of the same round is a fresh script, not a retained skip.
        page.evaluate("""qaStore.setState(state => ({sessionMessages:{'choices-qa':
          state.sessionMessages['choices-qa'].map(m => m.role==='narrator' ? {...m,variantIndex:1} : m)}}))""")
        expect(choices).to_have_count(0)
        expect(composer).not_to_be_visible()
        dialogue.press("End")
        assert_skipped(count=1)

        reset_skip()
        dialogue.focus()
        for key in ["Control+c", "Control+End", "Shift+End", "Alt+End", "Meta+End"]:
            page.keyboard.press(key)
            expect(progress).to_contain_text("1 / 3")
            expect(choices).to_have_count(0)
        for event in [{"isComposing": True}, {"repeat": True}]:
            dialogue.dispatch_event("keydown", {"key": "End", **event})
            expect(progress).to_contain_text("1 / 3")
        # Keep the existing single-step and held Ctrl shortcuts.
        page.keyboard.press("Control")
        expect(progress).to_contain_text("1 / 3")
        expect(page.locator(".stage-caret")).to_have_count(0)
        page.keyboard.press("Control")
        expect(progress).to_contain_text("2 / 3")
        dialogue.press("End")
        assert_skipped()

        reset_skip()
        dialogue.focus()
        page.keyboard.down("Control")
        expect(progress).not_to_contain_text("1 / 3")
        page.keyboard.up("Control")
        dialogue.press("End")
        assert_skipped()

        for waiting, locked in [(True, False), (False, True)]:
            reset_skip(waiting=waiting, locked=locked)
            dialogue.press("End")
            expect(choices).to_have_count(0)
            expect(composer).not_to_be_visible()
            expect(progress).to_contain_text("1 / 3")

        reset_skip()
        page.get_by_role("button", name="调整立绘", exact=True).click()
        stage.press("End")
        expect(progress).to_contain_text("1 / 3")
        stage.press("Escape")
        stage.press("End")
        assert_skipped()
        assert not errors, errors
        browser.close()
        print("stage choices browser: 3 desktop sizes, fixed dialogue, pure stage, scrolling, keyboard, edit/send, branch IDs, free input, End skip/reset/guards, console passed")


if __name__ == "__main__":
    run()
