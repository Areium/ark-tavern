from __future__ import annotations

import os
from pathlib import Path

import pytest

from scripts.migrate_data_layout import (
    MigrationError,
    _validate_path,
    apply_migration,
    plan_migration,
    run_migration,
)


def _repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    (root / "data").mkdir(parents=True)
    return root


def _write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def _snapshot(root: Path) -> dict[str, bytes | None]:
    return {
        str(path.relative_to(root)): None if path.is_dir() else path.read_bytes()
        for path in sorted(root.rglob("*"))
    }


def test_dry_run_makes_no_changes(tmp_path: Path) -> None:
    root = _repo(tmp_path)
    _write(root / "data/characters/local/avatar.png", b"\x89PNG\x00local")
    before = _snapshot(root)

    plan, result = run_migration(root)

    assert result.dry_run is True
    assert plan.files_to_copy == 1
    assert _snapshot(root) == before


def test_apply_moves_binary_content_and_archives_legacy_state(tmp_path: Path) -> None:
    root = _repo(tmp_path)
    binary = bytes(range(256)) + b"\x00\xffspine"
    _write(root / "data/characters/local/spine/model.skel", binary)
    _write(root / "data/packs/local.json", b'[{"name":"local"}]')
    _write(root / "data/worldbook_analysis/run/result.json", b"analysis")
    _write(root / "data/worldbook_jobs/job-1/state.json", b"job")

    plan, result = run_migration(root, apply=True)

    assert plan.files_to_copy == 4
    assert result.copied == 4
    assert (root / "data/worldbooks/content/characters/local/spine/model.skel").read_bytes() == binary
    assert (root / "data/worldbooks/packs/local.json").read_bytes() == b'[{"name":"local"}]'
    assert (root / "data/archive/worldbook_analysis/run/result.json").read_bytes() == b"analysis"
    assert (root / "data/archive/worldbook_jobs/job-1/state.json").read_bytes() == b"job"
    assert not (root / "data/characters/local/spine/model.skel").exists()


def test_unrelated_worldbooks_and_memory_are_preserved(tmp_path: Path) -> None:
    root = _repo(tmp_path)
    preserved = {
        "data/worldbooks/my-book.json": b"user book",
        "data/worldbooks/settings.json": b"settings",
        "data/worldbooks/book.json.bak": b"backup",
        "data/memory/session-1.json": b"session memory",
        "data/sessions/session-1.json": b"session state",
    }
    for relative, content in preserved.items():
        _write(root / relative, content)
    _write(root / "data/items/local.bin", b"move me")

    run_migration(root, apply=True)

    for relative, content in preserved.items():
        assert (root / relative).read_bytes() == content


def test_identical_destination_is_verified_then_source_removed(tmp_path: Path) -> None:
    root = _repo(tmp_path)
    source = root / "data/audio/custom.ogg"
    destination = root / "data/worldbooks/content/audio/custom.ogg"
    _write(source, b"same bytes")
    _write(destination, b"same bytes")

    plan, result = run_migration(root, apply=True)

    assert plan.duplicate_files == 1
    assert result.duplicates_removed == 1
    assert not source.exists()
    assert destination.read_bytes() == b"same bytes"


def test_repeated_run_is_a_noop(tmp_path: Path) -> None:
    root = _repo(tmp_path)
    _write(root / "data/rules/local/index.md", b"rule")

    run_migration(root, apply=True)
    plan, result = run_migration(root, apply=True)

    assert plan.actions == []
    assert result.copied == 0
    assert result.duplicates_removed == 0


def test_conflict_blocks_every_change_globally(tmp_path: Path) -> None:
    root = _repo(tmp_path)
    _write(root / "data/items/safe.bin", b"safe")
    _write(root / "data/classes/conflict.bin", b"old")
    _write(root / "data/worldbooks/content/classes/conflict.bin", b"different")
    before = _snapshot(root)

    plan, result = run_migration(root, apply=True)

    assert len(plan.conflicts) == 1
    assert result.dry_run is True
    assert _snapshot(root) == before
    assert not (root / "data/worldbooks/content/items/safe.bin").exists()


def test_blocked_destination_parent_fails_during_global_preflight(tmp_path: Path) -> None:
    root = _repo(tmp_path)
    _write(root / "data/items/safe.bin", b"safe")
    _write(root / "data/classes/nested/local.bin", b"blocked")
    _write(root / "data/worldbooks/content/classes/nested", b"ordinary file")
    before = _snapshot(root)

    with pytest.raises(MigrationError, match="blocked by a non-directory"):
        run_migration(root, apply=True)

    assert _snapshot(root) == before
    assert not (root / "data/worldbooks/content/items/safe.bin").exists()


def test_source_change_after_preflight_is_rejected_and_recoverable(tmp_path: Path) -> None:
    root = _repo(tmp_path)
    source = root / "data/environment/local.bin"
    destination = root / "data/worldbooks/content/environment/local.bin"
    _write(source, b"first")
    plan = plan_migration(root)
    source.write_bytes(b"changed")

    with pytest.raises(MigrationError, match="source changed after preflight"):
        apply_migration(plan)

    assert source.read_bytes() == b"changed"
    assert not destination.exists()
    run_migration(root, apply=True)
    assert destination.read_bytes() == b"changed"


def test_destination_created_after_preflight_is_safe_to_resume(tmp_path: Path) -> None:
    root = _repo(tmp_path)
    source = root / "data/combat/local.bin"
    destination = root / "data/worldbooks/content/combat/local.bin"
    _write(source, b"complete copy")
    plan = plan_migration(root)
    _write(destination, b"complete copy")

    result = apply_migration(plan)

    assert result.copied == 0
    assert result.duplicates_removed == 1
    assert not source.exists()
    assert destination.read_bytes() == b"complete copy"


def test_stale_partial_temporary_file_does_not_block_recovery(tmp_path: Path) -> None:
    root = _repo(tmp_path)
    source = root / "data/combat/local.bin"
    destination = root / "data/worldbooks/content/combat/local.bin"
    stale_temporary = destination.parent / ".local.bin.migrate-dead.tmp"
    _write(source, b"complete copy")
    _write(stale_temporary, b"partial")

    run_migration(root, apply=True)

    assert destination.read_bytes() == b"complete copy"
    assert not source.exists()
    # Unknown files are never deleted by cleanup, even when they resemble tool temps.
    assert stale_temporary.read_bytes() == b"partial"


def test_symlink_escape_is_rejected_without_changes(tmp_path: Path) -> None:
    root = _repo(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    _write(outside / "secret.bin", b"outside")
    source_link = root / "data/characters/escaped"
    source_link.parent.mkdir(parents=True)
    try:
        os.symlink(outside, source_link, target_is_directory=True)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"directory symlinks unavailable: {exc}")

    with pytest.raises(MigrationError, match="symlink or junction|escapes data root"):
        plan_migration(root)

    assert (outside / "secret.bin").read_bytes() == b"outside"
    assert not (root / "data/worldbooks/content/characters/escaped/secret.bin").exists()


def test_dangling_symlink_is_rejected(tmp_path: Path) -> None:
    root = _repo(tmp_path)
    source_link = root / "data/items/dangling.bin"
    source_link.parent.mkdir(parents=True)
    try:
        os.symlink(tmp_path / "missing.bin", source_link)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"file symlinks unavailable: {exc}")

    with pytest.raises(MigrationError, match="symlink or junction"):
        plan_migration(root)


def test_lexical_path_escape_is_rejected(tmp_path: Path) -> None:
    root = _repo(tmp_path)

    with pytest.raises(MigrationError, match="path escapes data root"):
        _validate_path(tmp_path / "outside.bin", root / "data")
