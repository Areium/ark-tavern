"""Explicit standalone tactical drill; never installed as worldbook content."""

import json
from pathlib import Path

import frontmatter

from combat_data_loader import CombatDataLoader
from combat_engine.card_data import get_starting_deck
from combat_nodes import node_overview
from combat_session import CombatSession
from worldbook_content import book_directory, category_roots, enabled_book_ids, resolve_content


PRACTICE_ROOT = Path(__file__).resolve().parent.parent / "data" / "tactical_practice"


def practice_party() -> list[dict]:
    return json.loads((PRACTICE_ROOT / "party.json").read_text(encoding="utf-8"))


class PracticeCombatSession(CombatSession):
    def __init__(self, session_id: str = "", *, book_ids=None):
        super().__init__(session_id, book_ids=[])
        self.loader = CombatDataLoader(data_dir=str(PRACTICE_ROOT / "combat"), book_ids=[])

    def _starting_deck(self, char_class):
        return get_starting_deck(char_class, data_dir=PRACTICE_ROOT / "classes")

    def _load_character_meta(self, name):
        return next((meta for meta in practice_party() if meta["name"] == name), None)

    def suspend_snapshot(self):
        return {**super().suspend_snapshot(), "practice_source": "builtin"}


def practice_catalog(book_id: str | None = None) -> dict:
    books = []
    for owner in enabled_book_ids():
        book = json.loads((book_directory(owner) / "book.json").read_text(encoding="utf-8"))
        books.append({"id": owner, "name": book.get("name") or owner})
    if book_id is None:
        loader = CombatDataLoader(data_dir=str(PRACTICE_ROOT / "combat"), book_ids=[])
        return {"books": books, "nodes": loader.list_nodes(),
                "characters": [meta["name"] for meta in practice_party()]}
    if book_id not in {book["id"] for book in books}:
        raise ValueError("世界书未安装或已停用，请重新选择演练内容")
    rows, _ = node_overview(book_id=book_id)
    characters = []
    for _, root in category_roots("characters", book_ids=[book_id]):
        for path in sorted(root.glob("*/index.md")):
            if resolve_content(f"characters/{path.parent.name}/index.md", book_ids=[book_id]) != path:
                continue
            # Tactical cards belong to classes; narrative combat.json is not required.
            meta = frontmatter.load(path).metadata
            if meta and path.parent.name not in characters:
                characters.append(path.parent.name)
    return {"books": books, "nodes": [row for row in rows if not row.get("missing")],
            "characters": characters}
