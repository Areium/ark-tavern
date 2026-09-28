"""Session stat resolver/panel/prompt parity against isolated real book folders."""

import copy
import sys
from pathlib import Path
from types import SimpleNamespace

import frontmatter
import pytest
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import document_manager
import session_overlay
import session_stats
from SceneManager import SceneManager
from blueprints.scene import register as register_scene
from blueprints.stage import register as register_stage
from character_stats import format_stats_block
from session_overlay import SessionOverlay
from session_stats import resolve_session_character_stats
from world_book import WorldBook, WorldBookBundle, WorldBookManager


@pytest.fixture
def stats_runtime(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    (data / "categories.yaml").write_text("categories:\n  characters: characters/\n", encoding="utf-8")
    books = WorldBookManager(data / "worldbooks")
    books.save(WorldBook("first", "首本书", [], stat_fields=[
        {"key": "trust", "label": "信任", "type": "number", "default": 0, "min": 0, "max": 10},
        {"key": "known", "label": "知情", "type": "bool", "default": False},
        {"key": "energy", "label": "精力", "type": "number", "default": 10},
    ]))
    books.save(WorldBook("second", "角色书", [], stat_fields=[
        {"key": "trust", "label": "好感", "type": "number", "default": 2, "max": 50},
        {"key": "luck", "label": "幸运", "type": "number", "default": 4},
    ]))
    books.save(WorldBook("empty", "无字段书", []))

    def write_actor(book_id, name, stats=None):
        actor = data / "worldbooks" / "books" / book_id / "characters" / name
        actor.mkdir(parents=True, exist_ok=True)
        metadata = {"name": name}
        if stats is not None:
            metadata["stats"] = stats
        (actor / "index.md").write_text(frontmatter.dumps(frontmatter.Post("角色正文", **metadata)), encoding="utf-8")

    write_actor("first", "Hero", {"energy": 8})
    write_actor("first", "Default")
    write_actor("second", "Guest", {"energy": 6})
    write_actor("second", "Hero", {"energy": 99})
    docs = document_manager.DocumentManager(str(tmp_path))
    monkeypatch.setattr(document_manager, "DocumentManager", lambda: docs)
    monkeypatch.setattr(session_stats, "DocumentManager", lambda: docs)
    monkeypatch.setattr(session_overlay, "_SESSIONS_DIR", tmp_path / "sessions")
    overlay = SessionOverlay("stats", "story")
    overlay.set_worldbook_ids(["first", "second"])
    scene = SceneManager(None, None, overlay=overlay, worldbook_manager=books, player_identity="Hero")
    # Prompt resolution must not trust stale/overridden agent metadata.
    scene._agents = {
        "Default": SimpleNamespace(metadata={"stats": {"trust": 7}}),
        "Guest": SimpleNamespace(metadata={"stats": {"energy": 999}}),
    }
    session = SimpleNamespace(id="stats", overlay=overlay, scene_manager=scene,
                              combat_mode="narrative", player_identity="Hero")
    app = Flask(__name__)
    app.config["TESTING"] = True
    managers = {"session": SimpleNamespace(get_session=lambda sid: session if sid == "stats" else None),
                "worldbook": books, "document": docs}
    register_stage(app, managers)
    register_scene(app, managers)
    return SimpleNamespace(session=session, scene=scene, overlay=overlay, books=books,
                           docs=docs, client=app.test_client(), write_actor=write_actor)


def test_two_argument_resolver_merges_without_mutation(stats_runtime):
    runtime = stats_runtime
    runtime.overlay.set_character_stats("Hero", {"energy": 0, "trust": 99, "known": False, "note": "x"})
    before = copy.deepcopy(runtime.overlay.to_dict())
    stats = resolve_session_character_stats(runtime.session, "Hero")
    assert stats["values"] == {"trust": 10, "known": False, "energy": 0, "note": "x"}
    assert stats["sources"] == dict.fromkeys(stats["values"], "session")
    assert runtime.overlay.to_dict() == before
    assert runtime.docs.read_document("characters", "Hero", book_id="first")["metadata"]["stats"] == {"energy": 8}
    runtime.overlay.delete_character_stats("Hero")
    reset = resolve_session_character_stats(runtime.session, "Hero")
    assert reset["values"] == {"trust": 0, "known": False, "energy": 8}
    assert reset["sources"] == {"trust": "default", "known": "default", "energy": "global"}


def test_panel_prompt_and_resolver_share_defaults_and_precedence(stats_runtime):
    runtime = stats_runtime
    runtime.overlay.set_character_stats("Guest", {"energy": 3})
    listing = runtime.client.get("/api/sessions/stats/character-stats").json
    characters = {row["name"]: row for row in listing["characters"]}
    fields, values = runtime.scene._stats_snapshot(runtime.books.resolve(runtime.overlay))
    prompt = runtime.scene._build_stats_block(runtime.books.resolve(runtime.overlay))
    assert "Hero：信任 0/10、知情 否、精力 8" in prompt
    assert "Default：信任 0/10、知情 否、精力 10" in prompt
    assert "Guest：信任 0/10、知情 否、精力 3" in prompt
    assert "幸运" not in prompt and "999" not in prompt
    for name, row in characters.items():
        resolved = resolve_session_character_stats(runtime.session, name)
        assert values[name] == row["values"] == resolved["values"]
        assert fields[name] == row["fields"] == resolved["fields"]
        assert row["sources"] == resolved["sources"]
    context = runtime.scene._build_scene_context(runtime.books.resolve(runtime.overlay))
    assert "Default：信任 0/10、知情 否、精力 10" in context


def test_character_metadata_override_is_not_an_extra_stats_layer(stats_runtime):
    runtime = stats_runtime
    runtime.overlay.set_character_overrides("Hero", {"metadata": {"stats": {"energy": 100}}})
    assert resolve_session_character_stats(runtime.session, "Hero")["values"]["energy"] == 8
    runtime.overlay.set_character_stats("Hero", {"energy": 2})
    assert resolve_session_character_stats(runtime.session, "Hero")["values"]["energy"] == 2
    assert "Hero：信任 0/10、知情 否、精力 2" in runtime.scene._build_stats_block(None)


@pytest.mark.parametrize("first", ["empty", "missing"])
def test_empty_or_missing_first_book_never_falls_back(stats_runtime, first):
    runtime = stats_runtime
    runtime.overlay.set_worldbook_ids([first, "second"])
    stats = resolve_session_character_stats(runtime.session, "Guest")
    assert stats["worldbook_id"] == first
    assert stats["fields"] == []
    assert stats["values"] == {"energy": 6}
    assert stats["worldbook_name"] == ("无字段书" if first == "empty" else "")
    listing = runtime.client.get("/api/sessions/stats/character-stats").json
    guest = next(row for row in listing["characters"] if row["name"] == "Guest")
    assert guest["fields"] == [] and guest["values"] == stats["values"]
    # Even a resolved bundle that skipped the first book must not supply schema.
    prompt = runtime.scene._build_stats_block(WorldBookBundle([runtime.books.load("second")]))
    assert "Guest：energy 6" in prompt
    assert "幸运" not in prompt and "好感" not in prompt and "Default" not in prompt


def test_unbound_uses_actual_character_owner_and_per_character_prompt_fields(stats_runtime):
    runtime = stats_runtime
    runtime.overlay.set_worldbook_ids([])
    stats = resolve_session_character_stats(runtime.session, "Guest")
    assert stats["worldbook_id"] == "second"
    assert stats["values"] == {"trust": 2, "luck": 4, "energy": 6}
    prompt = runtime.scene._build_stats_block(None)
    assert "Hero：信任 0/10、知情 否、精力 8" in prompt
    assert "Guest：好感 2/50、幸运 4、energy 6" in prompt
    assert resolve_session_character_stats(runtime.session, "Missing")["values"] == {}


def test_binding_order_controls_schema_and_same_named_frontmatter(stats_runtime):
    runtime = stats_runtime
    runtime.overlay.set_worldbook_ids(["second", "first"])
    stats = resolve_session_character_stats(runtime.session, "Hero")
    assert stats["worldbook_id"] == "second"
    assert stats["values"] == {"trust": 2, "luck": 4, "energy": 99}
    prompt = runtime.scene._build_stats_block(runtime.books.resolve(runtime.overlay))
    assert "Hero：好感 2/50、幸运 4、energy 99" in prompt


def test_panel_writes_use_first_schema_and_prompt_reads_latest_frontmatter(stats_runtime):
    runtime = stats_runtime
    response = runtime.client.put("/api/sessions/stats/character-stats/Guest",
                                  json={"values": {"trust": 30, "known": "false"}})
    assert response.status_code == 200
    assert response.json["values"]["trust"] == 10
    assert response.json["values"]["known"] is False
    runtime.write_actor("second", "Guest", {"energy": 2})
    assert "Guest：信任 10/10、知情 否、精力 2" in runtime.scene._build_stats_block(None)
    reset = runtime.client.delete("/api/sessions/stats/character-stats/Guest")
    assert reset.json["values"] == {"trust": 0, "known": False, "energy": 2}


def test_narrative_override_endpoint_never_derives_tactical_stats(stats_runtime, monkeypatch):
    runtime = stats_runtime
    from combat_engine.entity import CombatUnit

    def forbidden(*args, **kwargs):
        pytest.fail("narrative must not construct a tactical entity")

    monkeypatch.setattr(CombatUnit, "from_character_metadata", forbidden)
    runtime.overlay.set_character_overrides("Hero", {"progress": {"level": 9, "xp": 20}})
    response = runtime.client.get("/api/sessions/stats/overrides/characters/Hero")
    assert response.status_code == 200
    assert response.json["progress"] is None
    assert response.json["combat_stats"] is None
    assert response.json["metadata"]["stats"] == {"energy": 8}
    assert runtime.client.get("/api/sessions/stats/overrides/characters/Missing").status_code == 404


@pytest.mark.parametrize("combat_mode", ["tactical", "sideview"])
def test_combat_modes_keep_derived_stats_and_progress(stats_runtime, combat_mode):
    runtime = stats_runtime
    runtime.session.combat_mode = combat_mode
    response = runtime.client.get("/api/sessions/stats/overrides/characters/Hero")
    assert response.status_code == 200
    assert response.json["progress"] == {"level": 1, "xp": 0}
    assert response.json["combat_stats"]["hp"] > 0
    runtime.overlay.set_character_overrides("Hero", {
        "progress": {"level": 3, "xp": 12}, "metadata": {"combat_stats": {"hp": 123}},
    })
    response = runtime.client.get("/api/sessions/stats/overrides/characters/Hero")
    assert response.json["progress"] == {"level": 3, "xp": 12}
    assert response.json["combat_stats"]["hp"] == 123


def test_prompt_format_uses_each_character_schema():
    block = format_stats_block([], {"A": {"trust": 0}, "B": {"trust": 0}}, fields_by_character={
        "A": [{"key": "trust", "label": "信任", "type": "number", "max": 10}],
        "B": [{"key": "trust", "label": "好感", "type": "number", "max": 50}],
    })
    assert "A：信任 0/10" in block and "B：好感 0/50" in block
