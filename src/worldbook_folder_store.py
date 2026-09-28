"""Validated, self-contained installed worldbook folders."""

from __future__ import annotations

import os
import shutil
import stat
import uuid
import zipfile
from pathlib import Path

from worldbook_bundle import (
    FORMAT, VERSION, MAX_BOOK_SIZE, MAX_METADATA_SIZE, MAX_FILES,
    MAX_FILE_SIZE, MAX_TOTAL_SIZE, _HASH, _book_id, _file_digest,
    _json_bytes, _no_links, _read_json, _relative, _source_resources,
    _zip_digest,
)

# Ordinary local folders are the primary storage format. Archive transfer has
# stricter limits; a large music or illustration file must not hide its book.
_MAX_FOLDER_FILE_SIZE = 2 * 1024 * 1024 * 1024
_MAX_FOLDER_TOTAL_SIZE = 16 * 1024 * 1024 * 1024
_MAX_FOLDER_FILES = 100_000


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


def copy_folder(source: Path, books_dir: Path) -> Path:
    """Copy a validated folder atomically, leaving its source untouched."""
    source, books_dir = Path(source), Path(books_dir)
    payload = validate_folder(source)
    target = books_dir / payload["id"]
    if target.exists() or target.is_symlink():
        raise FileExistsError(f"Worldbook {payload['id']} already exists")
    books_dir.mkdir(parents=True, exist_ok=True)
    temporary = books_dir / f".import-{uuid.uuid4().hex}"
    try:
        shutil.copytree(source, temporary, symlinks=True)
        # Check the copied files too; the source may have changed during copying.
        validate_folder(temporary, expected_id=payload["id"])
        if target.exists() or target.is_symlink():
            raise FileExistsError(f"Worldbook {payload['id']} already exists")
        temporary.rename(target)
        return target
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def migrate_json(source: Path, worldbooks_dir: Path) -> Path:
    """Copy an old JSON book and its owned global content into a new folder."""
    source, worldbooks_dir = Path(source), Path(worldbooks_dir)
    if source.is_symlink() or not source.is_file():
        raise ValueError("Legacy book source must be a regular file")
    book_id = _book_id(source.stem)
    payload = _read_json(source.read_bytes())
    if payload.get("id") != book_id:
        raise ValueError("Legacy filename and book ID differ")
    books_dir = worldbooks_dir / "books"
    target = books_dir / book_id
    if target.exists() or target.is_symlink():
        raise FileExistsError(f"Worldbook {book_id} already has a folder")
    resources = _source_resources(book_id, worldbooks_dir, worldbooks_dir / "content")
    books_dir.mkdir(parents=True, exist_ok=True)
    temporary = books_dir / f".migrate-{uuid.uuid4().hex}"
    try:
        temporary.mkdir()
        shutil.copy2(source, temporary / "book.json")
        for name, resource in resources:
            relative = _relative(name)
            if relative.as_posix() == "book.json":
                raise ValueError("Owned resource conflicts with book metadata")
            _no_links(resource, worldbooks_dir / "content")
            destination = temporary.joinpath(*relative.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(resource, destination)
        validate_folder(temporary, expected_id=book_id)
        if target.exists() or target.is_symlink():
            raise FileExistsError(f"Worldbook {book_id} already has a folder")
        temporary.rename(target)
        return target
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def install_archive(archive_path: Path, books_dir: Path) -> str:
    """Install a validated .arkwb into one self-contained folder."""
    books_dir = Path(books_dir)
    with zipfile.ZipFile(archive_path) as archive:
        entries = {}
        folded = set()
        for info in archive.infolist():
            name = info.filename
            if info.is_dir():
                raise ValueError("Directory archive member")
            _relative(name)
            if name in entries or name.casefold() in folded:
                raise ValueError("Duplicate archive member")
            if stat.S_IFMT(info.external_attr >> 16) == stat.S_IFLNK:
                raise ValueError("Archive contains symlink")
            limit = MAX_BOOK_SIZE if name == "book.json" else (MAX_METADATA_SIZE if name == "manifest.json" else MAX_FILE_SIZE)
            if info.file_size > limit:
                raise ValueError("Archive member exceeds size limit")
            entries[name] = info
            folded.add(name.casefold())
        if (len(entries) > MAX_FILES + 2 or
                sum(info.file_size for info in entries.values()) > MAX_TOTAL_SIZE + MAX_BOOK_SIZE + MAX_METADATA_SIZE):
            raise ValueError("Archive exceeds size limit")
        if "book.json" not in entries or "manifest.json" not in entries:
            raise ValueError("Missing bundle metadata")
        payload = _read_json(archive.read("book.json"))
        manifest = _read_json(archive.read("manifest.json"))
        if manifest.get("format") != FORMAT or manifest.get("version") != VERSION:
            raise ValueError("Unsupported bundle format")
        book_id = _book_id(manifest.get("book_id"))
        if payload.get("id") != book_id:
            raise ValueError("Worldbook ID does not match archive ID")
        target = books_dir / book_id
        if target.exists() or target.is_symlink():
            raise FileExistsError(f"Worldbook {book_id} already exists")
        resources = manifest.get("resources")
        if not isinstance(resources, list) or len(resources) > MAX_FILES:
            raise ValueError("Invalid resource list")
        expected = {"book.json", "manifest.json"}
        for item in resources:
            if not isinstance(item, dict):
                raise ValueError("Invalid resource record")
            key = _relative(item.get("path")).as_posix()
            digest, size = item.get("sha256"), item.get("size")
            if (key == "book.json" or key == "manifest.json" or
                    not isinstance(digest, str) or not _HASH.fullmatch(digest) or
                    type(size) is not int or not 0 <= size <= MAX_FILE_SIZE):
                raise ValueError("Invalid resource record")
            member = "content/" + key
            if member in expected or member not in entries:
                raise ValueError("Missing or duplicate resource")
            expected.add(member)
            if entries[member].file_size != size or _zip_digest(archive, entries[member]) != (digest, size):
                raise ValueError("Resource checksum mismatch")
        if set(entries) != expected:
            raise ValueError("Unexpected archive member")
        books_dir.mkdir(parents=True, exist_ok=True)
        temporary = books_dir / f".import-{uuid.uuid4().hex}"
        try:
            temporary.mkdir()
            (temporary / "book.json").write_bytes(archive.read("book.json"))
            for item in resources:
                destination = temporary.joinpath(*_relative(item["path"]).parts)
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open("content/" + item["path"]) as source, destination.open("xb") as output:
                    shutil.copyfileobj(source, output)
                if _file_digest(destination) != (item["sha256"], item["size"]):
                    raise ValueError("Resource changed during extraction")
            validate_folder(temporary, expected_id=book_id)
            if target.exists() or target.is_symlink():
                raise FileExistsError(f"Worldbook {book_id} already exists")
            temporary.rename(target)
            return book_id
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)


def export_folder(folder: Path, target: Path) -> dict:
    """Export the exact files belonging to a self-contained folder."""
    payload = validate_folder(folder)
    resources = []
    for path in sorted(folder.rglob("*")):
        if path.is_file() and path != folder / "book.json":
            key = path.relative_to(folder).as_posix()
            digest, size = _file_digest(path)
            resources.append({"path": key, "sha256": digest, "size": size})
    manifest = {"format": FORMAT, "version": VERSION, "book_id": payload["id"],
                "resources": resources}
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise FileExistsError(target)
    with zipfile.ZipFile(target, "x", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
        archive.writestr("book.json", _json_bytes(payload))
        archive.writestr("manifest.json", _json_bytes(manifest))
        for item in resources:
            archive.write(folder / item["path"], "content/" + item["path"])
    return manifest
