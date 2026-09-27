"""Optional animation metadata follows its installed worldbook."""

import json
import sys
from pathlib import Path

from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from blueprints.assets import register


def test_spine_catalog_follows_book_install_and_disable(tmp_path):
    books = tmp_path / "data" / "worldbooks"
    content = books / "content"
    actor = content / "characters" / "角色甲"
    actor.mkdir(parents=True)
    (actor / "index.md").write_text("# 角色甲", encoding="utf-8")
    (content / "spine_variants.json").write_text(
        json.dumps({"角色甲": "model/default", "角色乙": "model/missing", "../坏角色": "bad"}),
        encoding="utf-8",
    )
    (books / "content_manifest.json").write_text(json.dumps({
        "directories": {"characters/角色甲/": ["sample"]},
        "files": {"spine_variants.json": ["sample"]},
    }), encoding="utf-8")

    class Documents:
        _root = tmp_path

    app = Flask(__name__)
    register(app, {"document": Documents()})
    client = app.test_client()

    assert client.get("/api/assets/spine-variants").json == {"variants": {}}
    book = books / "sample.json"
    book.write_text('{"enabled": true}', encoding="utf-8")
    assert client.get("/api/assets/spine-variants").json == {"variants": {"角色甲": "model/default"}}
    book.write_text('{"enabled": false}', encoding="utf-8")
    assert client.get("/api/assets/spine-variants").json == {"variants": {}}
    book.unlink()
    assert client.get("/api/assets/spine-variants").json == {"variants": {}}
