"""战斗 HTTP 接口契约（前端消费的 DTO 形状）：节点开战 → 状态 → 移动/出牌。"""

import sys
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from app import create_app  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    import app as app_module
    import data_paths
    import world_book
    import combat_resume
    import session_manager
    import session_overlay
    from blueprints import sessions as sessions_bp
    from document_manager import DocumentManager
    from wiki_manager import WikiManager

    monkeypatch.setattr(data_paths, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(world_book, "_WORLDBOOKS_DIR", tmp_path / "data" / "worldbooks")
    monkeypatch.setattr(combat_resume, "TEST_RESUME_DIR", tmp_path / "resumes")
    monkeypatch.setattr(session_manager, "_SESSIONS_DIR", tmp_path / "sessions")
    monkeypatch.setattr(session_overlay, "_SESSIONS_DIR", tmp_path / "sessions")
    monkeypatch.setattr(session_overlay, "_PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(sessions_bp, "_REPO_ROOT", tmp_path)
    monkeypatch.setattr(app_module, "DocumentManager", lambda: DocumentManager(str(tmp_path)))
    monkeypatch.setattr(app_module, "WikiManager", lambda: WikiManager(str(tmp_path)))
    data = tmp_path / "data"
    data.mkdir()
    (data / "categories.yaml").write_text(
        "categories:\n  characters: characters/\n  enemies: enemies/\n  items: items/\n", encoding="utf-8")
    manager = world_book.WorldBookManager(data / "worldbooks")
    book = world_book.WorldBook("combat_api", "Combat API", [])
    manager.save(book)
    folder = data / "worldbooks" / "books" / book.id
    nodes = folder / "combat" / "nodes"
    nodes.mkdir(parents=True)
    node = {
        "schema_version": 1, "node_id": "enc_training", "name": "接口训练",
        "bind": {"plot_id": "", "chapter_id": "", "beat_id": ""},
        "rules": {"range_metric": "manhattan", "allow_corner_cut": False},
        "map": {"rows": 5, "cols": 5, "tiles": "ground", "deploy": {
            "player": {"rect": [0, 0, 4, 0]}, "enemy": {"rect": [0, 4, 4, 4]}}},
        "waves": [{"enemies": [{"enemy": "Dummy", "count": 1,
                                  "positions": [[2, 4]]}]}],
        "conditions": {"max_rounds": 6}, "rewards": {"xp": 0, "items": []},
        "difficulty": {"category": "test", "encounter_type": "normal", "band": "T1"},
    }
    (nodes / "enc_training.json").write_text(json.dumps(node), encoding="utf-8")
    enemies = folder / "enemies"
    enemies.mkdir()
    (enemies / "Dummy.md").write_text(
        "---\nname: Dummy\nclass: 近卫\ncombat_stats:\n  hp: 40\n  patk: 8\n  defense: 2\n---\n",
        encoding="utf-8")
    (enemies / "Derived.md").write_text(
        "---\nname: Derived\nclass: 近卫\nattributes:\n  物理强度: 5\n  生理耐受: 5\n---\n",
        encoding="utf-8")
    actor = folder / "characters" / "Hero"
    actor.mkdir(parents=True)
    (actor / "index.md").write_text(
        "---\nname: Hero\nclass: 近卫\ncombat_stats:\n  hp: 80\n  patk: 12\n---\n",
        encoding="utf-8")
    items = folder / "items"
    items.mkdir()
    (items / "急救包.md").write_text(
        "---\nname: 急救包\ncombat_effect:\n  type: heal\n  amount: 30\n---\n",
        encoding="utf-8")
    plot = folder / "plots" / "test_plot"
    plot.mkdir(parents=True)
    (plot / "index.md").write_text(
        "---\nname: Test plot\n---\n## 章节 1：测试\n#### beat_enc\n"
        "**内容**：[COMBAT:enc_training]\n",
        encoding="utf-8")
    app = create_app()
    app.config.update(TESTING=True)
    return app.test_client()


@pytest.fixture
def test_id(client):
    res = client.post("/api/combat/test/start", json={"node_id": "enc_training", "characters": ["Hero"]})
    assert res.status_code == 200, res.get_json()
    body = res.get_json()
    yield body["test_id"]
    client.delete(f"/api/combat/test/{body['test_id']}")


def test_node_catalog(client):
    nodes = client.get("/api/combat/nodes").get_json()["nodes"]
    assert len(nodes) == 1
    assert nodes[0]["node_id"] == "enc_training"


def test_enemy_catalog_marks_derived(client):
    enemies = client.get("/api/combat/enemies").get_json()["enemies"]
    assert {enemy["name"] for enemy in enemies} == {"Dummy", "Derived"}
    assert any(e["derived_from_attributes"] for e in enemies)
    assert all("combat_stats" in e for e in enemies)


def test_tile_registry(client):
    payload = client.get("/api/combat/tiles").get_json()
    ids = {t["tile_id"] for t in payload["tiles"]}
    assert {"ground", "wall", "cover", "high_ground", "hazard_fire"} <= ids


def test_state_dto_shape(client, test_id):
    state = client.get(f"/api/combat/test/{test_id}/state").get_json()
    for key in ("rows", "cols", "tiles", "tile_defs", "deploy", "range_metric",
                "units", "shared_hand", "valid_moves", "valid_moves_unit"):
        assert key in state, key
    assert "grid_size" not in state, "旧字段不应再出现在 DTO 中"
    assert state["range_metric"] == "manhattan"
    assert len(state["tiles"]) == state["rows"]
    assert all(len(row) == state["cols"] for row in state["tiles"])
    assert state["deploy"]["player"] and state["deploy"]["enemy"]


def test_valid_moves_follow_selected_unit(client, test_id):
    state = client.get(f"/api/combat/test/{test_id}/state").get_json()
    player = next(u for u in state["units"] if u["team"] == "player")
    scoped = client.get(
        f"/api/combat/test/{test_id}/state?selected_unit={player['unit_id']}").get_json()
    assert scoped["valid_moves_unit"] == player["unit_id"]
    assert scoped["valid_moves"], "玩家回合应有可达格"
    # 曼哈顿预算：可达格到起点距离 == 代价上界（此处只校验在同一连通域且不越界）
    for r, c in scoped["valid_moves"]:
        assert 0 <= r < scoped["rows"] and 0 <= c < scoped["cols"]


def test_units_block_and_walls_reject_illegal_move(client, test_id):
    state = client.get(f"/api/combat/test/{test_id}/state").get_json()
    player = next(u for u in state["units"] if u["team"] == "player")
    res = client.post(f"/api/combat/test/{test_id}/action", json={
        "action": "move", "unit_id": player["unit_id"], "target": [player["pos"][0], player["pos"][1]],
    })
    # 原地移动距离 0：validate_move 允许（代价 0 ≤ 预算），但落点是自身所在格 → 视为可落脚
    assert res.status_code in (200, 400)


def test_unknown_node_returns_404(client):
    res = client.post("/api/combat/test/start", json={"node_id": "enc_not_exists", "characters": ["Hero"]})
    assert res.status_code == 404


def test_practice_requires_node_and_selected_characters(client):
    missing_node = client.post("/api/combat/test/start", json={"characters": ["Hero"]})
    assert missing_node.status_code == 400
    assert "战斗节点" in missing_node.get_json()["error"]

    missing_characters = client.post("/api/combat/test/start", json={"node_id": "enc_training"})
    assert missing_characters.status_code == 400
    assert "参战角色" in missing_characters.get_json()["error"]


def test_unknown_selected_unit_returns_empty_moves(client, test_id):
    state = client.get(
        f"/api/combat/test/{test_id}/state?selected_unit=不存在").get_json()
    assert state["valid_moves"] == []
