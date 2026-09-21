"""返修回归（保留项）：related 边与 roots 元数据在写盘 / 酒馆格式往返导出后逐字保留。

这些字段（`locked` / `rejected` / `origin` / `model` / `evidence` / `review_status` /
`edge_meta`）早就写进了旧书的 JSON。AI 自动构建依赖下线后它们改为**停写不删**：
新写入不再产生新值，但旧书读回、导出酒馆格式、再导入必须原样透传。
"""
import copy
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from world_book import DEFAULT_CATEGORIES, WorldBook, WorldBookEntry, WorldBookManager


def entry(uid, content, name="", character_id="", category_id="unclassified", **kwargs):
    return WorldBookEntry(uid, content=content, name=name or uid,
                          character_id=character_id, category_id=category_id,
                          always_active=True, **kwargs)


def fixture_book():
    return WorldBook("bk", "返修测试书", [
        entry("world", "泰拉世界的基础设定，源石与天灾。", name="世界设定", category_id="worldview"),
        entry("a", "角色A：罗德岛干员。他使用源石技艺。", name="角色A", character_id="A",
              category_id="characters"),
        entry("tech", "源石技艺的定义与规则。", name="源石技艺"),
    ], categories=copy.deepcopy(DEFAULT_CATEGORIES))


def test_related_and_metadata_survive_disk_and_export(tmp_path):
    manager = WorldBookManager(tmp_path/'books')
    book = fixture_book()
    book.adopt_v2_as_v3()
    book.related_edges=[{'from_uid':'a','to_uid':'tech'}]
    book.dependency_rules['roots'][0]['locked']=True
    book.dependency_rules['rejected']=[{'from_uid':'tech','to_uid':'a'}]
    manager.save(book)
    manager._cache.clear()
    loaded=manager.load(book.id)
    assert loaded.related_edges==book.related_edges
    assert loaded.dependency_rules['roots'][0]['locked']
    imported,_=manager.import_book('roundtrip',json.dumps(loaded.export_st()))
    assert imported.related_edges==book.related_edges
    assert imported.dependency_rules['rejected']==book.dependency_rules['rejected']
