"""文档实体的「来源世界书」标注：`DocumentInfo.worldbook_id` 的读取与旧数据兼容。

`worldbook_id` 写在实体目录 index.md 的 frontmatter 里，导入角色卡时由
`character_card._stamp_worldbook_id` 写入（随卡自带的内嵌世界书即由此标注）。
前端「角色库 / 资产 / 卡牌」按它做来源分组，因此这里钉住三件事：

1. 已标注的实体在列表里带出该 id，且**不依赖** `include_content`；
2. 缺字段的旧数据不报错，返回空串（前端按「未分类」处理）；
3. `null` 不炸（落回空串）；空白串后端原样透传，由前端 `worldbookKeyOf` 归一为未分类。
"""

import os
import sys

import frontmatter
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from document_manager import DocumentManager

CATEGORIES_YAML = """
categories:
  characters: data/worldbooks/content/characters/
"""


@pytest.fixture()
def manager(tmp_path):
    """一个只含 characters 类别的临时项目根。"""
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "categories.yaml").write_text(CATEGORIES_YAML, encoding="utf-8")
    chars = tmp_path / "data" / "worldbooks" / "content" / "characters"
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


def test_worldbook_id_read_from_frontmatter(manager):
    docs = _by_id(manager.list_documents("characters", include_content=True))
    assert docs["已标注"]["worldbook_id"] == "book_a"
    # 缺字段 / null / 空白 → 空串，前端归一为「未分类」
    assert docs["未标注"]["worldbook_id"] == ""
    assert docs["空值"]["worldbook_id"] == ""
    assert docs["空白"]["worldbook_id"] == "   "


def test_worldbook_id_available_without_content_summary(manager):
    """不请求内容摘要时也要能拿到来源标注（分组只依赖它）。"""
    docs = _by_id(manager.list_documents("characters"))
    assert docs["已标注"]["worldbook_id"] == "book_a"
    assert docs["未标注"]["worldbook_id"] == ""
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
    """端点层：`/api/characters` 每个条目都带 `worldbook_id`（前端角色库据此分组）。

    只注册读路由，`session` / `worldbook` 给最小替身（`/api/characters` 不使用它们）。
    事件外的旧数据（无该字段）也必须出现这个键且为空串，前端才不用做存在性判断。
    """
    from flask import Flask
    from blueprints import scene
    from document_manager import DocumentManager

    chars = tmp_path / "data" / "worldbooks" / "content" / "characters"
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
    assert docs["未标注"]["worldbook_id"] == ""
