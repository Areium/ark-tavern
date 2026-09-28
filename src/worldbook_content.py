"""Resolve content from installed worldbook directories in binding order.

Each installed folder owns its ordinary files.  A legacy shared content tree is
only a compatibility source for books that have not yet been migrated.
"""

from __future__ import annotations

import json
import os
import re
from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import Iterable

from data_paths import content_root, installed_books_root, worldbooks_root


_BOOK_ID = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
_DEVICE = re.compile(r"(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?\Z", re.I)


def _safe_relative(value: str | PurePosixPath) -> PurePosixPath:
    value = str(value)
    if not value or "\\" in value or ":" in value or "\x00" in value:
        raise ValueError("Invalid content path")
    relative = PurePosixPath(value)
    if (relative.is_absolute() or relative.as_posix() != value or
            any(part in ("", ".", "..") or part.rstrip(" .") != part
                or _DEVICE.fullmatch(part)
                for part in value.split("/"))):
        raise ValueError("Unsafe content path")
    return relative


def book_directory(book_id: str, project_root: str | Path | None = None) -> Path:
    if (not isinstance(book_id, str) or not _BOOK_ID.fullmatch(book_id)
            or _DEVICE.fullmatch(book_id)):
        raise ValueError("Invalid worldbook ID")
    return installed_books_root(project_root) / book_id


def book_file(book_id: str, project_root: str | Path | None = None) -> Path:
    return book_directory(book_id, project_root) / "book.json"


@lru_cache(maxsize=1024)
def _enabled(path: Path, mtime_ns: int, size: int) -> bool:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return (isinstance(data, dict) and data.get("id") == path.parent.name
                and data.get("enabled", True) is True)
    except (OSError, ValueError):
        return False


def invalidate_content_cache() -> None:
    """Forget metadata after an explicit bookshelf refresh."""
    _enabled.cache_clear()


def enabled_book_ids(project_root: str | Path | None = None) -> list[str]:
    """List usable folder books; callers with a session should pass its binding."""
    root = installed_books_root(project_root)
    if not root.is_dir():
        return []
    result = []
    for folder in sorted(root.iterdir()):
        if (not folder.is_dir() or folder.is_symlink()
                or not _BOOK_ID.fullmatch(folder.name) or _DEVICE.fullmatch(folder.name)):
            continue
        metadata = folder / "book.json"
        try:
            stat = metadata.stat()
        except OSError:
            continue
        if not metadata.is_symlink() and _enabled(metadata, stat.st_mtime_ns, stat.st_size):
            result.append(folder.name)
    return result


def _enabled_legacy_ids(project_root: str | Path | None = None) -> list[str]:
    books_root = installed_books_root(project_root)
    candidates = list(books_root.glob("*.json"))
    candidates.extend(worldbooks_root(project_root).glob("*.json"))
    result = []
    for path in sorted(candidates):
        book_id = path.stem
        if (not _BOOK_ID.fullmatch(book_id) or _DEVICE.fullmatch(book_id)
                or (books_root / book_id / "book.json").is_file() or book_id in {
                    "settings", "content_manifest", "local_content_manifest"}):
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if (isinstance(data, dict) and data.get("id") == book_id and
                data.get("enabled", True) is True and book_id not in result):
            result.append(book_id)
    return result


def _candidate(root: Path, relative: PurePosixPath) -> Path | None:
    root = Path(os.path.abspath(root))
    if root.is_symlink() or root.resolve() != root:
        return None
    candidate = root
    for part in relative.parts:
        candidate /= part
        if candidate.is_symlink():
            return None
    if not candidate.resolve().is_relative_to(root):
        return None
    return candidate


def content_candidates(relative: str, *, book_ids: Iterable[str] | None = None,
                       project_root: str | Path | None = None,
                       include_legacy: bool = True) -> list[tuple[str | None, Path]]:
    """Return existing content paths in binding order with their owner IDs."""
    key = _safe_relative(relative)
    ordered = list(dict.fromkeys(book_ids)) if book_ids is not None else enabled_book_ids(project_root)
    result: list[tuple[str | None, Path]] = []
    legacy_ids: list[str] = _enabled_legacy_ids(project_root) if book_ids is None else []
    for book_id in ordered:
        folder = book_directory(book_id, project_root)
        metadata = folder / "book.json"
        if metadata.is_file() and not metadata.is_symlink():
            stat = metadata.stat()
            if not _enabled(metadata, stat.st_mtime_ns, stat.st_size):
                continue
            path = _candidate(folder, key)
            if path is not None and path.exists():
                result.append((book_id, path))
        elif book_ids is not None:
            legacy_ids.append(book_id)
    if include_legacy and legacy_ids:
        legacy = _candidate(content_root(project_root), key)
        if legacy is not None and legacy.exists():
            # The old shared tree remains available only while legacy books
            # exist. Session-specific owner checks live in content_scope.
            from content_scope import is_content_visible
            if is_content_visible(legacy, project_root=project_root,
                                  allowed_book_ids=legacy_ids):
                result.append((None, legacy))
    return result


def resolve_content(relative: str, *, book_ids: Iterable[str] | None = None,
                    project_root: str | Path | None = None,
                    include_legacy: bool = True) -> Path | None:
    candidates = content_candidates(relative, book_ids=book_ids,
                                    project_root=project_root,
                                    include_legacy=include_legacy)
    return candidates[0][1] if candidates else None


def category_roots(category: str, *, book_ids: Iterable[str] | None = None,
                   project_root: str | Path | None = None,
                   include_legacy: bool = True) -> list[tuple[str | None, Path]]:
    roots = [(owner, path) for owner, path in content_candidates(
        category, book_ids=book_ids, project_root=project_root,
        include_legacy=include_legacy) if path.is_dir()]
    # A legacy manifest may own only nested files, so the category directory
    # itself has no owner. Readers still inspect each descendant's visibility.
    available_legacy = _enabled_legacy_ids(project_root)
    legacy_ids = (available_legacy if book_ids is None
                  else [book_id for book_id in book_ids if book_id in available_legacy])
    if include_legacy and legacy_ids:
        legacy = _candidate(content_root(project_root), _safe_relative(category))
        if legacy is not None and legacy.is_dir() and (None, legacy) not in roots:
            roots.append((None, legacy))
    return roots
