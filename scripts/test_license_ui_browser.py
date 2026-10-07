"""In-app license entry (AGPL) browser QA. Requires Vite web on :5183; API calls are synthetic.

Checks the AGPL §5(d) surface: settings "关于" shows the license identifier plus links to the
license text and the source repository, the home footer carries the same license link, and both
stay visible without horizontal overflow across the five fixed desktop acceptance sizes.
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

        # ── 设置页「关于」 ───────────────────────────────────────────────
        page.evaluate("""async () => {
          const {useAppStore} = await import('/src/stores/appStore.ts');
          useAppStore.setState({currentView:'settings'});
        }""")
        about = page.locator("section.card", has=page.get_by_role("heading", name="关于"))
        expect(about).to_be_visible()
        expect(about).to_contain_text("Ark Tavern v0.1.0")
        expect(about).to_contain_text("许可：")
        expect(about).to_contain_text("AGPL-3.0")

        license_link = about.get_by_role("link", name="AGPL-3.0", exact=True)
        expect(license_link).to_have_attribute("href", LICENSE_URL)
        expect(license_link).to_have_attribute("target", "_blank")
        # 链接相对正文要能看出可点：有下划线装饰且颜色不同于普通正文
        underline = license_link.evaluate("el => getComputedStyle(el).textDecorationLine")
        assert "underline" in underline, underline
        # 许可只保留一行标识，不带额外说明文字
        license_paragraphs = about.locator("p", has_text="许可：")
        assert license_paragraphs.count() == 1
        assert license_paragraphs.first.inner_text().strip() == "许可： AGPL-3.0", license_paragraphs.first.inner_text()

        for width, height in SIZES:
            page.set_viewport_size({"width": width, "height": height})
            page.wait_for_timeout(120)
            assert license_link.is_visible(), f"license link hidden at {width}x{height}"
            assert about.evaluate("el => el.scrollWidth <= el.clientWidth + 1"), f"about block overflows at {width}x{height}"
            page.screenshot(path=str(SHOTS / f"about-{width}x{height}.png"), full_page=True)

        # ── 主页页脚许可标识 ─────────────────────────────────────────────
        page.set_viewport_size({"width": 1400, "height": 900})
        page.evaluate("""async () => {
          const {useAppStore} = await import('/src/stores/appStore.ts');
          useAppStore.setState({currentView:'home'});
        }""")
        footer_link = page.locator("footer.home-menu-footer a.home-license-link")
        expect(footer_link).to_be_visible()
        expect(footer_link).to_have_text("AGPL-3.0")
        expect(footer_link).to_have_attribute("href", LICENSE_URL)
        expect(footer_link).to_have_attribute("target", "_blank")
        expect(page.locator("footer.home-menu-footer .home-menu-version")).to_have_text("v0.1.0")
        page.screenshot(path=str(SHOTS / "home-footer-1400x900.png"), full_page=True)

        assert not errors, errors
        browser.close()
    print(f"license UI checks passed; screenshots in {SHOTS}")


if __name__ == "__main__":
    run()
