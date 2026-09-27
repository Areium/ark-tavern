"""A checkout must not expose bundled world content without an installed book."""

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BOOKS = ROOT / "data" / "worldbooks"
CONTENT = BOOKS / "content"


def test_all_tracked_sample_assets_have_a_valid_pack_owner():
    manifest = json.loads((BOOKS / "content_manifest.json").read_text(encoding="utf-8"))
    owners = set()
    for mapping in (manifest["files"], manifest["directories"]):
        for assigned in mapping.values():
            assert assigned
            owners.update(assigned)
    assert all((BOOKS / "packs" / f"{book_id}.json").is_file() for book_id in owners)

    names = subprocess.check_output(
        ["git", "ls-files", "-z", "--", "data/worldbooks/content"], cwd=ROOT
    ).split(b"\0")
    uncovered = []
    for raw in names:
        if not raw:
            continue
        rel = (ROOT / raw.decode("utf-8")).relative_to(CONTENT).as_posix()
        if "TEMPLATE" in Path(rel).name.upper():
            continue
        if rel in manifest["files"]:
            continue
        if not any(rel.startswith(prefix) for prefix in manifest["directories"]):
            uncovered.append(rel)
    assert not uncovered, f"Bundled assets would be visible without a book: {uncovered[:10]}"
