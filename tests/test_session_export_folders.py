"""Session archives snapshot resources from the session's bound books."""

import json
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import session_export


def _book(root: Path, book_id: str, *, enabled: bool = True) -> Path:
    folder = root / "data" / "worldbooks" / "books" / book_id
    folder.mkdir(parents=True)
    (folder / "book.json").write_text(
        json.dumps({"id": book_id, "enabled": enabled}), encoding="utf-8")
    return folder


def _session(root: Path) -> Path:
    session = root / "sessions" / "story" / "sess_export"
    session.mkdir(parents=True)
    (session / "overrides.json").write_text(
        json.dumps({"characters": {"Hero": {}}}), encoding="utf-8")
    background = session / "backgrounds" / "forest.png"
    background.parent.mkdir()
    background.write_bytes(b"session background")
    avatar = session / "resources" / "characters" / "Hero" / "avatar.png"
    avatar.parent.mkdir(parents=True)
    avatar.write_bytes(b"session avatar")
    return session


def _resource(book: Path, payload: bytes) -> None:
    character = book / "characters" / "Hero"
    (character / "avatar").mkdir(parents=True)
    (character / "index.md").write_text("Hero from " + book.name, encoding="utf-8")
    (character / "avatar" / "main.png").write_bytes(payload)
    background = book / "combat" / "backgrounds" / "forest"
    background.mkdir(parents=True)
    (background / "index.md").write_text("Forest from " + book.name, encoding="utf-8")
    (background / "image.png").write_bytes(payload)


def test_export_uses_bound_book_order_and_keeps_session_overrides(tmp_path, monkeypatch):
    monkeypatch.setattr(session_export, "_REPO_ROOT", tmp_path)
    session = _session(tmp_path)
    first = _book(tmp_path, "first")
    second = _book(tmp_path, "second")
    _resource(first, b"first")
    _resource(second, b"second")
    out = tmp_path / "session.zip"

    session_export.export_session_zip(
        session, {"worldbook_ids": ["second", "first"]}, out)

    with zipfile.ZipFile(out) as archive:
        base = "session/story/sess_export"
        assert archive.read(f"{base}/backgrounds/forest.png") == b"session background"
        assert archive.read(f"{base}/resources/characters/Hero/avatar.png") == b"session avatar"
        assert archive.read("snapshots/characters/Hero/avatar/main.png") == b"second"
        assert archive.read("snapshots/backgrounds/forest/image.png") == b"second"
        assert json.loads(archive.read("manifest.json"))["dependencies"] == {
            "characters": ["Hero"], "backgrounds": ["forest"],
        }


def test_export_excludes_unbound_and_disabled_book_resources(tmp_path, monkeypatch):
    monkeypatch.setattr(session_export, "_REPO_ROOT", tmp_path)
    session = _session(tmp_path)
    _resource(_book(tmp_path, "unbound"), b"unbound")
    _resource(_book(tmp_path, "disabled", enabled=False), b"disabled")
    out = tmp_path / "session.zip"

    session_export.export_session_zip(
        session, {"worldbook_ids": ["disabled"]}, out)

    with zipfile.ZipFile(out) as archive:
        names = archive.namelist()
        assert not any(name.startswith("snapshots/") for name in names)
        assert "session/story/sess_export/backgrounds/forest.png" in names


def test_export_preserves_visible_local_fallback(tmp_path, monkeypatch):
    monkeypatch.setattr(session_export, "_REPO_ROOT", tmp_path)
    content = tmp_path / "data" / "worldbooks" / "content"
    monkeypatch.setattr(session_export, "_CHARS_DIR", content / "characters")
    monkeypatch.setattr(session_export, "_BG_ROOT", content / "combat" / "backgrounds")
    session = _session(tmp_path)
    _resource(content, b"local")
    out = tmp_path / "session.zip"

    session_export.export_session_zip(session, {"worldbook_ids": []}, out)

    with zipfile.ZipFile(out) as archive:
        assert archive.read("snapshots/characters/Hero/avatar/main.png") == b"local"
        assert archive.read("snapshots/backgrounds/forest/image.png") == b"local"


def test_export_skips_linked_book_files(tmp_path, monkeypatch):
    monkeypatch.setattr(session_export, "_REPO_ROOT", tmp_path)
    session = _session(tmp_path)
    book = _book(tmp_path, "safe")
    _resource(book, b"safe")
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"private")
    linked = book / "combat" / "backgrounds" / "forest" / "linked.png"
    try:
        linked.symlink_to(outside)
    except OSError:
        return  # Windows accounts without symlink privilege
    out = tmp_path / "session.zip"

    session_export.export_session_zip(session, {"worldbook_ids": ["safe"]}, out)

    with zipfile.ZipFile(out) as archive:
        assert "snapshots/backgrounds/forest/linked.png" not in archive.namelist()
        assert archive.read("snapshots/backgrounds/forest/image.png") == b"safe"
