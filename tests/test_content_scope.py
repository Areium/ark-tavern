"""Distribution content is visible only while an owning book is installed."""

import json
import sys
from pathlib import Path

import pytest
from flask import Flask

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from content_scope import is_content_visible
from document_manager import DocumentManager, DocumentNotFoundError
from wiki_manager import WikiManager
from blueprints import assets
import content_scope
import player_profile
import avatar_color
import environment_state
import combat_rules
import session_export


def test_session_snapshot_restores_to_its_own_book_without_touching_hidden_content(tmp_path, monkeypatch):
    books = tmp_path / "data" / "worldbooks"
    content = books / "content"
    characters = content / "characters"
    snapshots = tmp_path / "snapshots" / "characters"
    for name in ("A_Custom", "Pack"):
        source = snapshots / name
        source.mkdir(parents=True)
        (source / "index.md").write_text(name, encoding="utf-8")
    books.mkdir(parents=True, exist_ok=True)
    (books / "content_manifest.json").write_text(json.dumps({
        "directories": {"characters/Pack/": ["pack"]}, "files": {},
    }), encoding="utf-8")
    monkeypatch.setattr(session_export, "_REPO_ROOT", tmp_path)
    book_id = session_export._restore_snapshots(tmp_path / "snapshots", "sess_example")
    assert book_id
    assert (books / "books" / book_id / "characters" / "A_Custom" / "index.md").is_file()
    assert (books / "books" / book_id / "characters" / "Pack" / "index.md").is_file()
    assert not (characters / "A_Custom").exists()
    assert not (characters / "Pack").exists()


def test_internal_staging_directory_is_never_visible(content_tree):
    _, _, chars = content_tree
    assert not is_content_visible(chars / ".uninstall-old" / "index.md",
                                  content_base=chars.parent)


def _write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


@pytest.fixture
def content_tree(tmp_path):
    books = tmp_path / "data" / "worldbooks"
    content = books / "content"
    chars = content / "characters"
    chars.mkdir(parents=True)
    (tmp_path / "data" / "categories.yaml").write_text(
        "categories:\n  characters: data/worldbooks/content/characters/\n", encoding="utf-8")
    for name in ("Pack", "Shared", "Custom"):
        folder = chars / name
        folder.mkdir()
        (folder / "index.md").write_text(f"---\nname: {name}\n---\n{name} body\n", encoding="utf-8")
        (folder / "avatar.png").write_bytes(b"png")
    _write_json(books / "content_manifest.json", {
        "directories": {
            "characters/Pack/": ["pack"],
            "characters/Shared/": ["pack", "other"],
        },
        "files": {"characters/Shared/avatar.png": ["pack"]},
    })
    return tmp_path, books, chars


def test_legacy_manifest_ownership_never_grants_runtime_visibility(content_tree):
    root, books, chars = content_tree
    pack = chars / "Pack" / "index.md"
    shared = chars / "Shared" / "index.md"
    custom = chars / "Custom" / "index.md"
    assert not is_content_visible(pack, project_root=root)
    assert is_content_visible(custom, project_root=root)

    _write_json(books / "pack.json", {"enabled": True})
    assert not is_content_visible(pack, project_root=root)
    assert not is_content_visible(chars / "Shared" / "avatar.png", project_root=root)

    _write_json(books / "pack.json", {"enabled": False})
    _write_json(books / "other.json", {"enabled": True})
    assert not is_content_visible(pack, project_root=root)
    assert not is_content_visible(shared, project_root=root)
    assert not is_content_visible(chars / "Shared" / "avatar.png", project_root=root)

    (books / "other.json").unlink()
    assert not is_content_visible(shared, project_root=root)


def test_catalog_and_asset_url_hide_uninstalled_content(content_tree):
    root, books, chars = content_tree
    manager = DocumentManager(str(root))
    wiki = WikiManager(str(root))
    app = Flask(__name__)
    assets.register(app, {"document": manager})
    app.config.update(TESTING=True)
    client = app.test_client()

    assert {x["id"] for x in manager.list_documents("characters")} == {"Custom"}
    with pytest.raises(DocumentNotFoundError):
        manager.read_document("characters", "Pack")
    with pytest.raises(DocumentNotFoundError):
        manager.save_document("characters", "Pack", "replacement", expected_hash="stale")
    assert wiki.get_document("characters", "Pack") == ""
    assert client.get("/api/assets/characters/Pack/avatar.png").status_code == 404
    assert client.get("/api/assets/characters/Custom/avatar.png").status_code == 200
    assert {x["entity"] for x in client.get("/api/assets/images").get_json()} == {"Custom"}

    _write_json(books / "pack.json", {"enabled": True})
    with pytest.raises(DocumentNotFoundError):
        manager.read_document("characters", "Pack")
    assert client.get("/api/assets/characters/Pack/avatar.png").status_code == 404
    _write_json(books / "pack.json", {"enabled": False})
    assert client.get("/api/assets/characters/Pack/avatar.png").status_code == 404


def test_symlink_and_category_escape_are_rejected(content_tree, tmp_path):
    root, _books, chars = content_tree
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"secret")
    app = Flask(__name__)
    assets.register(app, {"document": DocumentManager(str(root))})
    app.config.update(TESTING=True)
    client = app.test_client()
    assert client.get("/api/assets/characters/../outside.png").status_code == 404
    link = chars / "Custom" / "link.png"
    try:
        link.symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unavailable")
    assert not is_content_visible(link, project_root=root)
    assert client.get("/api/assets/characters/Custom/link.png").status_code == 404


def test_cached_profile_and_avatar_ignore_legacy_flat_book(content_tree, monkeypatch):
    root, books, chars = content_tree
    monkeypatch.setattr(content_scope, "CONTENT_ROOT", books / "content")
    monkeypatch.setattr(content_scope, "WORLDBOOKS_ROOT", books)
    monkeypatch.setattr(player_profile, "_CHARS_DIR", chars)
    monkeypatch.setattr(avatar_color, "_CHARS_ROOT", chars)
    player_profile.invalidate_profile_cache()

    _write_json(books / "pack.json", {"enabled": True})
    assert player_profile.load_player_profile("Pack") is None
    avatar_dir = chars / "Pack" / "avatar"
    avatar_dir.mkdir()
    (avatar_dir / "portrait.png").write_bytes(b"png")
    assert avatar_color.find_avatar_path("Pack") is None

    _write_json(books / "pack.json", {"enabled": False})
    assert player_profile.load_player_profile("Pack") is None
    assert avatar_color.find_avatar_path("Pack") is None


def test_distribution_root_without_manifest_fails_closed(tmp_path, monkeypatch):
    content = tmp_path / "content"
    actor = content / "characters" / "Example" / "index.md"
    actor.parent.mkdir(parents=True)
    actor.write_text("# Example", encoding="utf-8")
    monkeypatch.setattr(content_scope, "CONTENT_ROOT", content)
    monkeypatch.setattr(content_scope, "WORLDBOOKS_ROOT", tmp_path)
    assert not is_content_visible(actor)


def test_environment_and_combat_rules_ignore_legacy_flat_book(tmp_path, monkeypatch):
    books = tmp_path / "content_books"
    content = books / "content"
    weather = content / "environment" / "weather" / "sunny" / "index.md"
    weather.parent.mkdir(parents=True)
    weather.write_text("---\nweather_type:\n  name: 晴天\n---\n示例天气", encoding="utf-8")
    difficulty = content / "combat" / "rules" / "difficulty.json"
    difficulty.parent.mkdir(parents=True)
    _write_json(difficulty, {"audit_sentinel": "owned"})
    _write_json(books / "content_manifest.json", {"directories": {
        "environment/weather/sunny/": ["sample"]},
        "files": {"combat/rules/difficulty.json": ["sample"]}})
    monkeypatch.setattr(environment_state, "_DEFAULT_ENV_DIR", str(content / "environment"))
    monkeypatch.setattr(combat_rules, "RULES_DIR", difficulty.parent)
    monkeypatch.setattr(combat_rules, "_DEFAULT_RULES_DIR", difficulty.parent)
    monkeypatch.setattr(content_scope, "CONTENT_ROOT", content)
    monkeypatch.setattr(content_scope, "WORLDBOOKS_ROOT", books)
    combat_rules._cache.clear()

    assert not environment_state.EnvironmentState().load_weather("sunny")
    assert "audit_sentinel" not in combat_rules.difficulty_rules()
    _write_json(books / "sample.json", {"enabled": True})
    env = environment_state.EnvironmentState()
    assert not env.load_weather("sunny")
    assert "audit_sentinel" not in combat_rules.difficulty_rules()
    _write_json(books / "sample.json", {"enabled": False})
    assert not environment_state.EnvironmentState().load_weather("sunny")
    assert "audit_sentinel" not in combat_rules.difficulty_rules()
    combat_rules._cache.clear()
