"""In-app license entry (AGPL) browser QA. Requires Vite web on :5183; API calls are synthetic.

Checks settings "关于" keeps only the license identifier linked to the full text, and the
home footer omits license content while retaining status, version and audio controls.
Both views are checked across the five fixed desktop acceptance sizes.
"""
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / ".tmp" / "license-qa"
BASE = "http://127.0.0.1:5183"
REPO = "https://github.com/Areium/ark-tavern"
LICENSE_URL = REPO + "/blob/main/LICENSE"
SIZES = [(1280, 720), (1400, 900), (1600, 900), (1920, 1080), (2560, 1440)]


def route_api(route):
    path = route.request.url.split("/api/", 1)[-1].split("?")[0]
    if path.endswith("config"):
        body = {"theme": "dark", "skin": "default"}
    elif path == "worldbooks":
        body = {"books": []}
    elif path == "sessions":
        body = []
    elif path in ("plots", "characters"):
        body = []
    else:
        body = {}
    route.fulfill(json=body)


def run():
    SHOTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1400, "height": 900}, reduced_motion="reduce")
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.route("**/api/**", route_api)
        page.goto(BASE)
        page.get_by_role("button", name="进入 Ark Tavern", exact=True).click()
        expect(page.locator(".home-splash")).to_have_count(0)

        # ── 设置页「关于」 ───────────────────────────────────────────────
        page.evaluate("""async () => {
          const {useAppStore} = await import('/src/stores/appStore.ts');
          useAppStore.setState({currentView:'settings'});
        }""")
        about = page.locator("section.card", has=page.get_by_role("heading", name="关于"))
        expect(about).to_be_visible()
        expect(about).to_contain_text("Ark Tavern v0.1.0")
        expect(about).to_contain_text("许可：")
        expect(about).to_contain_text("AGPL-3.0 license")

        license_link = about.get_by_role("link", name="AGPL-3.0 license", exact=True)
        expect(license_link).to_have_attribute("href", LICENSE_URL)
        expect(license_link).to_have_attribute("target", "_blank")
        # 链接相对正文要能看出可点：有下划线装饰且颜色不同于普通正文
        underline = license_link.evaluate("el => getComputedStyle(el).textDecorationLine")
        assert "underline" in underline, underline
        # 许可只保留一行标识，不带额外说明文字
        license_paragraphs = about.locator("p", has_text="许可：")
        assert license_paragraphs.count() == 1
        assert license_paragraphs.first.inner_text().strip() == "许可： AGPL-3.0 license", license_paragraphs.first.inner_text()

        for width, height in SIZES:
            page.set_viewport_size({"width": width, "height": height})
            page.wait_for_timeout(120)
            assert license_link.is_visible(), f"license link hidden at {width}x{height}"
            assert about.evaluate("el => el.scrollWidth <= el.clientWidth + 1"), f"about block overflows at {width}x{height}"
            page.screenshot(path=str(SHOTS / f"about-{width}x{height}.png"), full_page=True)

        # ── 主页页脚不显示许可 ─────────────────────────────────────────────
        page.set_viewport_size({"width": 1400, "height": 900})
        page.evaluate("""async () => {
          const {useAppStore} = await import('/src/stores/appStore.ts');
          useAppStore.setState({currentView:'home'});
        }""")
        footer = page.locator("footer.home-menu-footer")
        expect(footer).to_be_visible()
        expect(footer.locator("a")).to_have_count(0)
        expect(footer).not_to_contain_text("AGPL")
        expect(footer).not_to_contain_text("许可")
        expect(footer.locator(".home-menu-version")).to_have_text("v0.1.0")
        expect(footer.locator(".home-status")).to_have_count(2)
        expect(footer.locator("button.home-audio-btn")).to_be_visible()
        expect(footer.get_by_role("slider")).to_be_visible()
        for width, height in SIZES:
            page.set_viewport_size({"width": width, "height": height})
            page.wait_for_timeout(120)
            assert footer.evaluate("el => el.scrollWidth <= el.clientWidth + 1"), f"footer overflows at {width}x{height}"
            page.screenshot(path=str(SHOTS / f"home-footer-{width}x{height}.png"), full_page=True)

        assert not errors, errors
        browser.close()
    print(f"license UI checks passed; screenshots in {SHOTS}")


if __name__ == "__main__":
    run()
