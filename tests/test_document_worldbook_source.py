"""Document owner comes from the enabled book folder, never frontmatter."""

import os
import sys

import frontmatter
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from document_manager import DocumentManager

CATEGORIES_YAML = """
categories:
  characters: characters/
"""


@pytest.fixture()
def manager(tmp_path):
    """一个只含 characters 类别的临时项目根。"""
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "categories.yaml").write_text(CATEGORIES_YAML, encoding="utf-8")
    book = tmp_path / "data" / "worldbooks" / "books" / "book_a"
    book.mkdir(parents=True)
    (book / "book.json").write_text('{"id":"book_a","enabled":true}', encoding="utf-8")
    chars = book / "characters"
    chars.mkdir(parents=True)

    def write(slug: str, **meta):
        entity = chars / slug
        entity.mkdir()
        post = frontmatter.Post("# 背景\n\n正文。", **meta)
        (entity / "index.md").write_text(frontmatter.dumps(post), encoding="utf-8")

    write("已标注", name="已标注", summary="摘要", worldbook_id="book_a")
    write("未标注", name="未标注", summary="摘要")  # 旧数据：完全没有该字段
    write("空值", name="空值", summary="摘要", worldbook_id=None)
    write("空白", name="空白", summary="摘要", worldbook_id="   ")
    return DocumentManager(str(tmp_path))


def _by_id(docs) -> dict:
    return {d["id"]: d for d in docs}


def test_worldbook_id_comes_from_folder(manager):
    docs = _by_id(manager.list_documents("characters", include_content=True))
    assert docs["已标注"]["worldbook_id"] == "book_a"
    assert all(doc["worldbook_id"] == "book_a" for doc in docs.values())


def test_worldbook_id_available_without_content_summary(manager):
    """不请求内容摘要时也要能拿到来源标注（分组只依赖它）。"""
    docs = _by_id(manager.list_documents("characters"))
    assert docs["已标注"]["worldbook_id"] == "book_a"
    assert docs["未标注"]["worldbook_id"] == "book_a"
    # title / summary 的既有语义不变：不读内容时仍是目录名与空摘要
    assert docs["已标注"]["title"] == "已标注"
    assert docs["已标注"]["summary"] == ""


def test_existing_fields_unchanged(manager):
    """新增字段是纯追加：原有键一个不少，值也不变。"""
    doc = _by_id(manager.list_documents("characters", include_content=True))["已标注"]
    assert {"category_id", "id", "title", "name", "hash", "mtime", "summary"} <= set(doc)
    assert doc["category_id"] == "characters"
    assert doc["name"] == doc["title"] == "已标注"
    assert doc["summary"] == "摘要"


def test_characters_route_exposes_worldbook_id(tmp_path):
    """The character route reports the physical book owner."""
    from flask import Flask
    from blueprints import scene
    from document_manager import DocumentManager

    book = tmp_path / "data" / "worldbooks" / "books" / "book_a"
    book.mkdir(parents=True)
    (book / "book.json").write_text('{"id":"book_a","enabled":true}', encoding="utf-8")
    chars = book / "characters"
    chars.mkdir(parents=True)
    (tmp_path / "data" / "categories.yaml").write_text(CATEGORIES_YAML, encoding="utf-8")
    for slug, meta in (("已标注", {"worldbook_id": "book_a"}), ("未标注", {})):
        entity = chars / slug
        entity.mkdir()
        (entity / "index.md").write_text(
            frontmatter.dumps(frontmatter.Post("正文。", name=slug, **meta)), encoding="utf-8")

    app = Flask(__name__)
    scene.register(app, {
        "document": DocumentManager(str(tmp_path)),
        "session": None,
        "worldbook": None,
    })
    app.config.update(TESTING=True)

    resp = app.test_client().get("/api/characters")
    assert resp.status_code == 200
    docs = _by_id(resp.get_json())
    assert docs["已标注"]["worldbook_id"] == "book_a"
    assert docs["未标注"]["worldbook_id"] == "book_a"
