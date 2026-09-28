"""
card_json_loader — 战术卡单一真相源（design 方案 §10.1 / P0-4）。

运行时战术卡从绑定世界书的 classes/<职业>/cards.json 读取：
- 完整透传 effects / ignore_def / cleanse / exhaust / rank / upgrade_branch /
  power_tier / cv_budget / cv_estimated / balance_version（Card.from_dict 白名单
  随 dataclass 字段自动扩展，未知键被忽略）；
- 每职业缓存一次，避免重复磁盘 IO；
- 不修改文件（编辑器写入由 blueprints/cards.py 负责，写后哈希由其在保存时重算）。
"""
import json
import logging
import threading
from pathlib import Path

from combat_engine.card import Card
from worldbook_content import category_roots, resolve_content

logger = logging.getLogger(__name__)

_CLASS_DIR: Path | None = None  # Explicit test/custom root only.

_cache: dict[tuple[str, int, int, tuple[str, ...] | None], list[Card]] = {}
_cache_lock = threading.Lock()


def clear_cache() -> None:
    """清除缓存（数据文件被外部修改后调用）。"""
    with _cache_lock:
        _cache.clear()


def load_class_cards(char_class: str, data_dir: str | Path | None = None,
                     *, book_ids: list[str] | None = None) -> list[Card]:
    """读取某职业的 cards.json 并转换为 Card 列表（未找到返回 []）。"""
    if (not char_class or char_class in (".", "..")
            or "/" in char_class or "\\" in char_class
            or Path(char_class).name != char_class):
        return []
    base = Path(data_dir) if data_dir is not None else _CLASS_DIR
    try:
        path = (base / char_class / "cards.json" if base is not None else
                resolve_content(f"classes/{char_class}/cards.json", book_ids=book_ids))
    except ValueError:
        return []
    if path is None:
        return []
    if base is not None and path.is_relative_to(base):
        try:
            if path.resolve() != path.absolute() or not path.resolve().is_relative_to(base.resolve()):
                return []
        except (OSError, ValueError):
            return []

    if not path.is_file():
        logger.warning("cards.json not found: %s", path)
        return []
    stat = path.stat()
    cache_key = (str(path), stat.st_mtime_ns, stat.st_size,
                 tuple(book_ids) if book_ids is not None else None)
    with _cache_lock:
        if cache_key in _cache and data_dir is None:
            return list(_cache[cache_key])

    try:
        with open(path, "r", encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError) as e:
        logger.error("Failed to load cards.json %s: %s", path, e)
        return []

    cards = [Card.from_dict(d) for d in doc.get("cards", [])]
    if data_dir is None:
        with _cache_lock:
            _cache[cache_key] = cards
    return list(cards)


def load_all_class_cards(data_dir: str | Path | None = None,
                         *, book_ids: list[str] | None = None) -> dict[str, list[Card]]:
    """读取全部职业卡表 {职业名: [Card]}。"""
    base = Path(data_dir) if data_dir else _CLASS_DIR
    result: dict[str, list[Card]] = {}
    try:
        roots = [(None, base)] if base is not None else category_roots(
            "classes", book_ids=book_ids)
    except ValueError:
        return result
    for _, root in roots:
        if not root.is_dir():
            continue
        for subdir in sorted(root.iterdir()):
            if subdir.name in result:
                continue
            path = subdir / "cards.json"
            if path.is_file():
                result[subdir.name] = load_class_cards(subdir.name, root,
                                                        book_ids=book_ids)
    return result
