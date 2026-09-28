"""Visibility of installed book files and unowned local content."""

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Iterable

from data_paths import (
    CONTENT_ROOT, WORLDBOOKS_ROOT, content_root, installed_books_root,
    worldbooks_root,
)


@lru_cache(maxsize=8)
def _read_manifest(path: Path, mtime_ns: int, size: int) -> tuple[dict, dict] | None:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
        directories = manifest["directories"]
        files = manifest["files"]
        if isinstance(directories, dict) and isinstance(files, dict):
            return directories, files
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None


@lru_cache(maxsize=8)
def _read_local_manifest(path: Path, mtime_ns: int, size: int) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        files = data["files"]
        return files if isinstance(files, dict) else None
    except (OSError, ValueError, KeyError, TypeError):
        return None


@lru_cache(maxsize=64)
def _book_enabled(path: Path, mtime_ns: int, size: int) -> bool:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return (isinstance(payload, dict) and payload.get("enabled", True) is True
                and path.name == "book.json" and payload.get("id") == path.parent.name)
    except (OSError, ValueError, AttributeError):
        return False


def invalidate_visibility_cache() -> None:
    """Forget visibility metadata after an explicit bookshelf refresh."""
    _book_enabled.cache_clear()
    _read_manifest.cache_clear()
    _read_local_manifest.cache_clear()


def is_content_visible(path: str | Path, *, project_root: str | Path | None = None,
                       content_base: str | Path | None = None,
                       allowed_book_ids: Iterable[str] | None = None) -> bool:
    """Expose enabled folder books or unowned local files in the shared tree.

    Old manifests only identify shared files to hide; they never grant runtime
    access to an old flat worldbook. ``content_base`` selects a standalone
    content directory for callers that do not use the checkout default.
    """
    if content_base is not None:
        root = Path(content_base)
        books_root = root.parent
    else:
        root = content_root(project_root) if project_root is not None else CONTENT_ROOT
        books_root = worldbooks_root(project_root) if project_root is not None else WORLDBOOKS_ROOT
    root = Path(os.path.abspath(root))
    candidate = Path(os.path.abspath(path))
    folder_books = Path(os.path.abspath(installed_books_root(project_root)))
    try:
        book_relative = candidate.relative_to(folder_books)
    except ValueError:
        book_relative = None
    if book_relative is not None and len(book_relative.parts) >= 2:
        book_id = book_relative.parts[0]
        if allowed_book_ids is not None and book_id not in allowed_book_ids:
            return False
        folder = folder_books / book_id
        if (folder.is_symlink() or folder.resolve() != folder or
                any(part.startswith(".") for part in book_relative.parts)):
            return False
        current = folder
        for part in book_relative.parts[1:]:
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
    try:
        relative = candidate.relative_to(root)
    except ValueError:
        return False

    # A symlink may move a path outside the content tree, or impersonate a
    # different manifest entry within it.  Reject either case before lookup.
    if candidate.resolve() != candidate or root.resolve() != root:
        return False
    if not relative.parts:
        return allowed_book_ids is None
    if any(part.startswith(".") for part in relative.parts):
        return False

    manifest_path = books_root / "content_manifest.json"
    local_path = books_root / "local_content_manifest.json"
    if manifest_path.is_file():
        try:
            stat = manifest_path.stat()
        except OSError:
            return False
        parsed = _read_manifest(manifest_path, stat.st_mtime_ns, stat.st_size)
        if parsed is None:
            return False
        directories, files = parsed
    else:
        # A packaged checkout without its distribution manifest must not expose
        # its bundled assets. Standalone/test roots may have no distribution.
        if root == Path(os.path.abspath(CONTENT_ROOT)):
            return False
        directories, files = {}, {}
    local_files = {}
    if local_path.is_file():
        try:
            stat = local_path.stat()
        except OSError:
            return False
        local_files = _read_local_manifest(local_path, stat.st_mtime_ns, stat.st_size)
        if local_files is None:
            return False

    key = relative.as_posix()
    owners = files.get(key)
    if owners is None:
        matches = [entry for entry in directories
                   if isinstance(entry, str) and entry.endswith("/")
                   and (key.startswith(entry) or key + "/" == entry)]
        owners = directories[max(matches, key=len)] if matches else None
    if owners is not None and not isinstance(owners, list):
        return False
    additional = local_files.get(key)
    if additional is None and candidate.is_dir():
        prefix = key.rstrip("/") + "/"
        descendants = [value for path_key, value in local_files.items()
                       if isinstance(path_key, str) and path_key.startswith(prefix)]
        if any(not isinstance(value, list) or
               any(not isinstance(owner, str) for owner in value)
               for value in descendants):
            return False
        additional = list(dict.fromkeys(owner for value in descendants for owner in value))
        if not additional:
            additional = None
    if additional is not None:
        if not isinstance(additional, list):
            return False
        owners = [*(owners or []), *additional]
    return owners is None and allowed_book_ids is None
