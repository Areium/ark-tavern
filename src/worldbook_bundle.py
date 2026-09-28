"""Portable, bounded worldbook archives with content ownership tracking."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import threading
import time
import zipfile
from contextlib import contextmanager
from pathlib import Path, PurePosixPath


FORMAT = "arkwb"
VERSION = 1
MAX_FILES = 10_000
MAX_FILE_SIZE = 64 * 1024 * 1024
MAX_TOTAL_SIZE = 2 * 1024 * 1024 * 1024
MAX_METADATA_SIZE = 16 * 1024 * 1024
MAX_BOOK_SIZE = 256 * 1024 * 1024
_ID = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
_HASH = re.compile(r"[0-9a-f]{64}\Z")
_WINDOWS_DEVICE = re.compile(r"(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?\Z", re.I)
_CHUNK = 1024 * 1024
_INSTALL_LOCK = threading.RLock()


@contextmanager
def _manifest_lock(path: Path):
    """Serialize ownership updates across threads and app processes."""
    lock_path = path.with_name(".local_content_manifest.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    if lock_path.is_symlink():
        raise ValueError("Symlink ownership lock")
    with _INSTALL_LOCK, lock_path.open("a+b") as handle:
        handle.seek(0)
        if handle.read(1) == b"":
            handle.write(b"\0")
            handle.flush()
        deadline = time.monotonic() + 30
        while True:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("Worldbook resource ownership is busy")
                time.sleep(0.1)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


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


def _json_bytes(value: dict) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


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


def _file_digest(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(_CHUNK):
            size += len(chunk)
            if size > MAX_FILE_SIZE:
                raise ValueError("Resource exceeds size limit")
            digest.update(chunk)
    return digest.hexdigest(), size


def _owned_by(value: object, book_id: str) -> bool:
    return isinstance(value, list) and book_id in value


def _source_resources(book_id: str, worldbooks_dir: Path, content_dir: Path) -> list[tuple[str, Path]]:
    manifest_path = worldbooks_dir / "content_manifest.json"
    manifest = _read_json(manifest_path.read_bytes()) if manifest_path.exists() else {}
    directories = manifest.get("directories", {})
    files = manifest.get("files", {})
    if not isinstance(directories, dict) or not isinstance(files, dict):
        raise ValueError("Invalid distribution content manifest")
    local_path = worldbooks_dir / "local_content_manifest.json"
    local = _read_json(local_path.read_bytes()) if local_path.exists() else {}
    local_files = local.get("files", {})
    if not isinstance(local_files, dict):
        raise ValueError("Invalid local content manifest")

    selected: dict[str, Path] = {}
    all_files: list[tuple[str, Path]] = []
    if content_dir.exists():
        _no_links(content_dir, content_dir)
        for base, dirs, names in os.walk(content_dir, followlinks=False):
            base_path = Path(base)
            dirs[:] = [name for name in dirs if not (base_path / name).is_symlink()]
            for name in names:
                path = base_path / name
                if path.is_symlink():
                    continue
                if not path.is_file():
                    continue
                key = path.relative_to(content_dir).as_posix()
                _relative(key)
                all_files.append((key, path))

    # Distribution ownership follows the runtime rule: exact files first,
    # otherwise the longest matching directory prefix.
    for key, path in all_files:
        owners = files.get(key)
        if owners is None:
            prefixes = [prefix for prefix in directories
                        if isinstance(prefix, str) and prefix.endswith("/") and key.startswith(prefix)]
            owners = directories[max(prefixes, key=len)] if prefixes else None
        if _owned_by(owners, book_id) or _owned_by(local_files.get(key), book_id):
            selected[key] = path

    # User content outside either manifest can declare ownership on an index
    # (the whole directory) or a JSON file (that file alone).
    user_files = {key: path for key, path in all_files
                  if key not in files and not any(
                      isinstance(prefix, str) and prefix.endswith("/") and key.startswith(prefix)
                      for prefix in directories) and key not in local_files}
    owned_directories: set[str] = set()
    for key, path in user_files.items():
        if path.suffix.lower() not in {".md", ".json"}:
            continue
        if path.stat().st_size > MAX_FILE_SIZE:
            raise ValueError(f"Unclassified content exceeds size limit: {key}")
        if path.suffix.lower() == ".md":
            try:
                lines = path.read_text(encoding="utf-8-sig").splitlines()
            except UnicodeError:
                continue
            if lines and lines[0].strip() == "---":
                for line in lines[1:]:
                    if line.strip() == "---":
                        break
                    match = re.fullmatch(r"\s*worldbook_id\s*:\s*['\"]?([^'\"#\s]+)['\"]?\s*", line)
                    if match and match.group(1) == book_id:
                        if path.name == "index.md":
                            owned_directories.add(path.parent.relative_to(content_dir).as_posix() + "/")
                        else:
                            selected[key] = path
        elif path.suffix.lower() == ".json":
            try:
                if _read_json(path.read_bytes()).get("worldbook_id") == book_id:
                    selected[key] = path
            except (UnicodeError, ValueError):
                pass
    for key, path in user_files.items():
        if any(key.startswith(prefix) for prefix in owned_directories):
            selected[key] = path
    if len(selected) > MAX_FILES:
        raise ValueError("Too many resources")
    return sorted(selected.items())


def export_bundle(book_payload: dict, book_id: str, worldbooks_dir: Path,
                  content_dir: Path, target: Path) -> dict:
    """Write a complete .arkwb archive without overwriting an existing target."""
    book_id = _book_id(book_id)
    if not isinstance(book_payload, dict):
        raise ValueError("Worldbook must be a JSON object")
    if book_payload.get("id") != book_id:
        raise ValueError("Worldbook ID does not match archive ID")
    worldbooks_dir, content_dir, target = map(Path, (worldbooks_dir, content_dir, target))
    if target.exists() or target.is_symlink():
        raise FileExistsError(target)
    book_data = _json_bytes(book_payload)
    if len(book_data) > MAX_BOOK_SIZE:
        raise ValueError("Worldbook exceeds size limit")
    resources = []
    total = 0
    for key, path in _source_resources(book_id, worldbooks_dir, content_dir):
        _no_links(path, content_dir)
        digest, size = _file_digest(path)
        total += size
        if total > MAX_TOTAL_SIZE:
            raise ValueError("Bundle exceeds size limit")
        resources.append({"path": key, "sha256": digest, "size": size})
    manifest = {"format": FORMAT, "version": VERSION, "book_id": book_id,
                "resources": resources}
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=target.parent, suffix=".arkwb", delete=False) as temp:
        temp_path = Path(temp.name)
    try:
        with zipfile.ZipFile(temp_path, "w", compression=zipfile.ZIP_DEFLATED,
                             allowZip64=True) as archive:
            archive.writestr("book.json", book_data)
            archive.writestr("manifest.json", _json_bytes(manifest))
            for item in resources:
                source = content_dir.joinpath(*PurePosixPath(item["path"]).parts)
                _no_links(source, content_dir)
                archive.write(source, "content/" + item["path"])
                if _file_digest(source) != (item["sha256"], item["size"]):
                    raise ValueError("Resource changed during export")
        try:
            os.link(temp_path, target)
        except FileExistsError:
            raise
        except OSError:
            # Filesystems without hard links still get exclusive creation.
            created_target = False
            try:
                with target.open("xb") as output, temp_path.open("rb") as source:
                    created_target = True
                    shutil.copyfileobj(source, output, _CHUNK)
            except Exception:
                if created_target:
                    target.unlink(missing_ok=True)
                raise
    finally:
        temp_path.unlink(missing_ok=True)
    return manifest


def _zip_digest(archive: zipfile.ZipFile, item: zipfile.ZipInfo) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with archive.open(item) as source:
        while chunk := source.read(_CHUNK):
            size += len(chunk)
            if size > MAX_FILE_SIZE:
                raise ValueError("Resource exceeds size limit")
            digest.update(chunk)
    return digest.hexdigest(), size


def install_bundle(archive_path: Path, book_target: Path, content_dir: Path,
                   local_manifest_path: Path) -> dict:
    with _manifest_lock(Path(local_manifest_path)):
        return _install_bundle_locked(archive_path, book_target, content_dir,
                                      local_manifest_path)


def remove_book_ownership(local_manifest_path: Path, book_id: str) -> None:
    """Retire imported ownership while keeping empty records hidden."""
    book_id = _book_id(book_id)
    path = Path(local_manifest_path)
    with _manifest_lock(path):
        if not path.exists():
            return
        if path.is_symlink():
            raise ValueError("Symlink local manifest")
        data = _read_json(path.read_bytes())
        files = data.get("files")
        if not isinstance(files, dict):
            raise ValueError("Invalid local content manifest")
        changed = False
        for key, owners in files.items():
            _relative(key)
            if not isinstance(owners, list) or any(not isinstance(owner, str) for owner in owners):
                raise ValueError("Invalid local owner list")
            if book_id in owners:
                files[key] = [owner for owner in owners if owner != book_id]
                changed = True
        if not changed:
            return
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temp:
            temporary = Path(temp.name)
            temp.write(_json_bytes(data))
        try:
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def _install_bundle_locked(archive_path: Path, book_target: Path, content_dir: Path,
                           local_manifest_path: Path) -> dict:
    """Validate the entire archive, then install resources, book, and owners."""
    archive_path, book_target, content_dir, local_manifest_path = map(
        Path, (archive_path, book_target, content_dir, local_manifest_path))
    if book_target.exists() or book_target.is_symlink():
        raise FileExistsError(book_target)
    created: list[Path] = []
    temp_manifest: Path | None = None
    with zipfile.ZipFile(archive_path) as archive:
        entries: dict[str, zipfile.ZipInfo] = {}
        folded: set[str] = set()
        for info in archive.infolist():
            name = info.filename
            if info.is_dir() or name.startswith("/") or "\\" in name:
                raise ValueError("Unsafe archive member")
            _relative(name)
            if name in entries or name.casefold() in folded:
                raise ValueError("Duplicate archive member")
            if stat.S_IFMT(info.external_attr >> 16) == stat.S_IFLNK:
                raise ValueError("Archive contains symlink")
            limit = (MAX_BOOK_SIZE if name == "book.json" else
                     MAX_METADATA_SIZE if name == "manifest.json" else MAX_FILE_SIZE)
            if info.file_size > limit:
                raise ValueError("Archive member exceeds size limit")
            entries[name] = info
            folded.add(name.casefold())
        if len(entries) > MAX_FILES + 2 or sum(i.file_size for i in entries.values()) > MAX_TOTAL_SIZE + MAX_BOOK_SIZE + MAX_METADATA_SIZE:
            raise ValueError("Archive exceeds size limit")
        if "book.json" not in entries or "manifest.json" not in entries:
            raise ValueError("Missing bundle metadata")
        if entries["book.json"].file_size > MAX_BOOK_SIZE or entries["manifest.json"].file_size > MAX_METADATA_SIZE:
            raise ValueError("Bundle metadata exceeds size limit")
        book_data = archive.read("book.json")
        book = _read_json(book_data)
        manifest = _read_json(archive.read("manifest.json"))
        if manifest.get("format") != FORMAT or type(manifest.get("version")) is not int or manifest["version"] != VERSION:
            raise ValueError("Unsupported bundle format")
        book_id = _book_id(manifest.get("book_id"))
        if book_target.stem != book_id:
            raise ValueError("Bundle ID does not match target")
        if book.get("id") != book_id:
            raise ValueError("Worldbook ID does not match archive ID")
        resources = manifest.get("resources")
        if not isinstance(resources, list) or len(resources) > MAX_FILES:
            raise ValueError("Invalid resource list")
        expected = {"book.json", "manifest.json"}
        pending: list[tuple[zipfile.ZipInfo, Path, str]] = []
        total = 0
        for resource in resources:
            if not isinstance(resource, dict):
                raise ValueError("Invalid resource record")
            key = resource.get("path")
            relative = _relative(key)
            digest = resource.get("sha256")
            size = resource.get("size")
            if not isinstance(digest, str) or not _HASH.fullmatch(digest) or type(size) is not int or not 0 <= size <= MAX_FILE_SIZE:
                raise ValueError("Invalid resource digest or size")
            member = "content/" + key
            if member in expected or member not in entries:
                raise ValueError("Missing or duplicate resource")
            expected.add(member)
            info = entries[member]
            if info.file_size != size or _zip_digest(archive, info) != (digest, size):
                raise ValueError("Resource checksum mismatch")
            total += size
            if total > MAX_TOTAL_SIZE:
                raise ValueError("Bundle exceeds size limit")
            destination = content_dir.joinpath(*relative.parts)
            _no_links(destination, content_dir)
            if destination.exists():
                if not destination.is_file() or _file_digest(destination) != (digest, size):
                    raise FileExistsError(destination)
            pending.append((info, destination, key))
        if set(entries) != expected:
            raise ValueError("Unexpected archive member")
        if book_target.exists() or book_target.is_symlink():
            raise FileExistsError(book_target)
        if local_manifest_path.is_symlink():
            raise ValueError("Symlink local manifest")
        old_bytes = local_manifest_path.read_bytes() if local_manifest_path.exists() else None
        local = _read_json(old_bytes) if old_bytes is not None else {"files": {}}
        owners = local.get("files")
        if not isinstance(owners, dict):
            raise ValueError("Invalid local content manifest")
        for _, _, key in pending:
            current = owners.get(key, [])
            if not isinstance(current, list) or any(not isinstance(owner, str) for owner in current):
                raise ValueError("Invalid local owner list")
            owners[key] = list(dict.fromkeys([*current, book_id]))
        new_manifest = _json_bytes(local)
        try:
            for info, destination, _ in pending:
                if destination.exists():
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                _no_links(destination, content_dir)
                try:
                    with destination.open("xb") as output, archive.open(info) as source:
                        created.append(destination)
                        shutil.copyfileobj(source, output, _CHUNK)
                except FileExistsError:
                    if _file_digest(destination) != _zip_digest(archive, info):
                        raise
            book_target.parent.mkdir(parents=True, exist_ok=True)
            with book_target.open("xb") as output:
                created.append(book_target)
                output.write(book_data)
            local_manifest_path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=local_manifest_path.parent, delete=False) as temp:
                temp_manifest = Path(temp.name)
                temp.write(new_manifest)
            if (local_manifest_path.read_bytes() if local_manifest_path.exists() else None) != old_bytes:
                raise RuntimeError("Local content manifest changed during import")
            os.replace(temp_manifest, local_manifest_path)
            temp_manifest = None
        except Exception:
            if temp_manifest is not None:
                temp_manifest.unlink(missing_ok=True)
            for path in reversed(created):
                path.unlink(missing_ok=True)
            raise
    return {"book_id": book_id, "resources": len(resources), "book": book}
