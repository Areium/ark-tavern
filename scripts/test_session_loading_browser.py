"""Synthetic session catalog latency/interaction regression on Vite web :5185."""
import argparse
import json
import re
from pathlib import Path
from time import perf_counter
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / ".impeccable" / "review"
SESSION = {"id": "loading-qa", "name": "加载验收 · 合成会话", "mode": "story", "characters": [],
           "player_identity": "玩家", "narration_count": 0, "combat_mode": "narrative",
           "worldbook_ids": [], "in_combat": False, "created_at": 1}


def run(baseline=False):
    SHOTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 960}, reduced_motion="reduce")
        errors, submitted, console_errors = [], [], []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.add_init_script("""window.qaCatalog = {counts:{},pending:0,delay:600,fail:''};
          const original = window.fetch;
          window.fetch = async (input, init) => {
            const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
            if (['/api/plots','/api/worldbook','/api/characters'].includes(path)) {
              qaCatalog.counts[path] = (qaCatalog.counts[path] || 0) + 1;
              qaCatalog.pending++;
              await new Promise(resolve => setTimeout(resolve,qaCatalog.delay));
              qaCatalog.pending--;
              if (path === qaCatalog.fail) return new Response(JSON.stringify({error:'合成目录读取失败'}),{status:503});
            }
            return original(input, init);
          };
        """)

        def route_api(route):
            path = urlparse(route.request.url).path
            if route.request.method == "POST" and path == "/api/sessions":
                submitted.append(route.request.post_data_json)
                body = {**SESSION, "id": "created-qa", "name": "新建验收 · 合成会话"}
            elif path == "/api/sessions":
                body = [SESSION]
            elif path == "/api/characters":
                body = [{"id": "旅者", "name": "旅者", "summary": "合成自建角色", "worldbook_id": ""}]
            elif path in ("/api/plots", "/api/combat/test/suspended"):
                body = []
            elif path == "/api/worldbook":
                body = {"books": []}
            elif path.endswith("/config"):
                body = {"theme": "dark", "skin": "default"}
            elif path.endswith("/messages"):
                body = {"messages": []}
            elif path.endswith("/memories"):
                body = {"memories": [], "narration_count": 0}
            elif path.endswith("/loading-qa"):
                body = SESSION
            else:
                body = {}
            route.fulfill(json=body)

        page.route("**/api/**", route_api)
        page.goto("http://127.0.0.1:5185")
        page.evaluate("""async session => {
          const {useAppStore} = await import('/src/stores/appStore.ts');
          window.qaStore = useAppStore;
          useAppStore.setState({currentView:'sessions',sessions:[session],activeSessionId:session.id,chatMode:'story'});
        }""", SESSION)
        page.wait_for_function("Object.keys(qaCatalog.counts).length === 3 && !qaCatalog.pending")
        page.wait_for_timeout(150)
        initial = page.evaluate("({...qaCatalog.counts})")
        open_button = page.get_by_role("button", name=re.compile("^＋ 新建会话$"))
        started = perf_counter()
        open_button.click()
        expect(page.get_by_text("选择会话模式与战斗模式（创建后不可更改）", exact=True)).to_be_visible()
        elapsed = round((perf_counter() - started) * 1000)
        after = page.evaluate("({...qaCatalog.counts})")
        metrics = {"mock_catalog_delay_ms": 600, "warm_open_mode_ms": elapsed, "initial_requests": initial, "after_open_requests": after}
        if not baseline:
            assert after == initial, metrics
            assert elapsed < 500, metrics
        page.locator(".wizard-panel").get_by_role("button", name="关闭对话框", exact=True).click()
        if not baseline:
            panel = page.locator(".wizard-panel")
            next_button = panel.get_by_role("button", name="下一步", exact=True)
            def close():
                panel.get_by_role("button", name="关闭对话框", exact=True).click()

            # Warm reopen reuses catalog but resets user selections.
            open_button.click()
            panel.locator(".pick-card").filter(has_text="自由模式").click()
            next_button.click()
            expect(panel.locator(".step-label.active")).to_have_text("绑定世界书")
            close()
            open_button.click()
            next_button.click()
            expect(panel.locator(".step-label.active")).to_have_text("选择剧情")
            close()
            assert page.evaluate("qaCatalog.counts") == initial

            def remount(delay, fail=""):
                page.evaluate("qaStore.setState({currentView:'home'})")
                expect(open_button).not_to_be_visible()
                page.evaluate("""({delay,fail}) => {
                  qaCatalog.delay=delay; qaCatalog.fail=fail;
                  qaStore.setState({currentView:'sessions'});
                }""", {"delay": delay, "fail": fail})
                open_button.click()

            # Cold catalog: immediately choose a mode, then gate the dependent step.
            remount(1600)
            expect(page.get_by_text("选择会话模式与战斗模式（创建后不可更改）", exact=True)).to_be_visible()
            assert page.evaluate("qaCatalog.pending") == 3
            panel.locator(".pick-card").filter(has_text="自由模式").click()
            next_button.click()
            expect(panel.locator(".step-label.active")).to_have_text("绑定世界书")
            expect(next_button).to_be_disabled()
            expect(next_button).to_be_enabled(timeout=5000)
            expect(panel.locator(".step-label.active")).to_have_text("绑定世界书")
            close()

            # Every failed source is explicit, blocks progression and can be retried.
            for source, label in [("/api/plots", "剧情"), ("/api/worldbook", "世界书"), ("/api/characters", "角色")]:
                remount(60, source)
                next_button.click()
                expect(panel.get_by_role("alert")).to_contain_text(f"{label}目录未能加载")
                expect(next_button).to_be_disabled()
                count = page.evaluate("({...qaCatalog.counts})")
                page.evaluate("qaCatalog.fail=''; qaCatalog.delay=200")
                panel.get_by_role("button", name="重新加载目录", exact=True).click()
                expect(next_button).to_be_enabled()
                expect(panel.locator(".step-label.active")).to_have_text("选择剧情")
                assert page.evaluate("qaCatalog.counts") == {key: value + 1 for key, value in count.items()}
                close()

            # Normal create remains usable, with the current per-book payload contract.
            open_button.click()
            next_button.click()  # plot
            next_button.click()  # books
            next_button.click()  # lineup
            panel.locator('.char-tile').filter(has_text="旅者").first.click()
            next_button.click()  # finish
            panel.get_by_role("button", name="创建并进入", exact=True).click()
            expect(panel).not_to_be_visible()
            assert len(submitted) == 1, submitted
            assert submitted[0]["identity"] == "旅者", submitted
            assert submitted[0]["worldbook_ids"] == [], submitted
            assert submitted[0]["manual_entry_uids_by_book"] == {}, submitted
            assert "manual_entry_uids" not in submitted[0], submitted
            # Hover/selected outlines fit inside the list's own scroll clipping edge.
            page.evaluate("qaStore.setState({currentView:'sessions'})")
            gaps = []
            for width, height in [(1440, 960), (390, 844)]:
                page.set_viewport_size({"width": width, "height": height})
                for skin, theme in [("default", "dark"), ("default", "light"), ("prts", "dark"), ("tavern", "dark")]:
                    page.evaluate("({skin,theme})=>qaStore.setState({skin,theme})", {"skin": skin, "theme": theme})
                    search = page.get_by_placeholder("搜索会话 / 剧情 / 角色...")
                    search.fill("合成会话")
                    card = page.locator(".session-card").first
                    expect(card).to_be_visible()
                    card.evaluate("el => el.parentElement.scrollTop=0")
                    card.hover()
                    gap = card.evaluate("el => el.getBoundingClientRect().top - el.parentElement.getBoundingClientRect().top")
                    assert gap >= 6, {"width": width, "skin": skin, "gap": gap}
                    gaps.append(gap)
                    page.screenshot(path=str(SHOTS / f"session-hover-{width}-{skin}-{theme}.png"), full_page=True)
                    search.fill("")
                open_button.click()
                expect(page.get_by_text("选择会话模式与战斗模式（创建后不可更改）", exact=True)).to_be_visible()
                box = panel.bounding_box()
                assert box and box["x"] >= 0 and box["x"] + box["width"] <= width
                page.screenshot(path=str(SHOTS / f"session-wizard-{width}.png"), full_page=True)
                close()
            metrics["hover_top_gaps_px"] = gaps
        assert not errors, errors
        assert not console_errors, console_errors
        if baseline:
            assert not submitted
        browser.close()
    print(json.dumps(metrics, ensure_ascii=False))
    print("PASS: isolated session loading measurements; no real data writes")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", action="store_true")
    run(parser.parse_args().baseline)
