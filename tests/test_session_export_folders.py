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
    (session / "session.json").write_text(json.dumps({
        "id": "sess_export", "mode": "story", "combat_mode": "narrative",
    }), encoding="utf-8")
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


def test_export_ignores_shared_content_without_bound_book(tmp_path, monkeypatch):
    monkeypatch.setattr(session_export, "_REPO_ROOT", tmp_path)
    content = tmp_path / "data" / "worldbooks" / "content"
    session = _session(tmp_path)
    _resource(content, b"local")
    out = tmp_path / "session.zip"

    session_export.export_session_zip(session, {"worldbook_ids": []}, out)

    with zipfile.ZipFile(out) as archive:
        assert not any(name.startswith("snapshots/") for name in archive.namelist())


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


def test_import_restores_snapshots_into_a_bound_folder_book(tmp_path, monkeypatch):
    monkeypatch.setattr(session_export, "_REPO_ROOT", tmp_path)
    monkeypatch.setattr(session_export, "_SESSIONS_DIR", tmp_path / "imported-sessions")
    original = _session(tmp_path)
    (original / "overrides.json").write_text(
        json.dumps({"characters": {"Hero": {}}, "worldbook_ids": ["original"]}),
        encoding="utf-8")
    _resource(_book(tmp_path, "original"), b"archived")
    archive = tmp_path / "session.zip"
    session_export.export_session_zip(
        original, {"worldbook_ids": ["original"]}, archive)

    class SessionManager:
        def import_session_dir(self, mode, session_id):
            session_dir = session_export._SESSIONS_DIR / mode / session_id
            return type("Imported", (), {"to_dict": lambda _: {
                "id": session_id,
                "worldbook_ids": json.loads((session_dir / "overrides.json").read_text(
                    encoding="utf-8"))["worldbook_ids"],
            }})()

    imported = session_export.import_session_zip(archive, SessionManager())
    snapshot_id = imported["worldbook_ids"][0]
    assert snapshot_id.startswith("session-")
    assert imported["worldbook_ids"][1:] == ["original"]
    snapshot = tmp_path / "data" / "worldbooks" / "books" / snapshot_id
    assert (snapshot / "book.json").is_file()
    assert (snapshot / "characters" / "Hero" / "avatar" / "main.png").read_bytes() == b"archived"
    assert (snapshot / "combat" / "backgrounds" / "forest" / "image.png").read_bytes() == b"archived"
    from worldbook_content import resolve_content
    assert resolve_content(
        "characters/Hero/avatar/main.png", book_ids=imported["worldbook_ids"],
        project_root=tmp_path).read_bytes() == b"archived"
    assert not (tmp_path / "data" / "worldbooks" / "content" / "characters" / "Hero").exists()


def test_failed_session_registration_removes_new_snapshot_book(tmp_path, monkeypatch):
    monkeypatch.setattr(session_export, "_REPO_ROOT", tmp_path)
    monkeypatch.setattr(session_export, "_SESSIONS_DIR", tmp_path / "imported-sessions")
    original = _session(tmp_path)
    _resource(_book(tmp_path, "original"), b"archived")
    archive = tmp_path / "session.zip"
    session_export.export_session_zip(original, {"worldbook_ids": ["original"]}, archive)

    class FailingManager:
        def import_session_dir(self, mode, session_id):
            return None

    import pytest
    with pytest.raises(ValueError, match="会话注册失败"):
        session_export.import_session_zip(archive, FailingManager())
    assert not (tmp_path / "imported-sessions" / "story" / "sess_export").exists()
    assert sorted(path.name for path in (tmp_path / "data" / "worldbooks" / "books").iterdir()) == ["original"]
