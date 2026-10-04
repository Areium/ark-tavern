"""Static worldbook-to-mode compatibility checks; never execute plugin code."""
from __future__ import annotations

import base64
from dataclasses import dataclass
import hashlib
import json
import mimetypes
from pathlib import Path
import re
import stat
import shutil
import tempfile

from combat_mode_packages import (MAX_FILE_BYTES, MAX_PACKAGE_BYTES, Package, _json,
                                  _real, relative_path, read_archive)
from combat_mode_runs import MAX_STATE_BYTES, validate_input
from worldbook_content import resolve_content

MAX_ENCOUNTERS = 128
MAX_FROZEN_BYTES = 48 * 1024 * 1024


def binding_digest(package_digest, encounters):
    encoded = json.dumps({"package_digest": package_digest, "encounters": encounters},
                         sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _input_size(entry):
    return len(json.dumps({key: entry[key] for key in ("name", "worldbook_id", "input")},
                          ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


@dataclass(frozen=True)
class PreparedBinding:
    package: Package
    encounters: dict
    digest: str

    def summary(self):
        return {"mode_id": self.package.manifest["id"], "version": self.package.manifest["version"],
                "package_digest": self.package.digest, "binding_digest": self.digest,
                "encounters": [{"id": key, "name": item["name"], "worldbook_id": item["worldbook_id"]}
                               for key, item in self.encounters.items()]}


def _asset(book_id, relative, project_root, limit):
    relative_path(relative)
    path = resolve_content(relative, book_ids=[book_id], project_root=project_root)
    if path is None:
        raise ValueError(f"Missing resource: {relative}")
    info = path.lstat()
    if not _real(info) or not stat.S_ISREG(info.st_mode) or info.st_size > limit:
        raise ValueError(f"Resource is not a bounded regular file: {relative}")
    with path.open("rb") as stream:
        content = stream.read(limit + 1)
    if len(content) > limit:
        raise ValueError(f"Resource exceeds size limit: {relative}")
    return content


def prepare_binding(package: Package, book_ids: list[str], project_root: Path | str) -> PreparedBinding:
    """Freeze validated content in memory before a session transaction publishes it.

    The API caller verifies enabled story-book objects first. Other selected
    books may provide only lore, but at least one must adapt this mode.
    """
    if (not isinstance(book_ids, list) or any(not isinstance(value, str) for value in book_ids)
            or len(book_ids) > 64 or len(set(book_ids)) != len(book_ids)):
        raise ValueError("worldbook_ids must contain up to 64 unique IDs")
    identifier = package.manifest["id"]
    contract = package.manifest["input"]
    required_resources = set(contract.get("resources", []))
    encounters = {}
    # Bound the whole frozen package/content, not merely each individual file.
    total = sum(map(len, package.files.values()))
    adapter_name = f"combat/modes/{identifier}.json"
    for book_id in book_ids:
        if resolve_content(adapter_name, book_ids=[book_id], project_root=project_root) is None:
            continue
        try:
            raw = _asset(book_id, adapter_name, project_root, MAX_STATE_BYTES)
            adapter = _json(raw)
            if set(adapter) != {"mode", "interface", "encounters"} or adapter["mode"] != identifier:
                raise ValueError("Adapter must declare mode, interface and encounters")
            interface = adapter["interface"]
            if (not isinstance(interface, dict) or set(interface) != {"id", "version"}
                    or interface["id"] != contract["id"] or type(interface["version"]) is not int
                    or interface["version"] != contract["version"]):
                raise ValueError(f"Interface mismatch; expected {contract['id']} v{contract['version']}")
            entries = adapter["encounters"]
            if not isinstance(entries, dict) or not entries:
                raise ValueError("Adapter encounters must be a nonempty object")
            for encounter_id, encounter in entries.items():
                if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", encounter_id):
                    raise ValueError(f"Invalid encounter ID: {encounter_id}")
                if encounter_id in encounters:
                    raise ValueError(f"Duplicate encounter ID across selected books: {encounter_id}")
                if (not isinstance(encounter, dict) or set(encounter) - {"name", "input", "resources"}
                        or not isinstance(encounter.get("name"), str)
                        or not 1 <= len(encounter["name"].strip()) <= 100):
                    raise ValueError(f"{encounter_id}: invalid encounter name or fields")
                try:
                    inputs = validate_input(package, encounter.get("input"))
                except ValueError as exc:
                    raise ValueError(f"{encounter_id}: {exc}") from exc
                resources = encounter.get("resources", {})
                if not isinstance(resources, dict):
                    raise ValueError(f"{encounter_id}: resources must map names to book-relative paths")
                missing = required_resources - resources.keys()
                if missing:
                    raise ValueError(f"{encounter_id}: missing required resources: {', '.join(sorted(missing))}")
                frozen_resources = {}
                for name, relative in resources.items():
                    relative_path(name)
                    if name in package.manifest.get("resources", []):
                        raise ValueError(f"{encounter_id}: resource shadows package resource: {name}")
                    content = _asset(book_id, relative, project_root, MAX_FILE_BYTES)
                    total += len(content)
                    if total > MAX_PACKAGE_BYTES:
                        raise ValueError("Combined mode and content exceed 32 MiB")
                    mime = mimetypes.guess_type(relative)[0] or "application/octet-stream"
                    frozen_resources[name] = f"data:{mime};base64," + base64.b64encode(content).decode("ascii")
                encounters[encounter_id] = {"name": encounter["name"], "worldbook_id": book_id,
                                            "input": inputs, "resources": frozen_resources}
                total += _input_size(encounters[encounter_id])
                if len(encounters) > MAX_ENCOUNTERS:
                    raise ValueError("Too many encounters (maximum 128)")
        except (OSError, ValueError) as exc:
            raise ValueError(f"Worldbook {book_id}, {adapter_name}: {exc}") from exc
    if not encounters:
        raise ValueError(f"Selected worldbooks contain no {adapter_name} adapter")
    if total > MAX_PACKAGE_BYTES:
        raise ValueError("Combined mode and content exceed 32 MiB")
    return PreparedBinding(package, encounters, binding_digest(package.digest, encounters))


def freeze_binding(session_dir: Path, binding: PreparedBinding):
    """Publish one immutable directory inside a not-yet-published session."""
    session_dir = Path(session_dir)
    session_dir.mkdir(parents=True, exist_ok=True)
    target = session_dir / "combat_plugin"
    if target.exists() or target.is_symlink():
        raise ValueError("Session combat mode is already frozen")
    staging = Path(tempfile.mkdtemp(prefix=".combat-plugin-", dir=session_dir))
    try:
        (staging / "package.zip").write_bytes(binding.package.archive())
        metadata = {"mode_id": binding.package.manifest["id"],
                    "package_digest": binding.package.digest, "binding_digest": binding.digest,
                    "encounters": binding.encounters}
        (staging / "binding.json").write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")
        staging.rename(target)
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def read_frozen_binding(session_dir: Path, expected_mode: str) -> PreparedBinding:
    """Revalidate imported/saved bytes. A digest is integrity, not author trust."""
    folder = Path(session_dir) / "combat_plugin"
    for directory in (Path(session_dir), folder):
        info = directory.lstat()
        if not _real(info) or not stat.S_ISDIR(info.st_mode):
            raise ValueError("Frozen mode must use real directories")
    def read(name, limit):
        path = folder / name
        info = path.lstat()
        if not _real(info) or not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError("Invalid frozen mode file")
        with path.open("rb") as stream:
            raw = stream.read(limit + 1)
        if len(raw) > limit:
            raise ValueError("Frozen mode file exceeds size limit")
        return raw
    package = read_archive(read("package.zip", MAX_PACKAGE_BYTES))
    metadata = _json(read("binding.json", MAX_FROZEN_BYTES))
    if (package.manifest["id"] != expected_mode or metadata.get("mode_id") != expected_mode
            or metadata.get("package_digest") != package.digest):
        raise ValueError("Frozen combat mode identity mismatch")
    entries = metadata.get("encounters")
    if not isinstance(entries, dict) or not 1 <= len(entries) <= MAX_ENCOUNTERS:
        raise ValueError("Invalid frozen encounter collection")
    total = sum(map(len, package.files.values()))
    for key, entry in entries.items():
        if (not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", key) or not isinstance(entry, dict)
                or set(entry) != {"name", "worldbook_id", "input", "resources"}
                or not isinstance(entry["name"], str) or not 1 <= len(entry["name"]) <= 100
                or not isinstance(entry["worldbook_id"], str)):
            raise ValueError("Invalid frozen encounter")
        validate_input(package, entry["input"])
        total += _input_size(entry)
        if total > MAX_PACKAGE_BYTES:
            raise ValueError("Frozen input and resources exceed size limit")
        resources = entry["resources"]
        if (not isinstance(resources, dict)
                or set(package.manifest["input"].get("resources", [])) - resources.keys()):
            raise ValueError("Missing frozen encounter resources")
        for name, data_url in resources.items():
            relative_path(name)
            if name in package.manifest.get("resources", []):
                raise ValueError("Frozen resource shadows package resource")
            if (not isinstance(data_url, str) or len(data_url) > MAX_FILE_BYTES * 4 // 3 + 256
                    or not re.match(r"^data:[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+;base64,", data_url)):
                raise ValueError("Invalid frozen resource")
            content = base64.b64decode(data_url.split(",", 1)[1], validate=True)
            total += len(content)
            if len(content) > MAX_FILE_BYTES or total > MAX_PACKAGE_BYTES:
                raise ValueError("Frozen resources exceed size limit")
    digest = binding_digest(package.digest, entries)
    if metadata.get("binding_digest") != digest:
        raise ValueError("Frozen combat binding fingerprint mismatch")
    return PreparedBinding(package, entries, digest)
