import copy
import json
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from split_builtin_story_worldbooks import (  # noqa: E402
    STORY_SPECS, pack_revision, split_builtin_book,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from blueprints.worldbook import _entry_from_payload  # noqa: E402


def _entry(uid, category="characters"):
    return {"uid": uid, "name": uid, "content": f"content-{uid}",
            "always_active": False, "position": 1, "category_id": category}


def _source():
    configured = set()
    for spec in STORY_SPECS:
        configured.update(spec["character_uids"])
        configured.update(spec["content_uids"])
    entries = [_entry(uid, "characters" if uid.startswith("characters_") else "other")
               for uid in sorted(configured)]
    entries.append(_entry("world_shared", "worldview"))
    return {
        "id": "arknights", "name": "旧名", "source": "preinstalled",
        "book_type": "reference", "entries": entries,
        "dependency_edges": [
            {"from_uid": "plots_near-light_index", "to_uid": "characters_临光_index"},
            {"from_uid": "world_shared", "to_uid": "plots_near-light_index"},
        ], "related_edges": [],
    }


def test_split_moves_story_content_but_keeps_characters_in_reference():
    base, stories = split_builtin_book(_source())
    base_uids = {entry["uid"] for entry in base["entries"]}
    assert "plots_near-light_index" not in base_uids
    assert "characters_临光_index" in base_uids
    assert "world_shared" in base_uids
    assert set(stories) == {"near-light", "fengxue-guojing", "combat-test"}


def test_story_entries_default_to_static_and_dynamic_requires_opt_in():
    _base, stories = split_builtin_book(_source())
    for story in stories.values():
        assert story["book_type"] == "story"
        injectables = [entry for entry in story["entries"] if not entry["uid"].startswith("plot_graph_")]
        assert injectables
        assert all(entry["always_active"] is True and entry["position"] == 0 for entry in injectables)
        assert {root["entry_uid"] for root in story["dependency_rules"]["roots"]} == {
            entry["uid"] for entry in injectables}


def test_split_does_not_mutate_source_and_filters_cross_book_edges():
    source = _source()
    before = copy.deepcopy(source)
    base, stories = split_builtin_book(source)
    assert source == before
    assert base["dependency_edges"] == []
    assert stories["near-light"]["dependency_edges"] == [
        {"from_uid": "plots_near-light_index", "to_uid": "characters_临光_index"}]


def test_api_entry_defaults_to_static_but_accepts_dynamic_opt_in():
    default_entry = _entry_from_payload({"content": "静态正文"})
    dynamic_entry = _entry_from_payload(
        {"content": "动态正文", "always_active": False, "position": 1})
    assert default_entry.always_active is True and default_entry.position == 0
    assert dynamic_entry.always_active is False and dynamic_entry.position == 1


def test_pack_revision_ignores_non_injection_metadata():
    book = {"id": "x", "name": "X", "entries": [_entry("a")]}
    changed = {**book, "updated_at": 123, "source": "preinstalled"}
    assert pack_revision(book) == pack_revision(changed)


def test_committed_packs_are_split_and_bindable():
    pack_dir = Path(__file__).resolve().parents[1] / "data" / "worldbooks" / "packs"
    books = {
        path.stem: json.loads(path.read_text(encoding="utf-8"))
        for path in pack_dir.glob("*.json")
    }
    assert {"arknights", "near-light", "fengxue-guojing", "combat-test"} <= set(books)
    reference_uids = {entry["uid"] for entry in books["arknights"]["entries"]}
    assert books["arknights"]["book_type"] == "reference"
    assert "characters_临光_index" in reference_uids
    for spec in STORY_SPECS:
        story = books[spec["id"]]
        story_uids = {entry["uid"] for entry in story["entries"]}
        assert story["book_type"] == "story"
        assert spec["plot_uid"] in story_uids and spec["plot_uid"] not in reference_uids
        assert not (set(spec["content_uids"]) - {"plot_graph_near-light"}) & reference_uids
