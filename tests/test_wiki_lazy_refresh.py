"""Lazy Wiki publication, scoped invalidation and request-level snapshot consistency."""

import copy
import json
import shutil
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from blueprints import wiki as wiki_blueprint, worldbook
from hooks.base import HookContext
from hooks.wiki_prefetch import WikiPreFetchHook
from session_context import SessionContext
from wiki_manager import WikiManager
from world_book import WorldBookManager


def _doc(folder, key="characters/Hero", *, name="First Hero", summary="first summary",
         body="first body", imports=()):
    path = folder / f"{key}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    links = "".join(f"- {value}\n" for value in imports)
    path.write_text(
        f"---\nname: {name}\nsummary: {json.dumps(summary)}\nimports:\n{links}---\n{body}",
        encoding="utf-8")
    return path


def _book(root, book_id):
    folder = root / "data" / "worldbooks" / "books" / book_id
    folder.mkdir(parents=True)
    (folder / "book.json").write_text(json.dumps({
        "id": book_id, "name": book_id, "enabled": True,
    }), encoding="utf-8")
    return folder


@pytest.fixture
def library(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    (data / "categories.yaml").write_text(
        "categories:\n  characters: characters/\n  items: items/\n"
        "  races: races/\n  factions: factions/\n  attributes: attributes/\n",
        encoding="utf-8")
    first = _book(tmp_path, "a_first")
    _doc(first)
    return tmp_path, first, WikiManager(str(tmp_path))


@pytest.mark.parametrize("read", [
    lambda wiki: wiki.catalog_snapshot(),
    lambda wiki: wiki.get_document("characters", "Hero"),
    lambda wiki: wiki.query("Hero"),
    lambda wiki: wiki.resolve_imports_chain(["characters/Hero"]),
    lambda wiki: wiki.validate_imports(),
    lambda wiki: wiki.format_catalog_summary(),
    lambda wiki: wiki.build_character_context({"race": "Race"}),
    lambda wiki: wiki.build_character_attributes_context({"physical_strength": 5}),
    lambda wiki: wiki.backfill_summaries(Mock(), dry_run=True),
    lambda wiki: WikiPreFetchHook._extract_entities(
        wiki, ["First Hero"], SessionContext(), None),
])
def test_invalidate_does_no_work_and_each_first_read_builds_once(library, monkeypatch, read):
    _, _, wiki = library
    build = Mock(wraps=wiki._build_catalog)
    scan = Mock(wraps=wiki._scan_category)
    monkeypatch.setattr(wiki, "_build_catalog", build)
    monkeypatch.setattr(wiki, "_scan_category", scan)
    wiki.invalidate()
    wiki.invalidate()
    assert build.call_count == scan.call_count == 0
    read(wiki)
    assert build.call_count == 1
    assert scan.call_count == 1
    read(wiki)
    assert build.call_count == 1
    assert scan.call_count == 1


def test_copy_modify_and_delete_publish_new_snapshots(library):
    root, first, wiki = library
    previous = wiki.catalog_snapshot()
    frozen = copy.deepcopy(previous)
    copied = first.parent / "b_copy"
    shutil.copytree(first, copied)
    (copied / "book.json").write_text(json.dumps({"id": "b_copy"}), encoding="utf-8")
    added = _doc(copied, "items/Added", name="Added", summary="copied summary")
    wiki.invalidate()
    assert wiki.get_document("items", "Added", "summary") == "copied summary"
    _doc(first, name="Changed Hero", summary="changed summary", body="changed body")
    added.unlink()
    wiki.invalidate()
    assert wiki.get_document("characters", "Hero", "summary") == "changed summary"
    assert "Changed Hero" in wiki.query("characters/Hero")
    assert wiki.get_document("items", "Added") == ""
    assert previous == frozen
    assert wiki.catalog_snapshot() is not previous
    assert root.is_dir()


def test_held_scoped_children_refresh_without_replacing_bindings(library, monkeypatch):
    root, first, wiki = library
    second = _book(root, "b_second")
    _doc(second, name="Second Hero", summary="second summary")
    forward = wiki.scoped(["a_first", "b_second"])
    reverse = wiki.scoped(["b_second", "a_first", "b_second"])
    held = reverse.scoped(["b_second"])
    empty = wiki.scoped([])
    assert reverse is wiki.scoped(["b_second", "a_first"])
    assert all(child._lock is wiki._lock for child in (forward, reverse, held, empty))
    assert forward.get_document("characters", "Hero", "summary") == "first summary"
    assert reverse.get_document("characters", "Hero", "summary") == "second summary"
    _doc(second, summary="updated second")
    _doc(first, "items/New", name="New")
    global_build = Mock(wraps=wiki._build_catalog)
    monkeypatch.setattr(wiki, "_build_catalog", global_build)
    wiki.invalidate()
    assert wiki.scoped(["b_second", "a_first"]) is reverse
    assert reverse.scoped(["b_second"]) is held
    assert held.get_document("characters", "Hero", "summary") == "updated second"
    assert reverse.get_document("characters", "Hero", "summary") == "updated second"
    assert forward.get_document("items", "New") == "first body"
    assert empty.catalog_snapshot() == ({}, {})
    assert wiki.scoped(["a_first"]).get_document("items", "New") == "first body"
    assert global_build.call_count == 0


def test_explicit_refresh_builds_only_current_instance_immediately(library, monkeypatch):
    _, first, wiki = library
    child = wiki.scoped(["a_first"])
    root_build = Mock(wraps=wiki._build_catalog)
    child_build = Mock(wraps=child._build_catalog)
    monkeypatch.setattr(wiki, "_build_catalog", root_build)
    monkeypatch.setattr(child, "_build_catalog", child_build)
    _doc(first, "items/New")
    wiki.refresh()
    assert root_build.call_count == 1
    assert child_build.call_count == 0
    assert child.get_document("items", "New") == "first body"
    assert child_build.call_count == 1
    child.refresh()
    assert child_build.call_count == 2
    assert root_build.call_count == 1


@pytest.mark.parametrize("refresh", [False, True])
def test_failed_partial_build_keeps_old_snapshot_and_retries(library, monkeypatch, refresh):
    _, first, wiki = library
    old = wiki.catalog_snapshot()
    frozen = copy.deepcopy(old)
    _doc(first, "items/New")
    scan = wiki._scan_category
    calls = []

    def fail_once(cat, path, catalog, by_category):
        scan(cat, path, catalog, by_category)
        calls.append(cat)
        if len(calls) == 2:
            raise OSError("catalog scan failed")

    monkeypatch.setattr(wiki, "_scan_category", fail_once)
    wiki.invalidate()
    with pytest.raises(OSError, match="catalog scan failed"):
        wiki.refresh() if refresh else wiki.catalog_snapshot()
    assert wiki._snapshot is old
    assert old == frozen
    assert wiki._dirty
    assert wiki.get_document("items", "New") == "first body"
    assert not wiki._dirty
    assert len(calls) == 4


def test_invalid_categories_can_be_repaired_and_retried_without_another_invalidate(library):
    root, _, wiki = library
    previous = wiki.catalog_snapshot()
    categories = root / "data" / "categories.yaml"
    original = categories.read_text(encoding="utf-8")
    categories.write_text("categories: [", encoding="utf-8")
    wiki.invalidate()
    import yaml
    with pytest.raises(yaml.YAMLError):
        wiki.catalog_snapshot()
    assert wiki._snapshot is previous
    assert wiki._dirty
    categories.write_text(original, encoding="utf-8")
    assert wiki.catalog_snapshot() == previous
    assert not wiki._dirty


def test_concurrent_readers_never_see_partially_built_indexes(library, monkeypatch):
    _, first, wiki = library
    old = wiki.catalog_snapshot()
    frozen = copy.deepcopy(old)
    _doc(first, "characters/New", name="New Hero")
    _doc(first, "items/New", name="New Item")
    entered, release = Event(), Event()
    scan = wiki._scan_category
    calls = []

    def paused_scan(cat, path, catalog, by_category):
        scan(cat, path, catalog, by_category)
        calls.append(cat)
        if cat == "characters":
            entered.set()
            assert release.wait(5)

    monkeypatch.setattr(wiki, "_scan_category", paused_scan)
    wiki.invalidate()
    with ThreadPoolExecutor(max_workers=4) as pool:
        first_reader = pool.submit(wiki.catalog_snapshot)
        try:
            assert entered.wait(5)
            others = [pool.submit(wiki.catalog_snapshot) for _ in range(3)]
            assert old == frozen
            assert wiki._snapshot is old
        finally:
            release.set()
        snapshots = [f.result(timeout=5) for f in [first_reader, *others]]
    assert calls == ["characters", "items"]
    assert all(snapshot is snapshots[0] for snapshot in snapshots)
    catalog, categories = snapshots[0]
    assert set(catalog) == {"characters/Hero", "characters/New", "items/New"}
    assert set(catalog) == {f"{cat}/{doc}" for cat, ids in categories.items() for doc in ids}


def test_invalidate_waiting_for_build_is_not_lost(library, monkeypatch):
    _, first, wiki = library
    built, release, attempted, invalidated = Event(), Event(), Event(), Event()
    build = wiki._build_catalog
    calls = []

    def paused_build():
        snapshot = build()
        calls.append(snapshot)
        if len(calls) == 1:
            built.set()
            assert release.wait(5)
        return snapshot

    def invalidate():
        attempted.set()
        wiki.invalidate()
        invalidated.set()

    monkeypatch.setattr(wiki, "_build_catalog", paused_build)
    wiki.invalidate()
    with ThreadPoolExecutor(max_workers=2) as pool:
        reader = pool.submit(wiki.catalog_snapshot)
        try:
            assert built.wait(5)
            _doc(first, "items/Later", name="Later")
            writer = pool.submit(invalidate)
            assert attempted.wait(5)
            assert not invalidated.is_set()
        finally:
            release.set()
        before, _ = reader.result(timeout=5)
        writer.result(timeout=5)
    assert "items/Later" not in before
    assert wiki.get_document("items", "Later") == "first body"
    assert len(calls) == 2


@pytest.mark.parametrize("query", ["characters/Hero", "Hero", "First"])
def test_query_formats_the_entry_from_its_own_snapshot(library, monkeypatch, query):
    _, first, wiki = library
    format_full = wiki._format_doc_full

    def refresh_before_format(entry):
        _doc(first, name="Replacement", summary="replacement summary")
        wiki.refresh()
        return format_full(entry)

    monkeypatch.setattr(wiki, "_format_doc_full", refresh_before_format)
    result = wiki.query(query)
    assert "First Hero" in result and "first summary" in result
    assert "Replacement" not in result
    assert wiki.get_document("characters", "Hero", "summary") == "replacement summary"


def test_character_context_holds_one_snapshot_across_nested_reads(library, monkeypatch):
    _, first, wiki = library
    _doc(first, "races/Race", body="## 生理特征\nrace body")
    _doc(first, "factions/Faction", summary="old faction")
    wiki.refresh()
    read_content = wiki._read_content

    def update_during_read(path):
        _doc(first, "factions/Faction", summary="new faction")
        wiki.refresh()
        return read_content(path)

    monkeypatch.setattr(wiki, "_read_content", update_during_read)
    result = wiki.build_character_context({"race": "Race", "faction": "Faction"})
    assert "old faction" in result
    assert "new faction" not in result


def test_full_content_io_and_llm_calls_do_not_hold_the_catalog_lock(library, monkeypatch):
    _, first, wiki = library
    _doc(first, summary="")
    wiki.invalidate()
    read_content = wiki._read_content
    with ThreadPoolExecutor(max_workers=1) as pool:
        def unlocked_read(path):
            pool.submit(wiki.invalidate).result(timeout=5)
            return read_content(path)

        def unlocked_chat(*args, **kwargs):
            pool.submit(wiki.invalidate).result(timeout=5)
            return {"content": "generated summary"}

        monkeypatch.setattr(wiki, "_read_content", unlocked_read)
        assert "first body" in wiki.query("Hero")
        result = wiki.backfill_summaries(SimpleNamespace(chat=unlocked_chat), dry_run=True)
    assert result["generated"] == 1


def test_prefetch_is_a_lazy_first_reader_and_uses_one_snapshot(library, monkeypatch):
    _, first, wiki = library
    body = "## 物品描述\nbeacon body"
    _doc(first, "items/Beacon", name="Beacon", body=body)
    wiki.invalidate()
    snapshot = Mock(wraps=wiki.catalog_snapshot)
    monkeypatch.setattr(wiki, "catalog_snapshot", snapshot)
    sc = SessionContext()
    session = SimpleNamespace(
        scene_manager=SimpleNamespace(_session_context=sc, _wiki_manager=wiki),
        _narration_history=[{"text": "Approach the Beacon"}],
    )
    ctx = HookContext(session=session, player_info={}, user_action="", env_context="")
    assert WikiPreFetchHook().on_before_narration(ctx) == []
    assert sc.wiki_retrieved == {"items/Beacon": body}
    assert snapshot.call_count == 1


def test_catalog_endpoint_uses_one_snapshot_for_summary_count_and_categories(library, monkeypatch):
    _, first, wiki = library
    app = Flask(__name__)
    app.config["TESTING"] = True
    wiki_blueprint.register(app, {"wiki": wiki, "llm_backend": None})
    format_summary = wiki.format_catalog_summary

    def refresh_before_summary(*, snapshot):
        _doc(first, "items/New", name="New Item")
        wiki.refresh()
        return format_summary(snapshot=snapshot)

    monkeypatch.setattr(wiki, "format_catalog_summary", refresh_before_summary)
    response = app.test_client().get("/api/wiki/catalog")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["total_docs"] == 1
    assert payload["categories"] == {"characters": ["Hero"]}
    assert "First Hero" in payload["summary"]
    assert "New Item" not in payload["summary"]


def test_bookshelf_get_invalidates_without_building_then_wiki_reads_copied_book(library, monkeypatch):
    root, _, wiki = library
    target = WorldBookManager(root / "data" / "worldbooks")
    source = WorldBookManager(root / "source")
    book = source.create_book("Copied externally")
    _doc(source._path(book.id).parent, "items/Copied", name="Copied Item")
    shutil.copytree(source._path(book.id).parent, target._path(book.id).parent)
    app = Flask(__name__)
    app.config["TESTING"] = True
    worldbook.register(app, {"worldbook": target, "wiki": wiki})
    wiki_blueprint.register(app, {"wiki": wiki, "llm_backend": None})
    build = Mock(wraps=wiki._build_catalog)
    monkeypatch.setattr(wiki, "_build_catalog", build)
    cache_calls = []
    for module_name, function_name in (
        ("player_profile", "invalidate_profile_cache"),
        ("worldbook_content", "invalidate_content_cache"),
        ("content_scope", "invalidate_visibility_cache"),
    ):
        module = __import__(module_name)
        spy = Mock(wraps=getattr(module, function_name))
        monkeypatch.setattr(module, function_name, spy)
        cache_calls.append(spy)
    client = app.test_client()
    for _ in range(2):
        response = client.get("/api/worldbook")
        assert response.status_code == 200
        assert book.id in {item["id"] for item in response.get_json()["books"]}
    assert build.call_count == 0
    assert all(spy.call_count == 2 for spy in cache_calls)
    payload = client.get("/api/wiki/catalog").get_json()
    assert "Copied" in payload["categories"]["items"]
    assert "Copied Item" in payload["summary"]
    assert build.call_count == 1
    response = client.post("/api/wiki/refresh")
    assert response.status_code == 200
    assert response.get_json()["total"] == payload["total_docs"]
    assert build.call_count == 2
