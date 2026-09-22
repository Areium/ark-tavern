"""Safely migrate untracked local data left behind by the worldbook layout change.

The command is a dry run by default. Pass ``--apply`` to perform the migration.
Tracked files are expected to have already moved with Git; this utility handles
local-only assets without overwriting any destination file.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import stat
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable


CONTENT_DIRS = (
    "attributes",
    "audio",
    "characters",
    "classes",
    "combat",
    "enemies",
    "environment",
    "factions",
    "items",
    "plots",
    "races",
    "rules",
    "world",
)


class MigrationError(RuntimeError):
    """Raised when migration cannot proceed safely."""


@dataclass(frozen=True)
class MigrationAction:
    source: Path
    destination: Path
    sha256: str
    duplicate: bool = False


@dataclass(frozen=True)
class MigrationConflict:
    source: Path
    destination: Path
    source_sha256: str
    destination_sha256: str


@dataclass
class MigrationPlan:
    root: Path
    data_root: Path
    actions: list[MigrationAction] = field(default_factory=list)
    conflicts: list[MigrationConflict] = field(default_factory=list)
    source_directories: list[Path] = field(default_factory=list)

    @property
    def files_to_copy(self) -> int:
        return sum(not action.duplicate for action in self.actions)

    @property
    def duplicate_files(self) -> int:
        return sum(action.duplicate for action in self.actions)


@dataclass(frozen=True)
class MigrationResult:
    dry_run: bool
    copied: int
    duplicates_removed: int
    directories_removed: int
    conflicts: tuple[MigrationConflict, ...] = ()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_reparse_point(path: Path) -> bool:
    info = path.lstat()
    attributes = getattr(info, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    return path.is_symlink() or bool(attributes & reparse_flag)


def _within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _lexists(path: Path) -> bool:
    return os.path.lexists(path)


def _validate_path(path: Path, data_root: Path, *, must_exist: bool = False) -> None:
    absolute = Path(os.path.abspath(path))
    if not _within(absolute, data_root):
        raise MigrationError(f"path escapes data root: {absolute}")

    existing = absolute
    while not _lexists(existing) and existing != data_root:
        existing = existing.parent
    if must_exist and not _lexists(absolute):
        raise MigrationError(f"expected path does not exist: {absolute}")

    current = existing
    while _within(current, data_root):
        if _is_reparse_point(current):
            raise MigrationError(f"symlink or junction is not allowed: {current}")
        if current == data_root:
            break
        current = current.parent

    resolved = absolute.resolve(strict=False)
    resolved_data = data_root.resolve(strict=True)
    if not _within(resolved, resolved_data):
        raise MigrationError(f"resolved path escapes data root: {absolute} -> {resolved}")


def _validate_destination_directory(path: Path, data_root: Path) -> None:
    """Require the closest existing destination ancestor to be a directory."""

    current = path
    while not _lexists(current):
        current = current.parent
    _validate_path(current, data_root, must_exist=True)
    if not current.is_dir():
        raise MigrationError(f"destination path is blocked by a non-directory: {current}")


def _mappings(data_root: Path) -> Iterable[tuple[Path, Path]]:
    for name in CONTENT_DIRS:
        yield data_root / name, data_root / "worldbooks" / "content" / name
    yield data_root / "packs", data_root / "worldbooks" / "packs"
    yield data_root / "worldbook_analysis", data_root / "archive" / "worldbook_analysis"
    yield data_root / "worldbook_jobs", data_root / "archive" / "worldbook_jobs"


def _scan_source(source_root: Path, data_root: Path) -> tuple[list[Path], list[Path]]:
    files: list[Path] = []
    directories: list[Path] = []
    if not _lexists(source_root):
        return files, directories
    _validate_path(source_root, data_root, must_exist=True)
    if not source_root.is_dir():
        raise MigrationError(f"migration source is not a directory: {source_root}")

    def visit(directory: Path) -> None:
        directories.append(directory)
        try:
            entries = sorted(os.scandir(directory), key=lambda item: item.name)
        except OSError as exc:
            raise MigrationError(f"cannot scan {directory}: {exc}") from exc
        for entry in entries:
            path = Path(entry.path)
            _validate_path(path, data_root, must_exist=True)
            if entry.is_symlink() or _is_reparse_point(path):
                raise MigrationError(f"symlink or junction is not allowed: {path}")
            if entry.is_dir(follow_symlinks=False):
                visit(path)
            elif entry.is_file(follow_symlinks=False):
                files.append(path)
            else:
                raise MigrationError(f"unsupported filesystem entry: {path}")

    visit(source_root)
    return files, directories


def plan_migration(root: str | os.PathLike[str]) -> MigrationPlan:
    """Preflight the complete migration without changing the filesystem."""

    repo_root = Path(os.path.abspath(root))
    if not repo_root.is_dir():
        raise MigrationError(f"repository root is not a directory: {repo_root}")
    data_root = repo_root / "data"
    if not data_root.is_dir():
        raise MigrationError(f"data directory does not exist: {data_root}")
    _validate_path(data_root, data_root, must_exist=True)

    plan = MigrationPlan(root=repo_root, data_root=data_root)
    for source_root, destination_root in _mappings(data_root):
        _validate_path(source_root, data_root)
        _validate_path(destination_root, data_root)
        _validate_destination_directory(destination_root, data_root)
        files, directories = _scan_source(source_root, data_root)
        plan.source_directories.extend(directories)
        for source in files:
            relative = source.relative_to(source_root)
            destination = destination_root / relative
            _validate_path(destination, data_root)
            _validate_destination_directory(destination.parent, data_root)
            source_hash = _sha256(source)
            if _lexists(destination):
                _validate_path(destination, data_root, must_exist=True)
                if not destination.is_file():
                    raise MigrationError(f"destination is not a regular file: {destination}")
                destination_hash = _sha256(destination)
                if source_hash != destination_hash:
                    plan.conflicts.append(
                        MigrationConflict(source, destination, source_hash, destination_hash)
                    )
                    continue
                plan.actions.append(MigrationAction(source, destination, source_hash, True))
            else:
                plan.actions.append(MigrationAction(source, destination, source_hash, False))
    return plan


def _ensure_destination_parent(destination: Path, data_root: Path) -> None:
    missing: list[Path] = []
    current = destination.parent
    while not _lexists(current):
        _validate_path(current, data_root)
        missing.append(current)
        current = current.parent
    _validate_path(current, data_root, must_exist=True)
    if not current.is_dir():
        raise MigrationError(f"destination parent is not a directory: {current}")
    for directory in reversed(missing):
        try:
            directory.mkdir()
        except FileExistsError:
            pass
        _validate_path(directory, data_root, must_exist=True)
        if not directory.is_dir():
            raise MigrationError(f"destination parent is not a directory: {directory}")


def _copy_exclusive(action: MigrationAction, data_root: Path) -> bool:
    """Copy one file and atomically publish it without exposing a partial target."""

    _validate_path(action.source, data_root, must_exist=True)
    if _sha256(action.source) != action.sha256:
        raise MigrationError(f"source changed after preflight: {action.source}")
    _ensure_destination_parent(action.destination, data_root)

    temporary: Path | None = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{action.destination.name}.migrate-",
            suffix=".tmp",
            dir=action.destination.parent,
        )
        temporary = Path(temporary_name)
        with os.fdopen(descriptor, "wb") as target:
            digest = hashlib.sha256()
            with action.source.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
                    target.write(chunk)
            target.flush()
            os.fsync(target.fileno())
        if digest.hexdigest() != action.sha256 or _sha256(temporary) != action.sha256:
            raise MigrationError(f"copy verification failed: {action.source}")
        try:
            os.link(temporary, action.destination)
        except FileExistsError:
            _validate_path(action.destination, data_root, must_exist=True)
            if not action.destination.is_file() or _sha256(action.destination) != action.sha256:
                raise MigrationError(
                    f"destination appeared with different content: {action.destination}"
                )
            return False
        if _sha256(action.destination) != action.sha256:
            raise MigrationError(f"published copy verification failed: {action.destination}")
        return True
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass


def _finish_copy(action: MigrationAction, data_root: Path) -> bool:
    created = _copy_exclusive(action, data_root)
    if _sha256(action.source) != action.sha256:
        if created and _lexists(action.destination):
            _validate_path(action.destination, data_root, must_exist=True)
            if action.destination.is_file() and _sha256(action.destination) == action.sha256:
                action.destination.unlink()
        raise MigrationError(f"source changed during copy: {action.source}")
    action.source.unlink()
    return created


def _remove_duplicate(action: MigrationAction, data_root: Path) -> None:
    _validate_path(action.source, data_root, must_exist=True)
    _validate_path(action.destination, data_root, must_exist=True)
    if _sha256(action.source) != action.sha256:
        raise MigrationError(f"source changed after preflight: {action.source}")
    if not action.destination.is_file() or _sha256(action.destination) != action.sha256:
        raise MigrationError(f"destination changed after preflight: {action.destination}")
    action.source.unlink()


def apply_migration(plan: MigrationPlan) -> MigrationResult:
    """Apply a conflict-free preflight plan without overwriting files."""

    if plan.conflicts:
        raise MigrationError("migration has conflicts; no files were changed")
    copied = 0
    duplicates_removed = 0
    for action in plan.actions:
        if action.duplicate:
            _remove_duplicate(action, plan.data_root)
            duplicates_removed += 1
        else:
            created = _finish_copy(action, plan.data_root)
            copied += int(created)
            duplicates_removed += int(not created)

    directories_removed = 0
    for directory in sorted(set(plan.source_directories), key=lambda path: len(path.parts), reverse=True):
        _validate_path(directory, plan.data_root)
        try:
            directory.rmdir()
            directories_removed += 1
        except (FileNotFoundError, OSError):
            # Missing is already clean; non-empty means a concurrent/local file is preserved.
            pass
    return MigrationResult(False, copied, duplicates_removed, directories_removed)


def run_migration(
    root: str | os.PathLike[str], *, apply: bool = False
) -> tuple[MigrationPlan, MigrationResult]:
    """Plan a migration and optionally apply it."""

    plan = plan_migration(root)
    if plan.conflicts:
        return plan, MigrationResult(True, 0, 0, 0, tuple(plan.conflicts))
    if apply:
        return plan, apply_migration(plan)
    return plan, MigrationResult(True, 0, 0, 0)


def _print_summary(plan: MigrationPlan, result: MigrationResult) -> None:
    mode = "dry-run" if result.dry_run else "applied"
    print(
        f"{mode}: copy={plan.files_to_copy if result.dry_run else result.copied} "
        f"duplicates={plan.duplicate_files if result.dry_run else result.duplicates_removed} "
        f"conflicts={len(plan.conflicts)}"
    )
    if not result.dry_run:
        print(f"removed_dirs={result.directories_removed}")
    for conflict in plan.conflicts:
        print(f"conflict: {conflict.source} -> {conflict.destination}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--apply", action="store_true", help="perform the migration")
    args = parser.parse_args(argv)
    try:
        plan, result = run_migration(args.root, apply=args.apply)
    except MigrationError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    _print_summary(plan, result)
    return 2 if plan.conflicts else 0


if __name__ == "__main__":
    raise SystemExit(main())
