# -*- coding: utf-8 -*-
"""角色页（角色库 / 玩家身份 / 资产 / 卡牌）的真实页面截图验证。

驱动截图专用前端（`frontend/vite.config.shot.ts`，5174 → 后端 5001），逐屏截图并顺手
新建一个示例玩家身份「龙门侦探」，用来确认身份编辑器、列表行与角色库分组在有实例时的样子。

前置（另开两个终端）：
    API_PORT=5001 python src/app.py
    cd frontend && npx vite --config vite.config.shot.ts

用法：
    python scripts/shot_roles_ui.py                 # 截图到 .tmp/shots/
    python scripts/shot_roles_ui.py --cleanup       # 结束后删掉示例身份
    python scripts/shot_roles_ui.py --out D:/x      # 指定输出目录

依赖 pip 的 playwright（`pip install playwright && playwright install chromium`）。
本机若设了 HTTP(S)_PROXY，脚本已让 chromium 与 urllib 直连回环地址，不走代理。
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from urllib.parse import quote

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

IDENTITY = {
    "name": "龙门侦探",
    "summary": "常驻龙门下城区的私家侦探，靠人情和直觉办案",
    "tags": "侦探、龙门、非感染者",
    "attrs": {"strength": 4, "intelligence": 8, "emotional_stability": 6, "combat_skill": 5,
              "originium_arts": 1, "charisma": 7, "endurance": 5, "agility": 6},
    "content": (
        "# 角色设定\n\n"
        "在龙门下城区经营一间小侦探所，接的多是失物、失踪与讨债一类的委托。"
        "与近卫局的一些老熟人保持着不冷不热的往来，消息灵通但从不把话说满。\n\n"
        "## 性格\n\n"
        "嘴硬、记性好、欠人情必还。对源石与感染者议题保持中立，只看证据。\n\n"
        "## 目标\n\n"
        "查清三年前一桩被草草结案的码头纵火案。"
    ),
}
ATTR_ORDER = ["strength", "intelligence", "emotional_stability", "combat_skill",
              "originium_arts", "charisma", "endurance", "agility"]


def api_call(api, path, method="GET"):
    # 环境变量里的代理必须绕开，否则回环地址请求会被代理吞掉
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(api + path, method=method)
    try:
        with opener.open(req, timeout=10) as r:
            body = r.read().decode("utf-8")
            return r.status, (json.loads(body) if body else None)
    except urllib.error.HTTPError as e:
        return e.code, None


def set_theme(page, cls):
    page.evaluate(
        "(cls) => { const r = document.documentElement; r.classList.remove('light','skin-prts','skin-tavern'); if (cls) r.classList.add(cls); }",
        cls,
    )
    page.wait_for_timeout(400)


def run(base, api, out, cleanup):
    os.makedirs(out, exist_ok=True)
    shots = []

    def shot(page, name):
        path = os.path.join(out, f"{name}.png")
        page.screenshot(path=path)
        shots.append(path)

    ident_path = "/api/player-identities/" + quote(IDENTITY["name"])
    # 可重复执行：先清掉上一轮的示例身份，空态截图才是真的空态
    api_call(api, ident_path, "DELETE")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--proxy-server=direct://", "--proxy-bypass-list=*"])
        page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(base, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_selector(".home-splash", timeout=15000)
        page.click(".home-splash")
        page.wait_for_selector(".home-menu-stage.entered", timeout=10000)
        page.wait_for_timeout(1500)  # 字体与菜单入场动画
        page.locator(".home-menu-item", has_text="角色").first.click()
        tabs = page.locator('nav[aria-label="角色页模块"]')
        tabs.wait_for(timeout=10000)

        # ── 角色库：列表 + 详情 + 折叠 + 主题变体 ──
        row = page.locator("div.w-72 button", has_text="博士").first
        row.wait_for(timeout=15000)
        page.wait_for_timeout(800)
        shot(page, "01-characters-list")
        row.click()
        page.wait_for_selector(".roles-title", timeout=10000)
        page.wait_for_timeout(1200)
        shot(page, "02-characters-detail")
        page.get_by_role("button", name=re.compile("折叠全部世界书分组")).click()
        page.wait_for_timeout(300)
        shot(page, "03-characters-folded")
        page.get_by_role("button", name=re.compile("展开全部世界书分组")).click()
        page.wait_for_timeout(300)
        for cls, tag in (("light", "light"), ("skin-prts", "prts"), ("skin-tavern", "tavern")):
            set_theme(page, cls)
            shot(page, f"02-characters-detail-{tag}")
        set_theme(page, None)

        # ── 玩家身份：空态 → 新建示例实例 → 编辑态 ──
        tabs.locator("button", has_text="玩家身份").click()
        page.wait_for_timeout(600)
        shot(page, "04-identities-empty")
        page.locator("div.w-72 button", has_text="新建身份").click()
        page.get_by_placeholder("例如：博士、罗德岛新兵、龙门侦探").fill(IDENTITY["name"])
        page.get_by_placeholder("一句话描述这个身份").fill(IDENTITY["summary"])
        page.get_by_placeholder("例如：指挥官、感染者、战术专家").fill(IDENTITY["tags"])
        inputs = page.locator("label.stat-cell input")
        for i, key in enumerate(ATTR_ORDER):
            inputs.nth(i).fill(str(IDENTITY["attrs"][key]))
        page.get_by_placeholder("描述这个身份的背景、性格、目标……").fill(IDENTITY["content"])
        page.wait_for_timeout(300)
        shot(page, "05-identity-create-form")
        page.get_by_role("button", name=re.compile("保存身份")).click()
        page.wait_for_selector("text=已创建玩家身份", timeout=10000)
        page.locator("div.w-72 button", has_text=IDENTITY["name"]).first.wait_for(timeout=10000)
        page.wait_for_timeout(800)
        shot(page, "06-identity-saved")
        status, ids = api_call(api, "/api/player-identities")
        assert status == 200 and any(i["id"] == IDENTITY["name"] for i in ids or []), "新建的玩家身份未出现在 API 列表中"
        for cls, tag in (("light", "light"), ("skin-tavern", "tavern")):
            set_theme(page, cls)
            shot(page, f"06-identity-saved-{tag}")
        set_theme(page, None)
        # 新身份也应出现在角色库（它就是一份角色卡，归入「未分类」）
        tabs.locator("button", has_text="角色库").click()
        page.locator("div.w-72 button", has_text=IDENTITY["name"]).first.wait_for(timeout=10000)
        page.locator("div.w-72 button", has_text=IDENTITY["name"]).first.click()
        page.wait_for_timeout(1000)
        shot(page, "07-identity-in-library")

        # ── 资产：按类别 + 预览；按世界书；折叠 ──
        tabs.locator("button", has_text="资产").click()
        thumb = page.locator('div[role="button"][aria-pressed]').first
        thumb.wait_for(timeout=20000)
        page.wait_for_timeout(1500)
        shot(page, "08-assets-list")
        thumb.click()
        page.wait_for_selector(".roles-title", timeout=10000)
        page.wait_for_timeout(800)
        shot(page, "09-assets-preview")
        page.get_by_title("按来源世界书分组").click()
        page.wait_for_timeout(800)
        shot(page, "10-assets-by-worldbook")
        page.get_by_role("button", name=re.compile("折叠全部实体")).click()
        page.wait_for_timeout(400)
        shot(page, "11-assets-folded")

        # ── 卡牌：列表 + 编辑器 + 按世界书 + 浅色 ──
        tabs.locator("button", has_text="卡牌").click()
        crow = page.locator("div.w-72 button", has_text="博士").first
        crow.wait_for(timeout=15000)
        page.wait_for_timeout(600)
        shot(page, "12-cards-list")
        crow.click()
        page.wait_for_selector("text=专属卡牌", timeout=15000)
        page.wait_for_timeout(1000)
        shot(page, "13-cards-editor")
        page.get_by_title("按来源世界书分组").click()
        page.wait_for_timeout(600)
        shot(page, "14-cards-by-worldbook")
        set_theme(page, "light")
        shot(page, "13-cards-editor-light")
        set_theme(page, None)

        browser.close()

    if cleanup:
        api_call(api, ident_path, "DELETE")
    for path in shots:
        print("shot:", path)
    print("sample identity:", "removed" if cleanup else f"kept ({IDENTITY['name']})")
    print("page errors:", json.dumps(errors, ensure_ascii=False) if errors else "none")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="角色页截图验证")
    parser.add_argument("--base", default="http://localhost:5174/", help="截图专用前端地址")
    parser.add_argument("--api", default="http://127.0.0.1:5001", help="对应后端地址")
    parser.add_argument("--out", default=os.path.join(REPO, ".tmp", "shots"), help="截图输出目录")
    parser.add_argument("--cleanup", action="store_true", help="结束后删除示例玩家身份")
    args = parser.parse_args()
    run(args.base, args.api, args.out, args.cleanup)
