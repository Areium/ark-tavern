"""
card_json_loader — 战术卡单一真相源（design 方案 §10.1 / P0-4）。

运行时战术卡只从 data/classes/<职业>/cards.json 读取：
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
from data_paths import CONTENT_ROOT
from content_scope import is_content_visible

logger = logging.getLogger(__name__)

_CLASS_DIR = CONTENT_ROOT / "classes"

_cache: dict[str, list[Card]] = {}
_cache_lock = threading.Lock()


def clear_cache() -> None:
    """清除缓存（数据文件被外部修改后调用）。"""
    with _cache_lock:
        _cache.clear()


def load_class_cards(char_class: str, data_dir: str | Path | None = None) -> list[Card]:
    """读取某职业的 cards.json 并转换为 Card 列表（未找到返回 []）。"""
    if (not char_class or char_class in (".", "..")
            or "/" in char_class or "\\" in char_class
            or Path(char_class).name != char_class):
        return []
    base = Path(data_dir) if data_dir is not None else _CLASS_DIR
    path = base / char_class / "cards.json"
    try:
        if path.resolve() != path.absolute() or not path.resolve().is_relative_to(base.resolve()):
            return []
    except (OSError, ValueError):
        return []
    if (data_dir is None or base.resolve() == _CLASS_DIR.resolve()) and not is_content_visible(path, content_base=base.parent):
        with _cache_lock:
            _cache.pop(char_class, None)
        return []

    with _cache_lock:
        if char_class in _cache and data_dir is None:
            return list(_cache[char_class])

    if not path.is_file():
        logger.warning("cards.json not found: %s", path)
        return []

    try:
        with open(path, "r", encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError) as e:
        logger.error("Failed to load cards.json %s: %s", path, e)
        return []

    cards = [Card.from_dict(d) for d in doc.get("cards", [])]
    if data_dir is None:
        with _cache_lock:
            _cache[char_class] = cards
    return list(cards)


def load_all_class_cards(data_dir: str | Path | None = None) -> dict[str, list[Card]]:
    """读取全部职业卡表 {职业名: [Card]}。"""
    base = Path(data_dir) if data_dir else _CLASS_DIR
    scoped = data_dir is None or base.resolve() == _CLASS_DIR.resolve()
    result: dict[str, list[Card]] = {}
    if not base.is_dir():
        return result
    for subdir in sorted(base.iterdir()):
        path = subdir / "cards.json"
        if path.is_file() and (not scoped or is_content_visible(path, content_base=base.parent)):
            result[subdir.name] = load_class_cards(subdir.name, data_dir)
    return result
