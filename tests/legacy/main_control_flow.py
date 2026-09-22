# -*- coding: utf-8 -*-
"""主控角色 = 玩家身份 + 入队角色：端到端验收（真实应用 + 真实角色库/世界书数据）。

复现前端向导「主控与阵容」这一步实际发出的两个请求，两条路径各走一遍：

1. **自建角色主控**：`/api/characters` 里 `worldbook_id` 为空的角色；
2. **世界书角色主控**：`worldbook_id` 非空的角色（随书导入）。

请求顺序与 `CreateSessionWizard.handleCreate` 一致：
    预览（roster = 主控 + 队友）→ 拿 draft_hash → 创建（identity = 主控，roster = 队友）
因此本脚本同时守住「预览与创建必须一致」这条契约：指纹不匹配时创建会 400。

断言：主控是玩家身份、主控进阵容、主控**不进**场景角色（NPC）、同一角色不重复出现、
未选主控（显式空 identity）被拒绝。结束后删除本次创建的会话。
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "src"))

FAILURES = []
created_sessions = []


def check(label, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + label + (f"  {detail}" if detail else ""))
    if not ok:
        FAILURES.append(label)


def main():
    from app import create_app

    app = create_app()
    client = app.test_client()

    characters = client.get("/api/characters").get_json() or []
    # 书列表端点是单数 /api/worldbook（前端 useApi.listWorldbooks 同源）
    books = (client.get("/api/worldbook").get_json() or {}).get("books") or []
    own = [c for c in characters if not (c.get("worldbook_id") or "").strip()]
    from_book = [c for c in characters if (c.get("worldbook_id") or "").strip()]
    check("角色库里有自建角色", bool(own), f"{len(own)} 名候选")
    check("角色库里有世界书角色", bool(from_book), f"{len(from_book)} 名候选")
    if not own or not from_book or len(characters) < 2:
        print("角色库数据不足，无法验收（需要至少 1 个自建 + 1 个世界书角色）")
        return 1

    teammate = next(c for c in characters
                    if c["id"] not in {own[0]["id"], from_book[0]["id"]})
    book_id = books[0]["id"] if books else ""

    # ── 未选主控：显式空 identity → 拒绝 ──
    rejected = client.post("/api/sessions", json={
        "mode": "free", "worldbook_id": book_id, "identity": "",
        "roster_character_ids": [teammate["id"]],
    })
    check("显式空主控被拒绝", rejected.status_code == 400,
          f"status={rejected.status_code} body={rejected.get_json()}")
    check("拒绝信息可读", "必须选择主控角色" in (rejected.get_json() or {}).get("error", ""))

    for label, main_control in (("自建", own[0]), ("世界书", from_book[0])):
        mc_id, mate_id = main_control["id"], teammate["id"]
        # 1) 预览：阵容 = 主控 + 队友（与向导 useRosterScopePreview 同参数）
        preview = client.post(f"/api/worldbook/{book_id}/scope-preview", json={
            "roster_character_ids": [mc_id, mate_id],
        }) if book_id else None
        draft_hash = (preview.get_json() or {}).get("draft_hash", "") if preview else ""
        if book_id:
            check(f"[{label}主控] 候选范围预览可用", preview.status_code == 200,
                  f"status={preview.status_code}")

        # 2) 创建：identity = 主控，roster = 队友（主控不走第二条入队路径）
        resp = client.post("/api/sessions", json={
            "mode": "free", "name": f"验收-{label}主控", "combat_mode": "narrative",
            "identity": mc_id, "worldbook_id": book_id,
            "roster_character_ids": [mate_id],
            "expected_draft_hash": draft_hash,
        })
        check(f"[{label}主控] 创建成功", resp.status_code == 201,
              "" if resp.status_code == 201 else f"status={resp.status_code} body={resp.get_json()}")
        if resp.status_code != 201:
            continue
        body = resp.get_json()
        created_sessions.append(body["id"])

        check(f"[{label}主控] 主控即玩家身份", body["player_identity"] == mc_id)
        check(f"[{label}主控] 主控在阵容里", body["roster"] == [mc_id, mate_id],
              f"roster={body['roster']}")
        check(f"[{label}主控] 主控不是场景 NPC（模型不替玩家说话）",
              body["characters"] == [mate_id], f"characters={body['characters']}")
        check(f"[{label}主控] 阵容无重复条目", len(body["roster"]) == len(set(body["roster"])))
        scope = body.get("worldbook_scope") or {}
        if book_id:
            check(f"[{label}主控] 主控计入候选范围阵容",
                  mc_id in (scope.get("roster_character_ids") or []),
                  f"roster_ids={scope.get('roster_character_ids')}")

        # 3) 同一个角色同时是主控又写进入队名单：仍然只有一条
        again = client.post("/api/sessions", json={
            "mode": "free", "name": f"验收-{label}主控-重复", "identity": mc_id,
            "worldbook_id": book_id,
            "roster_character_ids": [mc_id, mate_id, mc_id],
        })
        check(f"[{label}主控] 身份+入队同名单不重复", again.status_code == 201
              and again.get_json()["roster"] == [mc_id, mate_id],
              f"status={again.status_code} roster={(again.get_json() or {}).get('roster')}")
        if again.status_code == 201:
            created_sessions.append(again.get_json()["id"])

    # ── 清理 ──
    for sid in created_sessions:
        client.delete(f"/api/sessions/{sid}")
    leftovers = [s for s in (client.get("/api/sessions").get_json() or [])
                 if s["id"] in created_sessions]
    check("验收会话已清理", not leftovers, f"leftovers={[s['id'] for s in leftovers]}")

    print("全部通过" if not FAILURES else f"存在失败项: {FAILURES}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
