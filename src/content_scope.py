"""Visibility of distributable content after its owning worldbook is removed."""

import json
import os
from functools import lru_cache
from pathlib import Path

from data_paths import CONTENT_ROOT, WORLDBOOKS_ROOT, content_root, worldbooks_root


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
        return json.loads(path.read_text(encoding="utf-8")).get("enabled", True) is True
    except (OSError, ValueError, AttributeError):
        return False


def is_content_visible(path: str | Path, *, project_root: str | Path | None = None,
                       content_base: str | Path | None = None) -> bool:
    """Return whether a content path belongs to an enabled installed worldbook.

    Paths absent from the distribution manifest are user content. ``project_root``
    selects a checkout; ``content_base`` supports a configured standalone
    content directory (its manifest lives in the parent directory).
    """
    if content_base is not None:
        root = Path(content_base)
        books_root = root.parent
    else:
        root = content_root(project_root) if project_root is not None else CONTENT_ROOT
        books_root = worldbooks_root(project_root) if project_root is not None else WORLDBOOKS_ROOT
    root = Path(os.path.abspath(root))
    candidate = Path(os.path.abspath(path))
    try:
        relative = candidate.relative_to(root)
    except ValueError:
        return False

    # A symlink may move a path outside the content tree, or impersonate a
    # different manifest entry within it.  Reject either case before lookup.
    if candidate.resolve() != candidate or root.resolve() != root:
        return False
    if not relative.parts:
        return True
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
    if owners is None:
        return True
    if not isinstance(owners, list):
        return False
    for book_id in owners:
        if not isinstance(book_id, str) or not book_id or Path(book_id).name != book_id:
            continue
        book_path = books_root / "books" / f"{book_id}.json"
        if not book_path.is_file():
            book_path = books_root / f"{book_id}.json"
        try:
            stat = book_path.stat()
            if _book_enabled(book_path, stat.st_mtime_ns, stat.st_size):
                return True
        except OSError:
            continue
    return False
