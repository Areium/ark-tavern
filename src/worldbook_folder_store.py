"""Validation for self-contained worldbook folders."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path, PurePosixPath

MAX_BOOK_SIZE = 256 * 1024 * 1024
_ID = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
_WINDOWS_DEVICE = re.compile(r"(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?\Z", re.I)

# A local folder may contain large images and audio, but validation remains bounded.
_MAX_FOLDER_FILE_SIZE = 2 * 1024 * 1024 * 1024
_MAX_FOLDER_TOTAL_SIZE = 16 * 1024 * 1024 * 1024
_MAX_FOLDER_FILES = 100_000


def _book_id(value: str) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise ValueError("Invalid worldbook ID")
    return value


def _relative(value: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\\" in value or ":" in value or "\x00" in value:
        raise ValueError("Invalid content path")
    path = PurePosixPath(value)
    if (path.is_absolute() or path.as_posix() != value or
            any(part in ("", ".", "..") or part.rstrip(" .") != part or
                _WINDOWS_DEVICE.fullmatch(part) or any(ord(char) < 32 for char in part)
                for part in value.split("/"))):
        raise ValueError("Unsafe content path")
    return path


def _no_links(path: Path, root: Path) -> None:
    """Reject existing symlinks in every component, including the root."""
    root = Path(os.path.abspath(root))
    path = Path(os.path.abspath(path))
    try:
        parts = path.relative_to(root).parts
    except ValueError as exc:
        raise ValueError("Path escapes content root") from exc
    current = root
    if current.is_symlink():
        raise ValueError("Symlink in content path")
    for part in parts:
        current /= part
        if current.is_symlink():
            raise ValueError("Symlink in content path")


def _unique_pairs(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def _read_json(raw: bytes) -> dict:
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_pairs)
    if not isinstance(value, dict):
        raise ValueError("Expected JSON object")
    return value


def validate_folder(folder: Path, *, expected_id: str | None = None) -> dict:
    """Validate a complete external folder before exposing or copying it."""
    folder = Path(folder)
    book_id = _book_id(expected_id or folder.name)
    _relative(book_id)
    if folder.is_symlink() or not folder.is_dir():
        raise ValueError("Worldbook folder must be a real directory")
    _no_links(folder, folder)
    count = 0
    total = 0
    for base, dirs, files in os.walk(folder, followlinks=False):
        base_path = Path(base)
        for name in dirs + files:
            path = base_path / name
            _relative(path.relative_to(folder).as_posix())
            _no_links(path, folder)
            if path.is_symlink():
                raise ValueError("Symlink in worldbook folder")
            if path.is_file():
                count += 1
                size = path.stat().st_size
                if size > _MAX_FOLDER_FILE_SIZE and path.name != "book.json":
                    raise ValueError("Worldbook resource exceeds size limit")
                total += size
                if count > _MAX_FOLDER_FILES or total > _MAX_FOLDER_TOTAL_SIZE:
                    raise ValueError("Worldbook folder exceeds size limit")
            elif not path.is_dir():
                raise ValueError("Unsupported worldbook folder entry")
    book_path = folder / "book.json"
    if not book_path.is_file():
        raise ValueError("Worldbook folder is missing book.json")
    if book_path.stat().st_size > MAX_BOOK_SIZE:
        raise ValueError("Worldbook metadata exceeds size limit")
    payload = _read_json(book_path.read_bytes())
    if payload.get("id") != book_id:
        raise ValueError("Worldbook folder name and book ID differ")
    return payload
