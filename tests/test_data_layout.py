"""Integration checks for the worldbook-centred data layout.

These tests read shipped content and use temporary roots for generators/audits.
They never call an LLM or rewrite the installed ``arknights`` worldbook.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import frontmatter
import pytest
from flask import Flask

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))


class _NoSessions:
    def get_session(self, _session_id):
        return None

    def list_sessions(self):
        return []


@pytest.fixture(scope="module")
def content_client():
    """Register read routes without constructing the runtime worldbook manager."""
    from document_manager import DocumentManager
    from wiki_manager import WikiManager
    from blueprints import (
        assets, cards, combat_nodes as combat_nodes_bp, documents,
        environment, scene, sessions, wiki,
    )

    app = Flask(__name__)
    managers = {
        "document": DocumentManager(str(ROOT)),
        "wiki": WikiManager(str(ROOT)),
        "session": _NoSessions(),
        "worldbook": None,
        "llm_backend": SimpleNamespace(get_llm=lambda: (None, None)),
    }
    for register in (
        documents.register, wiki.register, assets.register, scene.register,
        cards.register, environment.register, sessions.register,
        combat_nodes_bp.register,
    ):
        register(app, managers)
    app.config.update(TESTING=True)
    return app.test_client()


@pytest.mark.parametrize(
    ("category", "doc_id", "expected"),
    [
        ("characters", "博士", "博士"),
        ("classes", "先锋", "先锋"),
        ("enemies", "整合运动士兵", "整合运动士兵"),
        ("items", "急救包", "急救包"),
        ("locations", "Kjerag/雪山大典广场", "雪山大典广场"),
        ("plots", "near-light", "长夜临光"),
    ],
)
def test_document_and_wiki_read_shipped_content(content_client, category, doc_id, expected):
    response = content_client.get(f"/api/documents/{category}/{doc_id}")
    assert response.status_code == 200, response.get_json()
    assert expected in json.dumps(response.get_json(), ensure_ascii=False)

    response = content_client.get("/api/wiki/query", query_string={"q": f"{category}/{doc_id}"})
    assert response.status_code == 200, response.get_json()
    assert expected in response.get_json()["result"]


def test_runtime_content_apis_read_new_paths(content_client):
    character = content_client.get("/api/characters/博士")
    assert character.status_code == 200
    assert character.get_json()["metadata"]["name"] == "博士"

    cards = content_client.get("/api/cards/classes/先锋")
    assert cards.status_code == 200
    assert cards.get_json()["class_name"] == "先锋"
    assert cards.get_json()["cards"]

    item = content_client.get("/api/items/急救包")
    assert item.status_code == 200
    assert item.get_json()["metadata"]["name"] == "急救包"

    presets = content_client.get("/api/environment/presets")
    assert presets.status_code == 200
    preset_data = presets.get_json()
    assert any(row["name"] == "雪山大典广场" for row in preset_data["locations"])
    assert any(row["id"] == "sunny" for row in preset_data["weathers"])
    assert preset_data["times"] == ["清晨", "上午", "中午", "下午", "傍晚", "夜晚", "深夜"]

    plots = content_client.get("/api/plots")
    assert plots.status_code == 200
    assert "near_light" in {row["id"] for row in plots.get_json()}
    from session_overlay import _resolve_plot_dir
    assert _resolve_plot_dir("near_light") == "near-light"

    node = content_client.get("/api/combat/nodes/enc_training")
    assert node.status_code == 200, node.get_json()
    assert node.get_json()["node"]["node_id"] == "enc_training"


def test_flat_markdown_crud_hash_and_entity_precedence(tmp_path):
    from document_manager import ConflictError, DocumentManager

    items = tmp_path / "data" / "worldbooks" / "content" / "items"
    items.mkdir(parents=True)
    (tmp_path / "data" / "categories.yaml").write_text(
        "categories:\n  items: data/worldbooks/content/items/\nhierarchy:\n  levels: []\n",
        encoding="utf-8",
    )
    flat = items / "flat.md"
    flat.write_text("---\nname: Flat\n---\noriginal\n", encoding="utf-8")
    asset = items / "flat.png"
    asset.write_bytes(b"asset")
    sibling = items / "sibling.md"
    sibling.write_text("sibling", encoding="utf-8")

    # If both representations exist, the entity index remains authoritative.
    (items / "same.md").write_text("flat duplicate", encoding="utf-8")
    entity = items / "same"
    entity.mkdir()
    (entity / "index.md").write_text("---\nname: Entity\n---\nentity body\n", encoding="utf-8")

    manager = DocumentManager(str(tmp_path))
    assert manager.read_document("items", "same")["content"].strip() == "entity body"

    original = manager.read_document("items", "flat")
    saved = manager.save_document(
        "items", "flat", "saved body\n", expected_hash=original["hash"],
    )
    assert manager.read_document("items", "flat")["content"].strip() == "saved body"

    flat.write_text("external edit", encoding="utf-8")
    with pytest.raises(ConflictError):
        manager.save_document(
            "items", "flat", "must not overwrite", expected_hash=saved["hash"],
        )
    assert flat.read_text(encoding="utf-8") == "external edit"

    manager.delete_document("items", "flat")
    assert not flat.exists()
    assert asset.read_bytes() == b"asset"
    assert sibling.is_file()
    assert (entity / "index.md").is_file()


@pytest.mark.parametrize(
    "url",
    [
        "/api/assets/characters/博士/avatar/npc_001_doctor.png",
        "/api/characters/博士/avatar",
        "/api/assets/audio/bgm/menu_1.mp3",
        "/api/assets/combat_backgrounds/default/bg.jpg",
    ],
)
def test_existing_asset_urls_serve_files_from_content_root(content_client, url):
    response = content_client.get(url)
    assert response.status_code == 200, url
    assert response.data


def test_scene_prompt_uses_real_book_nodes_refreshes_and_never_invents(tmp_path, monkeypatch):
    import combat_nodes
    from SceneManager import SceneManager

    node_dir = tmp_path / "nodes"
    plot_dir = tmp_path / "plots"
    node_dir.mkdir()
    plot_dir.mkdir()
    monkeypatch.setattr(combat_nodes, "NODE_DIR", node_dir)
    monkeypatch.setattr(combat_nodes, "PLOT_DIR", plot_dir)

    node_path = node_dir / "enc_live.json"
    node_path.write_text(json.dumps({
        "node_id": "enc_live", "name": "初版", "worldbook_id": "book-a",
    }, ensure_ascii=False), encoding="utf-8")

    manager = SimpleNamespace(resolve=lambda _overlay: SimpleNamespace(id="book-a"))
    scene_manager = SceneManager(
        None, None, combat_mode="tactical", worldbook_manager=manager,
    )
    first = scene_manager._build_extraction_messages("敌人拔刀冲来")[-1]["content"]
    assert "enc_live（初版）" in first

    # A hand-edited/imported valid node may have no _hash; it must still be offered.
    node_path.write_text(json.dumps({
        "node_id": "enc_live", "name": "编辑后", "worldbook_id": "book-a",
    }, ensure_ascii=False), encoding="utf-8")
    refreshed = scene_manager._build_extraction_messages("敌人拔刀冲来")[-1]["content"]
    assert "enc_live（编辑后）" in refreshed
    assert "初版" not in refreshed

    manager.resolve = lambda _overlay: SimpleNamespace(id="empty-book")
    empty = scene_manager._build_extraction_messages("敌人拔刀冲来")[-1]["content"]
    assert "可用遭遇：（无可用战斗节点）" in empty
    assert "初遇整合运动" not in empty


def test_background_tool_reads_json_node_references(tmp_path, monkeypatch):
    import tools.generate_combat_backgrounds as backgrounds

    nodes = tmp_path / "nodes"
    locations = tmp_path / "locations"
    nodes.mkdir()
    locations.mkdir()
    (nodes / "enc_json.json").write_text(
        json.dumps({"node_id": "enc_json", "background": "json_bg"}),
        encoding="utf-8",
    )
    (nodes / "broken.json").write_text("not json", encoding="utf-8")
    location = locations / "region" / "place"
    location.mkdir(parents=True)
    (location / "index.md").write_text(
        "---\nname: Test\ncombat_bg: location_bg\n---\n", encoding="utf-8",
    )
    monkeypatch.setattr(backgrounds, "_NODE_ROOT", nodes)
    monkeypatch.setattr(backgrounds, "_LOC_ROOT", locations)

    assert backgrounds._referenced_bg_ids() == {
        "json_bg": "node:enc_json",
        "location_bg": f"location:{location / 'index.md'}",
    }


def test_builtin_generator_reads_weather_and_factions_into_temp_pack(tmp_path, monkeypatch):
    import generate_builtin_worldbook as generator

    content = tmp_path / "data" / "worldbooks" / "content"
    weather = content / "environment" / "weather" / "sunny"
    faction = content / "factions" / "罗德岛"
    weather.mkdir(parents=True)
    faction.mkdir(parents=True)
    (weather / "index.md").write_text(
        "---\nname: 晴天\nsummary: 天气晴朗\n---\n\n晴朗正文。\n", encoding="utf-8",
    )
    (faction / "index.md").write_text(
        "---\nname: 罗德岛\nsummary: 医疗组织\n---\n\n势力正文。\n", encoding="utf-8",
    )
    output = tmp_path / "generated" / "arknights.json"
    monkeypatch.setattr(generator, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(generator, "OUT", output)

    generator.main()

    book = json.loads(output.read_text(encoding="utf-8"))
    assert {(entry["group"], entry["trigger_keys"][0]) for entry in book["entries"]} == {
        ("天气", "晴天"), ("势力", "罗德岛"),
    }
    assert "晴朗正文" in next(e["content"] for e in book["entries"] if e["group"] == "天气")
    assert "势力正文" in next(e["content"] for e in book["entries"] if e["group"] == "势力")


def test_story_audit_loads_candidate_plot_only_from_temp_root():
    from story_audit_support import candidate_app, create_story

    assert not (ROOT / "data" / "worldbooks" / "content" / "plots" / "qa_greybridge_echoes").exists()
    with candidate_app() as ctx:
        temp_plot = (
            ctx["root"] / "data" / "worldbooks" / "content" / "plots"
            / ctx["manifest"]["plot_id"] / "index.md"
        )
        assert temp_plot.is_file()
        plots = ctx["client"].get("/api/plots")
        assert plots.status_code == 200
        assert ctx["manifest"]["plot_id"] in {row["id"] for row in plots.get_json()}
        session = create_story(ctx, roster=[])
        assert session.overlay.get_current_beat_id() == ctx["manifest"]["beats"][0]
        import session_overlay
        assert Path(session_overlay._PROJECT_ROOT).resolve() == ctx["root"].resolve()
        assert session_overlay._resolve_plot_dir(ctx["manifest"]["plot_id"]) == ctx["manifest"]["plot_id"]


def test_story_audit_uses_temp_character_cards_environment_and_rules():
    from story_audit_support import candidate_app, create_story

    with candidate_app() as ctx:
        content = ctx["root"] / "data" / "worldbooks" / "content"

        character_path = content / "characters" / "阿米娅" / "index.md"
        character = frontmatter.load(character_path)
        character.metadata["summary"] = "TEMP_ROOT_CHARACTER_SENTINEL"
        character_path.write_text(frontmatter.dumps(character), encoding="utf-8")

        cards_path = content / "classes" / "先锋" / "cards.json"
        cards = json.loads(cards_path.read_text(encoding="utf-8"))
        cards["cards"][0]["name"] = "TEMP_ROOT_CARD_SENTINEL"
        cards_path.write_text(json.dumps(cards, ensure_ascii=False), encoding="utf-8")

        weather_path = content / "environment" / "weather" / "sunny" / "index.md"
        weather = frontmatter.load(weather_path)
        weather.content += "\n\nTEMP_ROOT_WEATHER_SENTINEL\n"
        weather_path.write_text(frontmatter.dumps(weather), encoding="utf-8")

        rules_path = content / "combat" / "rules" / "difficulty.json"
        rules = json.loads(rules_path.read_text(encoding="utf-8"))
        rules["audit_sentinel"] = "TEMP_ROOT_RULES_SENTINEL"
        rules_path.write_text(json.dumps(rules, ensure_ascii=False), encoding="utf-8")

        session = create_story(ctx, roster=["阿米娅"])
        assert session.scene_manager._agents["阿米娅"].metadata["summary"] == "TEMP_ROOT_CHARACTER_SENTINEL"
        assert Path(session.environment.data_dir).resolve() == (content / "environment").resolve()
        assert (ctx["root"] / "data" / "memory" / "chroma.sqlite3").is_file()

        api_cards = ctx["client"].get("/api/cards/classes/先锋")
        assert api_cards.status_code == 200
        assert api_cards.get_json()["cards"][0]["name"] == "TEMP_ROOT_CARD_SENTINEL"

        from combat_engine.card_json_loader import clear_cache, load_class_cards
        clear_cache()
        assert load_class_cards("先锋")[0].name == "TEMP_ROOT_CARD_SENTINEL"

        from combat_rules import difficulty_rules
        assert difficulty_rules()["audit_sentinel"] == "TEMP_ROOT_RULES_SENTINEL"

        from environment_state import EnvironmentState
        env = EnvironmentState()
        assert env.load_weather("sunny") is True
        assert "TEMP_ROOT_WEATHER_SENTINEL" in env.weather_desc
