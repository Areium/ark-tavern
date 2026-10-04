"""Bounded, non-executing storage for portable browser combat modes.

Only validated bytes are published. Installed folders are mutable user input;
callers freeze the validated Package into a session before running it.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile
import threading
import uuid
import zipfile
from dataclasses import dataclass

from data_paths import PROJECT_ROOT

ABI = "ark-combat/1"
MAX_FILES = 512
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_PACKAGE_BYTES = 32 * 1024 * 1024
MAX_MANIFEST_BYTES = 64 * 1024
_ID = re.compile(r"[a-z][a-z0-9-]{0,63}\Z")
_VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?\Z")
_DEVICE = re.compile(r"(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?\Z", re.I)
BUILTIN_IDS = frozenset({"narrative", "tactical", "sideview"})


def mode_id(value: str) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value) or _DEVICE.fullmatch(value):
        raise ValueError("Invalid combat mode ID")
    return value


def relative_path(value: str) -> str:
    if (not isinstance(value, str) or not value or "\\" in value or ":" in value
            or PurePosixPath(value).is_absolute()):
        raise ValueError("Invalid package path")
    for part in value.split("/"):
        if (part in ("", ".", "..") or part.rstrip(" .") != part
                or _DEVICE.fullmatch(part) or any(ord(c) < 32 or c in '<>"|?*' for c in part)):
            raise ValueError("Unsafe package path")
    return value


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def _json(raw: bytes) -> dict:
    try:
        data = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs,
                          parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
    except (UnicodeError, RecursionError) as exc:
        raise ValueError("Invalid UTF-8 JSON") from exc
    if not isinstance(data, dict):
        raise ValueError("Expected JSON object")
    return data


def _real(info):
    return not (stat.S_ISLNK(info.st_mode)
                or getattr(info, "st_file_attributes", 0) & 0x400)


@dataclass(frozen=True)
class Package:
    manifest: dict
    files: dict[str, bytes]
    digest: str

    def summary(self):
        return {**self.manifest, "digest": self.digest,
                "description": self.manifest.get("description", ""),
                "size": sum(map(len, self.files.values())), "file_count": len(self.files)}

    def archive(self) -> bytes:
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, raw in sorted(self.files.items()):
                archive.writestr(name, raw)
        return output.getvalue()


def validate_files(files: dict[str, bytes], expected_id: str | None = None) -> Package:
    if len(files) > MAX_FILES or sum(map(len, files.values())) > MAX_PACKAGE_BYTES:
        raise ValueError("Package exceeds size/file limit")
    seen = set()
    for name, raw in files.items():
        relative_path(name)
        if name.casefold() in seen:
            raise ValueError("Case-insensitive duplicate package path")
        seen.add(name.casefold())
        if len(raw) > MAX_FILE_BYTES:
            raise ValueError(f"File exceeds size limit: {name}")
    # A file cannot also be a directory, including on case-insensitive Windows.
    for name in seen:
        if any(parent.as_posix() in seen for parent in PurePosixPath(name).parents
               if parent.as_posix() != "."):
            raise ValueError("Package file/directory collision")
    raw = files.get("manifest.json")
    if raw is None or len(raw) > MAX_MANIFEST_BYTES:
        raise ValueError("Missing or oversized manifest.json")
    manifest = _json(raw)
    allowed = {"id", "name", "version", "abi", "description", "entry", "input", "resources", "practice"}
    if manifest.keys() - allowed:
        raise ValueError("Unknown manifest fields: " + ", ".join(sorted(manifest.keys() - allowed)))
    identifier = mode_id(manifest.get("id"))
    if identifier in BUILTIN_IDS:
        raise ValueError("Reserved built-in combat mode ID")
    if expected_id is not None and identifier != expected_id:
        raise ValueError("Folder name and mode ID differ")
    if not isinstance(manifest.get("version"), str) or not _VERSION.fullmatch(manifest["version"]):
        raise ValueError("version must be semantic major.minor.patch")
    if manifest.get("abi") != ABI:
        raise ValueError(f"Unsupported combat ABI; expected {ABI}")
    if not isinstance(manifest.get("name"), str) or not 1 <= len(manifest["name"].strip()) <= 100:
        raise ValueError("name must contain 1..100 characters")
    if not isinstance(manifest.get("description", ""), str) or len(manifest.get("description", "")) > 2000:
        raise ValueError("description must contain at most 2000 characters")
    entry = relative_path(manifest.get("entry"))
    if not entry.endswith(".js") or entry not in files:
        raise ValueError("entry must reference a bundled .js file")
    try:
        files[entry].decode("utf-8")
    except UnicodeError as exc:
        raise ValueError("entry must be UTF-8 JavaScript") from exc
    contract = manifest.get("input")
    if (not isinstance(contract, dict) or set(contract) - {"id", "version", "required", "resources"}
            or not {"id", "version", "required"}.issubset(contract)
            or not isinstance(contract["id"], str) or not _ID.fullmatch(contract["id"])
            or type(contract["version"]) is not int or contract["version"] < 1
            or not isinstance(contract["required"], list)
            or any(not isinstance(k, str) or not _ID.fullmatch(k) for k in contract["required"])
            or len(set(contract["required"])) != len(contract["required"])):
        raise ValueError("input must declare id, positive integer version, unique required field names")
    content_resources = contract.get("resources", [])
    if (not isinstance(content_resources, list)
            or any(not isinstance(key, str) for key in content_resources)):
        raise ValueError("input.resources must be an array of resource names")
    for name in content_resources:
        relative_path(name)
    if len(set(content_resources)) != len(content_resources):
        raise ValueError("Duplicate required content resource")
    resources = manifest.get("resources", [])
    if not isinstance(resources, list) or any(not isinstance(x, str) for x in resources):
        raise ValueError("resources must be a path array")
    if len(set(resources)) != len(resources):
        raise ValueError("Duplicate resource")
    for name in resources:
        if relative_path(name) not in files:
            raise ValueError(f"Missing resource: {name}")
    if set(content_resources) & set(resources):
        raise ValueError("Content resources cannot shadow package resources")
    if "practice" in manifest:
        practice = relative_path(manifest["practice"])
        if practice not in files or len(files[practice]) > MAX_MANIFEST_BYTES:
            raise ValueError("practice must reference a small JSON input file")
        value = _json(files[practice])
        missing = set(contract["required"]) - value.keys()
        if missing:
            raise ValueError("practice missing input fields: " + ", ".join(sorted(missing)))
        if content_resources:
            raise ValueError("practice is unavailable when worldbook resources are required")
    digest = hashlib.sha256()
    for name, raw in sorted(files.items()):
        digest.update(name.encode("utf-8") + b"\0" + hashlib.sha256(raw).digest())
    return Package(manifest, dict(files), digest.hexdigest())


def read_folder(folder: Path, expected_id: str | None = None) -> Package:
    folder = Path(folder)
    info = folder.lstat()
    if not _real(info) or not stat.S_ISDIR(info.st_mode):
        raise ValueError("Package folder must be a real directory, not a link/junction")
    files = {}
    pending = [folder]
    total = count = 0
    while pending:
        with os.scandir(pending.pop()) as entries:
            for entry in entries:
                name = relative_path(Path(entry.path).relative_to(folder).as_posix())
                info = entry.stat(follow_symlinks=False)
                count += 1
                if count > MAX_FILES * 2:
                    raise ValueError("Too many package entries")
                if not _real(info):
                    raise ValueError("Links and junctions are not allowed in packages")
                if stat.S_ISDIR(info.st_mode):
                    pending.append(Path(entry.path))
                elif stat.S_ISREG(info.st_mode):
                    if info.st_size > MAX_FILE_BYTES:
                        raise ValueError("File exceeds size limit")
                    with open(entry.path, "rb") as stream:
                        raw = stream.read(MAX_FILE_BYTES + 1)
                    total += len(raw)
                    if len(raw) > MAX_FILE_BYTES or total > MAX_PACKAGE_BYTES:
                        raise ValueError("Package exceeds size limit")
                    files[name] = raw
                else:
                    raise ValueError("Unsupported package entry")
    return validate_files(files, expected_id)


def read_archive(raw: bytes) -> Package:
    if len(raw) > MAX_PACKAGE_BYTES:
        raise ValueError("Archive exceeds size limit")
    files = {}
    total = 0
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_FILES * 2:
                raise ValueError("Too many archive entries")
            seen = set()
            for entry in entries:
                if entry.orig_filename != entry.filename:
                    raise ValueError("Archive path contains NUL or noncanonical characters")
                name = relative_path(entry.filename.rstrip("/") if entry.is_dir() else entry.filename)
                if name.casefold() in seen:
                    raise ValueError("Duplicate archive path")
                seen.add(name.casefold())
                kind = stat.S_IFMT(entry.external_attr >> 16)
                if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or entry.flag_bits & 1:
                    raise ValueError("Links, special files and encrypted archives are unsupported")
                if entry.is_dir():
                    continue
                total += entry.file_size
                if entry.file_size > MAX_FILE_BYTES or total > MAX_PACKAGE_BYTES:
                    raise ValueError("Archive expands beyond size limit")
                with archive.open(entry) as stream:
                    content = stream.read(MAX_FILE_BYTES + 1)
                if len(content) != entry.file_size:
                    raise ValueError("Archive entry size mismatch")
                files[name] = content
    except (zipfile.BadZipFile, NotImplementedError, RuntimeError) as exc:
        raise ValueError("Invalid or unsupported ZIP archive") from exc
    # Accept either the folder itself zipped or a ZIP with manifest at its root.
    if "manifest.json" not in files and files:
        roots = {name.split("/")[0] for name in files}
        if len(roots) == 1 and all("/" in name for name in files):
            files = {name.split("/", 1)[1]: raw for name, raw in files.items()}
    return validate_files(files)


class CombatModePackages:
    def __init__(self, project_root: Path | str = PROJECT_ROOT):
        self.root = Path(project_root) / "data" / "combat_modes"
        self.archive_root = Path(project_root) / "data" / "combat_mode_archive"
        self._lock = threading.RLock()

    def _check_roots(self):
        # The project directory is trusted configuration, but plugin directories
        # themselves may have been manually replaced by junctions/symlinks.
        for path in (self.root.parent, self.root, self.archive_root):
            if path.exists() or path.is_symlink():
                info = path.lstat()
                if not _real(info) or not stat.S_ISDIR(info.st_mode):
                    raise ValueError("Plugin storage must use real directories")

    def _directory(self, identifier):
        self._check_roots()
        identifier = mode_id(identifier)
        if identifier in BUILTIN_IDS:
            raise ValueError("Built-in modes cannot be modified as installed packages")
        return self.root / identifier

    def _state(self):
        path = self.root / ".state.json"
        if not path.exists():
            return {}
        if not _real(path.lstat()) or path.stat().st_size > MAX_MANIFEST_BYTES:
            raise ValueError("Invalid plugin state file")
        state = _json(path.read_bytes())
        if any(not isinstance(v, bool) for v in state.values()):
            raise ValueError("Invalid plugin enabled state")
        return state

    def _save_state(self, state):
        self.root.mkdir(parents=True, exist_ok=True)
        handle, name = tempfile.mkstemp(prefix=".state-", dir=self.root)
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                json.dump(state, stream, ensure_ascii=False)
            os.replace(name, self.root / ".state.json")
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def list(self):
        with self._lock:
            self._check_roots()
            state = self._state()
            modes, errors = [], []
            if self.root.exists():
                for folder in sorted(self.root.iterdir()):
                    if folder.name.startswith("."):
                        continue
                    try:
                        mode_id(folder.name)
                        package = read_folder(folder, folder.name)
                        modes.append({**package.summary(), "enabled": state.get(folder.name, True)})
                    except (OSError, ValueError) as exc:
                        errors.append({"id": folder.name, "error": str(exc)})
            return {"modes": modes, "errors": errors}

    def get(self, identifier, *, require_enabled=True):
        with self._lock:
            path = self._directory(identifier)
            if require_enabled and not self._state().get(identifier, True):
                raise ValueError("Combat mode is disabled")
            return read_folder(path, identifier)

    def install(self, raw: bytes):
        package = read_archive(raw)
        with self._lock:
            destination = self._directory(package.manifest["id"])
            self.root.mkdir(parents=True, exist_ok=True)
            if destination.exists() or destination.is_symlink():
                raise ValueError("Mode already installed; uninstall it before replacing")
            staging = Path(tempfile.mkdtemp(prefix=".install-", dir=self.root))
            try:
                for name, content in package.files.items():
                    path = staging / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(content)
                # Never replace a concurrent installation.
                staging.rename(destination)
            finally:
                if staging.exists():
                    shutil.rmtree(staging)
            return package.summary()

    def set_enabled(self, identifier, enabled: bool):
        if type(enabled) is not bool:
            raise ValueError("enabled must be boolean")
        with self._lock:
            self.get(identifier, require_enabled=False)
            state = self._state()
            state[identifier] = enabled
            self._save_state(state)

    def uninstall(self, identifier):
        with self._lock:
            folder = self._directory(identifier)
            # A damaged package can still be removed, but never follow a link.
            info = folder.lstat()
            if not _real(info) or not stat.S_ISDIR(info.st_mode):
                raise ValueError("Cannot archive a linked or non-directory package")
            self.archive_root.mkdir(parents=True, exist_ok=True)
            target = self.archive_root / f"{identifier}-{uuid.uuid4().hex}"
            folder.rename(target)
            return {"id": identifier, "archived_to": str(target)}
