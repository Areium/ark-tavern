# -*- coding: utf-8 -*-
"""对话页（舞台 / 场景面板插件 / 数值）与角色页数值页签、世界书数值字段的真实页面截图验证。

驱动截图专用前端（`frontend/vite.config.shot.ts`，5174 → 后端 5001）。会通过 API 建一本临时世界书
（带统一数值字段）和一个临时剧情会话，并往 localStorage 预置一段对话记录（避免真的调用模型），
逐屏截图后删除临时数据。

前置（另开两个终端）：
    API_PORT=5001 python src/app.py
    cd frontend && npx vite --config vite.config.shot.ts

用法：
    python scripts/shot_chat_ui.py                 # 截图到 .tmp/shots-chat/
    python scripts/shot_chat_ui.py --keep          # 结束后保留临时会话与世界书
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

BOOK_NAME = "截图临时书 · 数值字段"
SESSION_NAME = "舞台截图 · 长夜临光"
ROSTER = ["临光", "瑕光", "砾"]
STAT_FIELDS = [
    {"key": "hp", "label": "体力", "type": "number", "min": 0, "max": 100, "default": 100, "group": "状态"},
    {"key": "morale", "label": "士气", "type": "number", "min": 0, "max": 10, "default": 5, "group": "状态"},
    {"key": "gold", "label": "龙门币", "type": "number", "default": 0, "group": "资产"},
    {"key": "mood", "label": "心情", "type": "select", "options": ["平静", "警惕", "愤怒", "愉快"], "group": "状态"},
    {"key": "wounded", "label": "负伤", "type": "bool"},
    {"key": "note", "label": "备注", "type": "text", "description": "叙述时提醒模型的一句话"},
]

MESSAGES = [
    {"role": "system", "content": "【场景记录】\n临光加入了场景\n瑕光加入了场景\n砾加入了场景"},
    {"role": "narrator", "round": 1,
     "content": "特锦赛开幕日的卡瓦莱利亚基，旗幡招展，夏蝉在赛道外的栎树上鸣叫。临光收紧了手甲的搭扣，目光越过人群落在竞技场的穹顶上。「他们来了。」瑕光站在她身侧，握着盾的手指发白：「姐姐，我可以的。」砾靠在廊柱边，只是短促地点了点头。",
     "variants": ["特锦赛开幕日的卡瓦莱利亚基……"], "variantIndex": 0,
     "dialogueSegments": [
         {"type": "narration", "text": "特锦赛开幕日的卡瓦莱利亚基，旗幡招展，夏蝉在赛道外的栎树上鸣叫。临光收紧了手甲的搭扣，目光越过人群落在竞技场的穹顶上。"},
         {"type": "dialogue", "text": "他们来了。", "speaker": "临光"},
         {"type": "narration", "text": "瑕光站在她身侧，握着盾的手指发白："},
         {"type": "dialogue", "text": "姐姐，我可以的。", "speaker": "瑕光"},
         {"type": "narration", "text": "砾靠在廊柱边，只是短促地点了点头。"},
     ],
     "usage": {"prompt_tokens": 2310, "completion_tokens": 186, "total_tokens": 2496}},
    {"role": "user", "content": "我走到临光身边，低声问她商业联合会的人是否已经到场。", "round": 1},
    {"role": "narrator", "round": 2,
     "content": "临光没有立刻回答。她侧过脸，金色的马耳微微一动，像是在捕捉人群里某个方向的动静。「在贵宾席。」她说，「戴着白手套的那位，是他们的谈判代表。」瑕光顺着她的目光望去，随即压低声音：「博士，那个人昨天来过驻地。」",
     "variants": ["临光没有立刻回答……"], "variantIndex": 0,
     "dialogueSegments": [
         {"type": "narration", "text": "临光没有立刻回答。她侧过脸，金色的马耳微微一动，像是在捕捉人群里某个方向的动静。"},
         {"type": "dialogue", "text": "在贵宾席。", "speaker": "临光"},
         {"type": "narration", "text": "她说，"},
         {"type": "dialogue", "text": "戴着白手套的那位，是他们的谈判代表。", "speaker": "临光"},
         {"type": "narration", "text": "瑕光顺着她的目光望去，随即压低声音："},
         {"type": "dialogue", "text": "博士，那个人昨天来过驻地。", "speaker": "瑕光"},
     ],
     "usage": {"prompt_tokens": 2588, "completion_tokens": 172, "total_tokens": 2760}},
    {"role": "system", "content": "— 请选择 —", "round": 2,
     "branches": [
         {"id": "b1", "label": "先去贵宾席探探口风", "intent": "外交", "source": "llm"},
         {"id": "b2", "label": "留在后台陪瑕光做赛前准备", "intent": "支持", "source": "llm"},
         {"id": "b3", "label": "让砾去查那位代表的底细", "intent": "调查", "source": "author"},
     ]},
]


def api_call(api, path, method="GET", body=None):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(api + path, method=method, data=data,
                                 headers={"Content-Type": "application/json"})
    try:
        with opener.open(req, timeout=20) as r:
            raw = r.read().decode("utf-8")
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.code, None


def set_theme(page, cls):
    page.evaluate(
        "(cls) => { const r = document.documentElement; r.classList.remove('light','skin-prts','skin-tavern'); if (cls) r.classList.add(cls); }",
        cls,
    )
    page.wait_for_timeout(400)


def setup(api):
    status, res = api_call(api, "/api/worldbook", "POST", {"name": BOOK_NAME})
    assert status == 201, f"建临时书失败 {status} {res}"
    book_id = res["book"]["id"]
    status, res = api_call(api, f"/api/worldbook/{book_id}", "PUT", {"stat_fields": STAT_FIELDS})
    assert status == 200, f"写数值字段失败 {status} {res}"
    status, res = api_call(api, "/api/sessions", "POST", {
        "mode": "story", "name": SESSION_NAME, "plot_id": "near_light", "combat_mode": "narrative",
        "identity": "博士", "worldbook_id": book_id, "roster_character_ids": ROSTER,
    })
    assert status == 201, f"建临时会话失败 {status} {res}"
    session_id = res["id"]
    for name, values in (
        ("临光", {"hp": 72, "morale": 8, "gold": 120, "mood": "警惕", "note": "左臂旧伤未愈"}),
        ("瑕光", {"hp": 95, "morale": 6, "mood": "平静"}),
        ("博士", {"gold": 340, "mood": "平静"}),
    ):
        status, res = api_call(api, f"/api/sessions/{session_id}/character-stats/{quote(name)}", "PUT", {"values": values})
        assert status == 200, f"写会话数值失败 {name} {status} {res}"
    status, res = api_call(api, f"/api/sessions/{session_id}/plugin-data/session-notes", "PUT",
                           {"data": {"text": "答应过瑕光去看她的比赛；\n临光的剑还没修好——找砾问问红松骑士团的铁匠。"}})
    assert status == 200, f"写插件数据失败 {status} {res}"
    return book_id, session_id


def teardown(api, book_id, session_id):
    if session_id:
        api_call(api, f"/api/sessions/{session_id}", "DELETE")
    if book_id:
        api_call(api, f"/api/worldbook/{book_id}", "DELETE")


def run(base, api, out, keep):
    os.makedirs(out, exist_ok=True)
    shots = []
    book_id, session_id = setup(api)
    errors = []

    def shot(page, name):
        path = os.path.join(out, f"{name}.png")
        page.screenshot(path=path)
        shots.append(path)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=["--proxy-server=direct://", "--proxy-bypass-list=*"])
            page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(base, wait_until="domcontentloaded", timeout=30000)
            # 预置对话记录：ChatPanel 优先读 localStorage，不会去调模型；面板默认展开、布局默认记录
            page.evaluate(
                "([key, msgs]) => { localStorage.setItem(key, msgs); localStorage.setItem('ark_chat_layout','log'); localStorage.setItem('ark_scene_panel_open','1'); localStorage.setItem('ark_scene_panel_tab','characters'); }",
                [f"ark_chat_story_{session_id}", json.dumps(MESSAGES, ensure_ascii=False)],
            )
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector(".home-splash", timeout=15000)
            page.click(".home-splash")
            page.wait_for_selector(".home-menu-stage.entered", timeout=10000)
            page.wait_for_timeout(1200)
            page.locator(".home-menu-item", has_text="会话大厅").first.click()
            card = page.locator(".session-card", has_text=SESSION_NAME).first
            card.wait_for(timeout=20000)
            card.click()
            page.wait_for_timeout(500)
            enter = page.locator('button[title="进入对话"]').first
            if enter.count() and enter.is_visible():
                enter.click()
            else:
                page.locator(".btn-hero", has_text="进入").first.click()
            page.wait_for_selector(".chat-view", timeout=15000)
            page.wait_for_selector(".chat-msg", timeout=15000)
            page.wait_for_timeout(1500)
            shot(page, "01-chat-log")

            # 舞台模式：首句 → 推进到台词（说话人高亮）→ 推进到末尾（选项）
            page.get_by_role("button", name=re.compile("舞台")).first.click()
            page.wait_for_selector(".stage", timeout=10000)
            page.wait_for_timeout(2500)
            shot(page, "02-stage-first")
            dialog = page.locator(".stage-dialog").first
            dialog.click(); page.wait_for_timeout(500)
            dialog.click(); page.wait_for_timeout(1800)
            shot(page, "03-stage-dialogue-highlight")
            for _ in range(8):
                dialog.click(); page.wait_for_timeout(250)
            page.wait_for_timeout(1500)
            shot(page, "04-stage-choices")
            page.locator(".stage-tools button", has_text="记录").click()
            page.wait_for_selector(".stage-log-overlay", timeout=5000)
            page.wait_for_timeout(600)
            shot(page, "05-stage-log-overlay")
            page.locator(".stage-log-head button").click()
            page.wait_for_timeout(300)

            # 场景面板：数值 / 资源 / 笔记（示例插件）/ 环境
            rail = page.locator(".scene-rail")
            rail.locator('button[aria-label="数值"]').click()
            page.wait_for_selector(".stat-char", timeout=10000)
            page.wait_for_timeout(800)
            shot(page, "06-panel-stats")
            rail.locator('button[aria-label="资源"]').click()
            page.wait_for_timeout(1500)
            shot(page, "07-panel-resources")
            rail.locator('button[aria-label="笔记"]').click()
            page.wait_for_timeout(800)
            shot(page, "08-panel-notes-plugin")
            rail.locator('button[aria-label="环境"]').click()
            page.wait_for_timeout(800)
            shot(page, "09-panel-environment")

            # 收起面板：全屏沉浸
            page.get_by_role("button", name=re.compile("收起面板")).first.click()
            page.wait_for_timeout(600)
            shot(page, "10-stage-collapsed")
            page.get_by_role("button", name=re.compile("场景面板")).first.click()
            page.wait_for_timeout(400)
            rail.locator('button[aria-label="角色"]').click()
            page.wait_for_timeout(400)

            # 主题变体
            set_theme(page, "light"); shot(page, "11-stage-light")
            page.get_by_role("button", name=re.compile("记录")).first.click()
            page.wait_for_selector(".chat-log", timeout=5000)
            page.wait_for_timeout(500)
            set_theme(page, "skin-prts"); shot(page, "12-log-prts")
            set_theme(page, "skin-tavern"); shot(page, "13-log-tavern")
            set_theme(page, "light"); shot(page, "14-log-light")
            set_theme(page, None)

            # 角色页：数值 / 资产 / 卡牌 页签
            page.get_by_role("button", name=re.compile("返回大厅")).first.click()
            page.wait_for_timeout(500)
            page.locator("header nav button", has_text="角色").first.click()
            row = page.locator("div.w-72 button", has_text="临光").first
            row.wait_for(timeout=15000)
            row.click()
            page.wait_for_selector(".roles-detail-tabs", timeout=10000)
            page.wait_for_timeout(600)
            tabs = page.locator(".roles-detail-tabs")
            tabs.locator("button", has_text="数值").click()
            page.wait_for_timeout(1200)
            shot(page, "15-character-stats-tab")
            tabs.locator("button", has_text="资产").click()
            page.wait_for_timeout(2000)
            shot(page, "16-character-assets-tab")
            tabs.locator("button", has_text="卡牌").click()
            page.wait_for_timeout(2000)
            shot(page, "17-character-cards-tab")

            # 世界书：数值字段编辑器
            page.locator("header nav button", has_text="世界书").first.click()
            shelf = page.locator("button", has_text=BOOK_NAME).first
            shelf.wait_for(timeout=15000)
            shelf.click()
            page.wait_for_timeout(1000)
            page.locator(".wber-hero-actions button", has_text="数值字段").click()
            page.wait_for_selector(".wber-sf-card", timeout=5000)
            page.wait_for_timeout(500)
            shot(page, "18-worldbook-stat-fields")

            browser.close()
    finally:
        if not keep:
            teardown(api, book_id, session_id)

    for path in shots:
        print("shot:", path)
    print("temp data:", "kept" if keep else "removed", json.dumps({"book": book_id, "session": session_id}))
    print("page errors:", json.dumps(errors, ensure_ascii=False) if errors else "none")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="对话页截图验证")
    parser.add_argument("--base", default="http://localhost:5174/")
    parser.add_argument("--api", default="http://127.0.0.1:5001")
    parser.add_argument("--out", default=os.path.join(REPO, ".tmp", "shots-chat"))
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    sys.exit(run(args.base, args.api, args.out, args.keep))
