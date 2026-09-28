"""Bundled worlds enter the runtime only after a user's explicit install."""

import json
import sys
from pathlib import Path

from flask import Flask

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
import world_book
from blueprints.worldbook import register
from content_scope import is_content_visible


def test_explicit_pack_install_disable_delete_and_restart(tmp_path, monkeypatch):
    books = tmp_path / "data" / "worldbooks"
    packs = books / "packs"
    content = books / "content"
    actor = content / "characters" / "样本角色" / "index.md"
    actor.parent.mkdir(parents=True)
    actor.write_text("# 样本角色", encoding="utf-8")
    packs.mkdir(parents=True)
    (packs / "sample.json").write_text(json.dumps({
        "id": "sample", "name": "样本世界", "entries": [], "book_type": "story",
        "schema_version": 3, "scope_mode": "selective",
        "dependency_rules": {"roots": [], "root_rule": {"entry_uids": []}},
    }, ensure_ascii=False), encoding="utf-8")
    (books / "content_manifest.json").write_text(json.dumps({
        "directories": {"characters/样本角色/": ["sample"]}, "files": {},
    }, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(world_book, "_PACKS_DIR", packs)
    manager = world_book.WorldBookManager(books)
    app = Flask(__name__)
    register(app, {"worldbook": manager})
    client = app.test_client()

    assert manager.list_books() == []
    assert not is_content_visible(actor, project_root=tmp_path)
    available = client.get("/api/worldbook/available-packs")
    assert available.status_code == 200
    assert available.json["packs"][0]["installed"] is False

    installed = client.post("/api/worldbook/available-packs/sample/install")
    assert installed.status_code == 201
    assert installed.json["book"]["id"] == "sample"
    assert is_content_visible(actor, project_root=tmp_path)
    assert client.post("/api/worldbook/available-packs/sample/install").status_code == 409
    assert client.post("/api/worldbook/available-packs/bad../install").status_code == 404

    book = manager.load("sample")
    book.enabled = False
    manager.save(book)
    assert not is_content_visible(actor, project_root=tmp_path)
    book.enabled = True
    manager.save(book)
    assert is_content_visible(actor, project_root=tmp_path)

    assert client.delete("/api/worldbook/sample").status_code == 200
    assert not is_content_visible(actor, project_root=tmp_path)
    restarted = world_book.WorldBookManager(books)
    assert restarted.list_books() == []
    assert not is_content_visible(actor, project_root=tmp_path)
