"""Split bundled plots out of the Arknights reference book.

Characters are copied into each story book and deliberately remain in the
reference book. Plot-specific non-character entries are moved.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re


STORY_SPECS = (
    {
        "id": "grey-lantern", "name": "灰灯渡口", "plot_uid": "plots_grey_lantern_index",
        "description": "卡牌战术剧情：在救人与取证之间选择，于末班渡桥汇合；胜利、败退和绕行都有完整尾声。",
        "character_uids": {
            "characters_博士_index", "characters_阿米娅_index", "characters_临光_index",
            "characters_闪灵_index", "characters_砾_index",
        },
        "content_uids": {
            "plots_grey_lantern_index", "world_灰灯渡口", "enemies_灰灯路障兵",
            "enemies_灰灯雇佣哨兵", "enemies_灰灯仓库弩手", "enemies_灰灯渡桥护卫",
        },
    },
    {
        "id": "near-light", "name": "长夜临光", "plot_uid": "plots_near-light_index",
        "optional_content_uids": {"plot_graph_near-light"},
        "character_uids": {
            "characters_临光_index", "characters_瑕光_index", "characters_砾_index",
            "characters_玛恩纳·临光_index", "characters_焰尾_index", "characters_托兰_index",
            "characters_佐菲娅_index", "characters_闪灵_index", "characters_白金_index",
            "characters_血骑士_index", "characters_薇薇安娜_index", "characters_逐魇骑士_index",
            "characters_青金罗伊_index", "characters_青金莫妮克_index", "characters_玄铁大位_index",
            "characters_罗素_index", "characters_阿米娅_index",
        },
        "content_uids": {
            "plots_near-light_index", "plot_graph_near-light",
            "enemies_无胄盟清洗小队", "enemies_锈铜骑士",
            "items_临光的旧铠甲", "items_托兰的雇佣证明", "items_指挥官护甲",
            "items_焰尾的感染者合同数据", "items_瑕光工坊外的监视照片",
            "items_商业联合会内部会议纪要", "items_商业联合会内部清洗的证据",
            "items_感染者合同数据",
            "factions_商业联合会_index", "factions_监证会_index", "factions_无胄盟_index",
            "factions_红松骑士团_index", "factions_临光家族_index", "factions_罗德岛_index",
        },
    },
    {
        "id": "fengxue-guojing", "name": "风雪过境", "plot_uid": "plots_fengxue_guojing_index",
        "character_uids": {
            "characters_银灰_index", "characters_灵知_index", "characters_初雪_index",
            "characters_崖心_index", "characters_锏_index", "characters_大长老_index",
            "characters_菈塔托丝·布朗陶_index", "characters_阿克托斯·佩尔罗契_index",
            "characters_博士_index", "characters_耶拉_index",
        },
        "content_uids": {
            "plots_fengxue_guojing_index", "enemies_山雪鬼", "enemies_山雪鬼队长",
            "enemies_雪原爪兽", "items_喀兰铁路设计图", "items_耶拉冈德之石",
            "Location_Kjerag_喀兰贸易会客厅_index", "Location_Kjerag_谢拉格小镇_index",
            "Location_Kjerag_雪山大典广场_index", "Location_Kjerag_圣山山路_index",
            "Location_Kjerag_圣山祭坛_index",
            "factions_喀兰贸易_index", "factions_布朗陶家族_index",
            "factions_佩尔罗契家族_index", "factions_罗德岛_index",
            "factions_谢拉格_index", "weather_snow_index",
        },
    },
    {
        "id": "combat-test", "name": "战斗功能测试", "plot_uid": "plots_combat-test_index",
        "character_uids": {
            "characters_阿米娅_index", "characters_银灰_index", "characters_灵知_index",
        },
        "content_uids": {
            "plots_combat-test_index", "enemies_整合运动士兵", "enemies_整合运动术师",
            "Location_Rhode_Island_Training Room_index",
            "factions_罗德岛_index", "factions_整合运动_index",
        },
    },
    {
        "id": "beyond-twin", "name": "彼岸双生", "plot_uid": "plots_beyond_twin_index",
        "description": "近未来都市 AI 悬疑世界书：程叙与妮可在日常生活中相遇，并从数字回声追索主体、陪伴与回家的意义。",
        "character_uids": {
            "characters_妮可_index", "characters_程叙_index",
            "characters_林奈_index", "characters_杜可_index",
        },
        "content_uids": {
            "plots_beyond_twin_index", "world_彼岸双生",
            "factions_澜晶科技", "factions_量子智元之心",
            "Location_深湾市", "Location_旧城200室", "Location_澜晶科技办公区",
            "Location_深湾商场", "Location_海岸餐厅", "Location_旧城200室·病中",
            "Location_澜晶机器人工厂",
            "items_黑猫玩偶", "items_Agent终端",
        },
        "dynamic_uids": {
            "factions_澜晶科技", "factions_量子智元之心",
            "Location_深湾市", "Location_旧城200室", "Location_澜晶科技办公区",
            "Location_深湾商场", "Location_海岸餐厅", "Location_旧城200室·病中",
            "Location_澜晶机器人工厂",
            "items_黑猫玩偶", "items_Agent终端",
            "characters_妮可_index", "characters_程叙_index",
            "characters_林奈_index", "characters_杜可_index",
        },
    },
)

_ENTRY_SUFFIX_RE = re.compile(r"[（(]([^（()）]{1,16})[)）]\s*$")
_SUFFIX_CATEGORIES = {
    "世界观设定": {"id": "worldview", "name": "世界观设定", "scope_type": "worldview", "parent_id": None, "sort_order": 10},
    "规则设定": {"id": "rules", "name": "规则设定", "scope_type": "worldview", "parent_id": "worldview", "sort_order": 11},
    "属性设定": {"id": "attributes", "name": "属性设定", "scope_type": "worldview", "parent_id": "worldview", "sort_order": 12},
    "种族设定": {"id": "races", "name": "种族设定", "scope_type": "worldview", "parent_id": "worldview", "sort_order": 13},
    "职业设定": {"id": "classes", "name": "职业设定", "scope_type": "worldview", "parent_id": "worldview", "sort_order": 14},
    "天气设定": {"id": "weather", "name": "天气设定", "scope_type": "worldview", "parent_id": "worldview", "sort_order": 15},
    "地点设定": {"id": "locations", "name": "地点设定", "scope_type": "worldview", "parent_id": "worldview", "sort_order": 16},
    "角色设定": {"id": "characters", "name": "角色设定", "scope_type": "character", "parent_id": None, "sort_order": 20},
    "势力设定": {"id": "factions", "name": "势力设定", "scope_type": "other", "parent_id": None, "sort_order": 25},
    "物品设定": {"id": "items", "name": "物品设定", "scope_type": "other", "parent_id": None, "sort_order": 30},
    "敌人设定": {"id": "enemies", "name": "敌人设定", "scope_type": "other", "parent_id": None, "sort_order": 31},
    "剧情设定": {"id": "plots", "name": "剧情设定", "scope_type": "other", "parent_id": None, "sort_order": 32},
}
_PLOT_GRAPH_CATEGORY = {"id": "plot_graph", "name": "节点图", "scope_type": "other", "parent_id": None, "sort_order": 33}


def compact_story_entry_names(book: dict) -> dict:
    """把生成条目名末尾的类别后缀迁入显式分类字段。"""
    categories = {item.get("id"): copy.deepcopy(item) for item in book.get("categories", [])
                  if isinstance(item, dict) and item.get("id")}
    for entry in book.get("entries", []):
        if not isinstance(entry, dict):
            continue
        uid = str(entry.get("uid") or "")
        if uid.startswith("plot_graph_"):
            entry["category_id"] = _PLOT_GRAPH_CATEGORY["id"]
            categories[_PLOT_GRAPH_CATEGORY["id"]] = copy.deepcopy(_PLOT_GRAPH_CATEGORY)
            continue
        match = _ENTRY_SUFFIX_RE.search(str(entry.get("name") or ""))
        category = _SUFFIX_CATEGORIES.get(match.group(1)) if match else None
        if category is None:
            continue
        entry["name"] = str(entry.get("name") or "")[:match.start()].strip()
        entry["category_id"] = category["id"]
        if category["id"] == "characters" and uid.startswith("characters_") and uid.endswith("_index"):
            entry["character_id"] = uid[len("characters_"):-len("_index")]
        categories[category["id"]] = copy.deepcopy(category)
    for category in list(categories.values()):
        parent_id = category.get("parent_id")
        if parent_id and parent_id not in categories:
            parent = next(
                (item for item in _SUFFIX_CATEGORIES.values() if item["id"] == parent_id),
                None,
            )
            if parent is not None:
                categories[parent_id] = copy.deepcopy(parent)
    book["categories"] = sorted(categories.values(), key=lambda item: item.get("sort_order", 0))
    return book


def _edge_inside(edge: dict, known: set[str]) -> bool:
    return edge.get("from_uid") in known and edge.get("to_uid") in known


def _categories_for(book: dict, entries: list[dict]) -> list[dict] | None:
    categories = book.get("categories")
    if not isinstance(categories, list):
        return None
    used = {entry.get("category_id", "unclassified") for entry in entries}
    by_id = {item.get("id"): item for item in categories if isinstance(item, dict)}
    pending = list(used)
    while pending:
        parent = by_id.get(pending.pop(), {}).get("parent_id")
        if parent and parent not in used:
            used.add(parent)
            pending.append(parent)
    return [copy.deepcopy(item) for item in categories if item.get("id") in used]


def _rules_for(inject_uids: list[str]) -> dict:
    return {
        "roots": [{"entry_uid": uid, "activation": "always", "expansion": "none",
                   "character_ids": []} for uid in inject_uids],
        "root_rule": {"entry_uids": sorted(inject_uids)},
    }


def _filter_base_metadata(book: dict, known: set[str]) -> None:
    for field in ("dependency_edges", "related_edges"):
        if isinstance(book.get(field), list):
            book[field] = [edge for edge in book[field] if _edge_inside(edge, known)]
    rules = book.get("dependency_rules")
    if isinstance(rules, dict):
        roots = [root for root in rules.get("roots", []) if root.get("entry_uid") in known]
        book["dependency_rules"] = {
            "roots": roots,
            "root_rule": {"entry_uids": sorted(root["entry_uid"] for root in roots)},
        }
    config = book.get("import_config")
    if isinstance(config, dict):
        book["import_config"] = {"revision": max(1, int(config.get("revision", 1) or 1))}
    book["policy_revisions"] = []
    if isinstance(book.get("entry_order"), list):
        book["entry_order"] = [uid for uid in book["entry_order"] if uid in known]


def _rewrite_plot_graph(entry: dict, book_id: str) -> None:
    if entry.get("category_id") != "plot_graph" and not str(entry.get("uid", "")).startswith("plot_graph_"):
        return
    entry["content"] = str(entry.get("content", "")).replace(
        '"worldbook_id":"arknights"', f'"worldbook_id":"{book_id}"')


def split_builtin_book(source: dict) -> tuple[dict, dict[str, dict]]:
    """Return the reduced reference book and configured standalone story books."""
    if not isinstance(source, dict) or not isinstance(source.get("entries"), list):
        raise ValueError("source must be a worldbook object with entries")
    by_uid = {entry.get("uid"): entry for entry in source["entries"] if isinstance(entry, dict)}
    missing_by_story = {
        spec["id"]: sorted(
            (set(spec["character_uids"]) | set(spec["content_uids"]))
            - set(spec.get("optional_content_uids", ())) - set(by_uid)
        )
        for spec in STORY_SPECS
    }
    missing_by_story = {
        story_id: missing for story_id, missing in missing_by_story.items() if missing
    }
    if missing_by_story:
        details = "; ".join(
            f"{story_id}: {', '.join(missing)}"
            for story_id, missing in missing_by_story.items()
        )
        raise ValueError(f"missing required story entries: {details}")

    moved_non_characters: set[str] = set()
    stories: dict[str, dict] = {}
    for spec in STORY_SPECS:
        selected = set(spec["character_uids"]) | set(spec["content_uids"])
        dynamic_uids = set(spec.get("dynamic_uids", ()))
        entries = [copy.deepcopy(entry) for entry in source["entries"] if entry.get("uid") in selected]
        for entry in entries:
            uid = entry.get("uid")
            if uid != "plot_graph_near-light":
                is_dynamic = uid in dynamic_uids
                entry["always_active"] = not is_dynamic
                entry["position"] = 1 if is_dynamic else 0
            _rewrite_plot_graph(entry, spec["id"])
        known = {entry["uid"] for entry in entries}
        inject_uids = [entry["uid"] for entry in entries if entry.get("uid") != "plot_graph_near-light"]
        story = {
            "id": spec["id"], "name": spec["name"],
            "description": spec.get(
                "description",
                f"从“明日方舟·内置设定集”拆分的《{spec['name']}》剧情与关联内容。",
            ),
            "source": "preinstalled", "enabled": True, "book_type": "story",
            "source_format": "builtin", "budget_tokens": 0,
            "schema_version": 3, "scope_mode": "selective", "entries": entries,
            "entry_order": [entry["uid"] for entry in entries],
            "dependency_edges": [copy.deepcopy(edge) for edge in source.get("dependency_edges", [])
                                 if _edge_inside(edge, known)],
            "related_edges": [copy.deepcopy(edge) for edge in source.get("related_edges", [])
                               if _edge_inside(edge, known)],
            "dependency_rules": _rules_for(inject_uids),
            "import_config": {"revision": 1},
            "policy_revisions": [],
        }
        categories = _categories_for(source, entries)
        if categories is not None:
            story["categories"] = categories
        compact_story_entry_names(story)
        stories[spec["id"]] = story
        moved_non_characters.update(spec["content_uids"])

    base = copy.deepcopy(source)
    base["entries"] = [entry for entry in base["entries"] if entry.get("uid") not in moved_non_characters]
    known = {entry["uid"] for entry in base["entries"]}
    _filter_base_metadata(base, known)
    base["name"] = "明日方舟·内置设定集"
    base["book_type"] = "reference"
    base["description"] = "明日方舟通用设定资料书；内置剧情已拆分为独立世界书。"
    base["schema_version"] = 3
    base["scope_mode"] = "selective"
    base["entry_order"] = [entry["uid"] for entry in base["entries"]]
    base["dependency_edges"] = list(base.get("dependency_edges") or [])
    base["related_edges"] = list(base.get("related_edges") or [])
    base["dependency_rules"] = _rules_for([])
    base["import_config"] = {"revision": 1}
    base["policy_revisions"] = []
    compact_story_entry_names(base)
    for category in base.get("categories", []):
        if category.get("id") == "factions":
            category["sort_order"] = 17
    base["categories"] = sorted(
        base.get("categories", []), key=lambda item: item.get("sort_order", 0))
    return base, stories


def pack_revision(book: dict) -> str:
    """Match ``world_book._pack_rev`` without importing the application."""
    payload = json.dumps(
        {"id": book.get("id", ""), "name": book.get("name", ""),
         "entries": book.get("entries", [])},
        ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def write_books(reference: dict, stories: dict[str, dict], output_dir, *, stamp_from=None) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    for payload in (reference, *stories.values()):
        if stamp_from is not None:
            pack_path = stamp_from / f"{payload['id']}.json"
            if pack_path.is_file():
                payload["pack_rev"] = pack_revision(
                    json.loads(pack_path.read_text(encoding="utf-8")))
        (output_dir / f"{payload['id']}.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
