"""Resolve runtime content from installed worldbook folders in binding order."""

from __future__ import annotations

import json
import os
import re
from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import Iterable

from data_paths import installed_books_root


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
                       project_root: str | Path | None = None) -> list[tuple[str, Path]]:
    """Return existing content paths in binding order with their owner IDs."""
    key = _safe_relative(relative)
    ordered = list(dict.fromkeys(book_ids)) if book_ids is not None else enabled_book_ids(project_root)
    result: list[tuple[str, Path]] = []
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
    return result


def resolve_content(relative: str, *, book_ids: Iterable[str] | None = None,
                    project_root: str | Path | None = None) -> Path | None:
    candidates = content_candidates(relative, book_ids=book_ids,
                                    project_root=project_root)
    return candidates[0][1] if candidates else None


def category_roots(category: str, *, book_ids: Iterable[str] | None = None,
                   project_root: str | Path | None = None) -> list[tuple[str, Path]]:
    return [(owner, path) for owner, path in content_candidates(
        category, book_ids=book_ids, project_root=project_root) if path.is_dir()]
