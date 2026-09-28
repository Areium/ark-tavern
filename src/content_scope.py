"""Visibility gate for resources inside enabled worldbook folders."""

import json
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Iterable

from data_paths import installed_books_root


_BOOK_ID = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")


@lru_cache(maxsize=64)
def _book_enabled(path: Path, mtime_ns: int, size: int) -> bool:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return (isinstance(payload, dict) and path.name == "book.json"
                and payload.get("id") == path.parent.name
                and payload.get("enabled", True) is True)
    except (OSError, ValueError, AttributeError):
        return False


def invalidate_visibility_cache() -> None:
    """Forget enabled-book metadata after a bookshelf refresh."""
    _book_enabled.cache_clear()


def is_content_visible(path: str | Path, *, project_root: str | Path | None = None,
                       allowed_book_ids: Iterable[str] | None = None) -> bool:
    """Only expose paths owned by an enabled installed book."""
    root = Path(os.path.abspath(installed_books_root(project_root)))
    candidate = Path(os.path.abspath(path))
    try:
        relative = candidate.relative_to(root)
    except ValueError:
        return False
    if len(relative.parts) < 2:
        return False
    book_id = relative.parts[0]
    if not _BOOK_ID.fullmatch(book_id):
        return False
    if allowed_book_ids is not None and book_id not in allowed_book_ids:
        return False
    folder = root / book_id
    if folder.is_symlink() or folder.resolve() != folder:
        return False
    current = folder
    for part in relative.parts[1:]:
        if part.startswith("."):
            return False
        current /= part
        if current.is_symlink():
            return False
    metadata = folder / "book.json"
    try:
        stat = metadata.stat()
    except OSError:
        return False
    return (not metadata.is_symlink() and
            _book_enabled(metadata, stat.st_mtime_ns, stat.st_size))
