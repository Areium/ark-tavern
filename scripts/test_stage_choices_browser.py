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

        def route_api(route):
            url = urlparse(route.request.url)
            path = url.path
            if path.endswith("/narrate"):
                requests.append(parse_qs(url.query))
                token = json.dumps({"type": "text", "data": {"token": "她回过头，向你伸出了手。"}}, ensure_ascii=False)
                route.fulfill(content_type="text/event-stream", body=f'data: {token}\n\ndata: {{"type":"done"}}\n\n')
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
        expect(dialogue).to_contain_text("正在排演下一幕")
        expect(choices).to_have_count(0)
        expect(composer).not_to_be_visible()
        assert dialogue.bounding_box() == before
        page.evaluate("""qaStore.setState({sessionStreaming:{}, sessionMessages:{'choices-qa':[
          {role:'narrator', content:'雨停了。', round:8}]}})""")
        expect(composer).to_be_visible()
        expect(choices).to_have_count(0)
        assert dialogue.bounding_box() == before
        assert not errors, errors
        browser.close()
        print("stage choices browser: 3 desktop sizes, fixed dialogue, pure stage, scrolling, keyboard, edit/send, branch IDs, free input, console passed")


if __name__ == "__main__":
    run()
