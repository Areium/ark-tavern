"""回归测试：战斗结束后 idle 超时不应导致 combat/complete 404。

Bug 背景：战斗结束后玩家停留在结算界面，若距最后一次操作超过 600s，
携带超时检查的请求（combat/state 等）会把 session.combat 清掉；
之后玩家点"返回对话"触发 complete → 404 → 前端弹"战斗结果保存失败"
且不重试成功，玩家被永久卡在战斗界面。
"""
import sys
import time
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import pytest

from app import create_app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import app as app_module
    import data_paths
    import world_book
    import session_manager
    import session_overlay
    import combat_resume
    from document_manager import DocumentManager
    from wiki_manager import WikiManager

    monkeypatch.setattr(data_paths, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(world_book, "_WORLDBOOKS_DIR", tmp_path / "data" / "worldbooks")
    monkeypatch.setattr(session_manager, "_SESSIONS_DIR", tmp_path / "sessions")
    monkeypatch.setattr(session_overlay, "_SESSIONS_DIR", tmp_path / "sessions")
    monkeypatch.setattr(combat_resume, "TEST_RESUME_DIR", tmp_path / "resumes")
    monkeypatch.setattr(app_module, "DocumentManager", lambda: DocumentManager(str(tmp_path)))
    monkeypatch.setattr(app_module, "WikiManager", lambda: WikiManager(str(tmp_path)))
    data = tmp_path / "data"
    data.mkdir()
    (data / "categories.yaml").write_text(
        "categories:\n  characters: characters/\n  enemies: enemies/\n", encoding="utf-8")
    manager = world_book.WorldBookManager(data / "worldbooks")
    manager.save(world_book.WorldBook("timeout_test", "Timeout test", []))
    folder = data / "worldbooks" / "books" / "timeout_test"
    actor = folder / "characters" / "Hero"
    actor.mkdir(parents=True)
    (actor / "index.md").write_text(
        "---\nname: Hero\nclass: 近卫\ncombat_stats:\n  hp: 80\n  patk: 12\n---\n",
        encoding="utf-8")
    enemies = folder / "enemies"
    enemies.mkdir()
    (enemies / "Dummy.md").write_text(
        "---\nname: Dummy\nclass: 近卫\ncombat_stats:\n  hp: 40\n  patk: 8\n---\n",
        encoding="utf-8")
    nodes = folder / "combat" / "nodes"
    nodes.mkdir(parents=True)
    (nodes / "enc_quick_test_1.json").write_text(json.dumps({
        "schema_version": 1, "node_id": "enc_quick_test_1", "name": "Timeout test",
        "rules": {"range_metric": "manhattan", "allow_corner_cut": False},
        "map": {"rows": 5, "cols": 5, "tiles": "ground", "deploy": {
            "player": {"rect": [0, 0, 4, 0]}, "enemy": {"rect": [0, 4, 4, 4]}}},
        "waves": [{"enemies": [{"enemy": "Dummy", "count": 1,
                                  "positions": [[2, 4]]}]}],
        "conditions": {"max_rounds": 6}, "rewards": {"xp": 0, "items": []},
        "difficulty": {"category": "test", "encounter_type": "normal", "band": "T1"},
    }), encoding="utf-8")
    app = create_app()
    return app, app.test_client()


def _start_combat(app, client):
    r = client.post("/api/sessions", json={"mode": "free", "combat_mode": "tactical",
                                            "worldbook_ids": ["timeout_test"]})
    sid = r.get_json()["id"]
    client.post(f"/api/sessions/{sid}/characters/load", json={"character": "Hero"})
    r = client.post(f"/api/sessions/{sid}/combat/start", json={"encounter_id": "enc_quick_test_1"})
    assert r.status_code == 200 and r.get_json().get("state"), r.get_json()
    return sid


def _force_player_win(app, sid):
    session = app._managers["session"].get_session(sid)
    eng = session.combat.engine
    for u in eng.units.values():
        if u.team == "enemy":
            u.hp = 0
    eng.state.winner = "player"
    eng.state.phase = "END"
    return session


def _complete(client, sid):
    return client.post(f"/api/sessions/{sid}/combat/complete", json={
        "encounter_id": "enc_quick_test_1",
        "winner": "player",
        "survivors": ["Hero"],
        "rounds": 1,
        "character_stats": {},
    })


def test_battle_over_immune_to_idle_timeout(client):
    """战斗已结束：idle 超时后 combat/state 不清理，complete 正常回写。"""
    app, c = client
    sid = _start_combat(app, c)
    session = _force_player_win(app, sid)

    # 模拟玩家在结算界面停留超过 600s
    session.combat.last_activity_at = time.time() - 601

    r = c.get(f"/api/sessions/{sid}/combat/state")
    assert r.status_code == 200, r.get_json()
    assert session.combat is not None, "已结束的战斗不应被超时清理"

    r = _complete(c, sid)
    assert r.status_code == 200, r.get_json()
    body = r.get_json()
    assert body["auto_narrate_action"]
    assert session.combat is None, "complete 后应清理战斗状态"


def test_ongoing_battle_still_times_out(client):
    """回归保护：战斗进行中 idle 超时仍应被清理（410）。"""
    app, c = client
    sid = _start_combat(app, c)
    session = app._managers["session"].get_session(sid)
    assert not session.combat.engine.is_battle_over()

    session.combat.last_activity_at = time.time() - 601

    r = c.get(f"/api/sessions/{sid}/combat/state")
    assert r.status_code == 410
    assert session.combat is None
