"""Durable standalone plugin rehearsals with immutable package snapshots.

The browser's outcome is explicitly unverified. Practice never grants rewards
or writes to story sessions. State mutations use revision compare-and-swap.
"""
from __future__ import annotations

import base64
import copy
import json
import math
import mimetypes
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
import threading
import time
import uuid

from combat_mode_packages import (ABI, MAX_PACKAGE_BYTES, Package, _json, _real,
                                  mode_id, read_archive)

MAX_STATE_BYTES = 1024 * 1024
_RUN_ID = re.compile(r"[0-9a-f]{32}\Z")
OUTCOMES = frozenset({"victory", "defeat", "retreat"})


class RunConflict(ValueError):
    """Stale write or a completed run; clients must reload before retrying."""


def json_object(value, label="snapshot") -> dict:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    pending = [(value, 0)]
    count = 0
    while pending:
        item, depth = pending.pop()
        count += 1
        if depth > 64 or count > MAX_STATE_BYTES:
            raise ValueError(f"{label} exceeds structural limit")
        if isinstance(item, dict):
            if any(not isinstance(key, str) for key in item):
                raise ValueError(f"{label} keys must be strings")
            pending.extend((entry, depth + 1) for entry in item.values())
        elif isinstance(item, list):
            pending.extend((entry, depth + 1) for entry in item)
        elif item is None or isinstance(item, (str, bool, int)):
            pass
        elif isinstance(item, float) and math.isfinite(item):
            pass
        else:
            raise ValueError(f"{label} must contain finite JSON values")
    try:
        raw = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (ValueError, UnicodeError, OverflowError) as exc:
        raise ValueError(f"Invalid {label}") from exc
    if len(raw) > MAX_STATE_BYTES:
        raise ValueError(f"{label} exceeds 1 MiB")
    return copy.deepcopy(value)


def validate_input(package: Package, value) -> dict:
    value = json_object(value, "input")
    missing = set(package.manifest["input"]["required"]) - value.keys()
    if missing:
        raise ValueError("Missing input fields: " + ", ".join(sorted(missing)))
    return value


def runtime_bundle(package: Package) -> dict:
    manifest = package.manifest
    resources = {}
    for name in manifest.get("resources", []):
        mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
        resources[name] = f"data:{mime};base64," + base64.b64encode(package.files[name]).decode("ascii")
    return {"abi": ABI, "id": manifest["id"], "name": manifest["name"],
            "version": manifest["version"], "digest": package.digest,
            "entry": base64.b64encode(package.files[manifest["entry"]]).decode("ascii"),
            "resources": resources}


class CombatModeRuns:
    def __init__(self, project_root):
        self.root = Path(project_root) / "data" / "combat_mode_runs"
        self._lock = threading.RLock()

    def _roots(self):
        for path in (self.root.parent, self.root):
            if path.exists() or path.is_symlink():
                info = path.lstat()
                if not _real(info) or not stat.S_ISDIR(info.st_mode):
                    raise ValueError("Run storage must use real directories")

    def _folder(self, run_id):
        self._roots()
        if not isinstance(run_id, str) or not _RUN_ID.fullmatch(run_id):
            raise ValueError("Invalid run ID")
        folder = self.root / run_id
        info = folder.lstat()
        if not _real(info) or not stat.S_ISDIR(info.st_mode):
            raise ValueError("Run must be a real directory")
        return folder

    @staticmethod
    def _read(path, limit):
        info = path.lstat()
        if not _real(info) or not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError("Invalid run file")
        with path.open("rb") as stream:
            raw = stream.read(limit + 1)
        if len(raw) > limit:
            raise ValueError("Run file exceeds size limit")
        return raw

    @staticmethod
    def _save(folder, value):
        handle, filename = tempfile.mkstemp(prefix=".state-", dir=folder)
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                json.dump(value, stream, ensure_ascii=False, allow_nan=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(filename, folder / "run.json")
        finally:
            if os.path.exists(filename):
                os.unlink(filename)

    def _load(self, run_id):
        folder = self._folder(run_id)
        state = _json(self._read(folder / "run.json", MAX_STATE_BYTES * 2 + 65536))
        if (state.get("runId") != run_id or state.get("status") not in ("active", "completed")
                or type(state.get("revision")) is not int or state["revision"] < 0
                or state.get("kind") != "practice"
                or not isinstance(state.get("name"), str)
                or not isinstance(state.get("version"), str)
                or not isinstance(state.get("digest"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", state["digest"])
                or type(state.get("updatedAt")) not in (int, float)
                or not math.isfinite(state["updatedAt"])):
            raise ValueError("Invalid run state")
        mode_id(state.get("modeId"))
        result = state.get("result")
        if state["status"] == "completed":
            if (not isinstance(result, dict) or not isinstance(result.get("outcome"), str)
                    or result["outcome"] not in OUTCOMES or result.get("verified") is not False
                    or result.get("rewards") is not None):
                raise ValueError("Invalid run result")
        elif result is not None:
            raise ValueError("Active run cannot have a result")
        json_object(state.get("input"), "input")
        if state.get("snapshot") is not None:
            json_object(state["snapshot"])
        return folder, state

    def create(self, package: Package):
        if "practice" not in package.manifest:
            raise ValueError("Mode does not provide a practice input")
        inputs = validate_input(package, _json(package.files[package.manifest["practice"]]))
        with self._lock:
            self._roots()
            self.root.mkdir(parents=True, exist_ok=True)
            run_id = uuid.uuid4().hex
            state = {"runId": run_id, "kind": "practice", "modeId": package.manifest["id"],
                     "name": package.manifest["name"], "version": package.manifest["version"],
                     "digest": package.digest, "input": inputs, "snapshot": None,
                     "status": "active", "revision": 0, "updatedAt": time.time(),
                     "result": None}
            staging = Path(tempfile.mkdtemp(prefix=".create-", dir=self.root))
            try:
                (staging / "package.zip").write_bytes(package.archive())
                self._save(staging, state)
                staging.rename(self.root / run_id)
            finally:
                if staging.exists():
                    shutil.rmtree(staging)
            return {**state, "bundle": runtime_bundle(package)}

    def get(self, run_id):
        with self._lock:
            folder, state = self._load(run_id)
            package = read_archive(self._read(folder / "package.zip", MAX_PACKAGE_BYTES))
            if (package.digest != state.get("digest") or package.manifest["id"] != state.get("modeId")
                    or package.manifest["version"] != state.get("version")):
                raise ValueError("Frozen package fingerprint mismatch")
            validate_input(package, state["input"])
            return {**state, "bundle": runtime_bundle(package)}

    def list(self):
        with self._lock:
            self._roots()
            runs, errors = [], []
            if self.root.exists():
                for folder in sorted(self.root.iterdir()):
                    if folder.name.startswith("."):
                        continue
                    try:
                        _, state = self._load(folder.name)
                        if state["status"] == "active":
                            runs.append({key: state[key] for key in (
                                "runId", "modeId", "name", "version", "status", "revision", "updatedAt")})
                    except (ValueError, OSError) as exc:
                        errors.append({"runId": folder.name, "error": str(exc)})
            return {"runs": sorted(runs, key=lambda row: row["updatedAt"], reverse=True), "errors": errors}

    def update(self, run_id, revision, snapshot, outcome=None):
        if type(revision) is not int or revision < 0:
            raise ValueError("revision must be a nonnegative integer")
        if outcome is not None and (not isinstance(outcome, str) or outcome not in OUTCOMES):
            raise ValueError("Unknown outcome")
        snapshot = json_object(snapshot)
        with self._lock:
            folder, state = self._load(run_id)
            if state["status"] == "completed":
                if (outcome is not None and state["result"]["outcome"] == outcome
                        and state["snapshot"] == snapshot):
                    return state
                raise RunConflict("Run already completed")
            if state["revision"] != revision:
                raise RunConflict("Run changed in another tab; reload before continuing")
            state.update(snapshot=snapshot, revision=revision + 1, updatedAt=time.time())
            if outcome is not None:
                state.update(status="completed", result={"outcome": outcome, "verified": False,
                                                         "rewards": None})
            self._save(folder, state)
            return state
