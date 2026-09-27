"""Record ownership of the repository's optional sample content.

The manifest contains only Git-tracked authoring files. New files created by a
user are not assigned to a bundled book. Re-run after changing bundled assets.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import frontmatter


ROOT = Path(__file__).resolve().parents[1]
CONTENT = ROOT / "data" / "worldbooks" / "content"
PACKS = ROOT / "data" / "worldbooks" / "packs"
OUTPUT = ROOT / "data" / "worldbooks" / "content_manifest.json"
ARK_STORIES = ("arknights", "near-light", "fengxue-guojing", "combat-test", "grey-lantern")


def _metadata(path: Path) -> dict:
    if not path.is_file() or path.suffix.lower() != ".md":
        return {}
    try:
        return frontmatter.load(path).metadata
    except (OSError, ValueError):
        return {}


def _tracked_files() -> list[Path]:
    names = subprocess.check_output(
        ["git", "ls-files", "-z", "--", "data/worldbooks/content"], cwd=ROOT
    ).split(b"\0")
    tracked = {ROOT / name.decode("utf-8") for name in names if name}
    # The catalog is distributed with this manifest even before the first stage.
    tracked.add(CONTENT / "spine_variants.json")
    return sorted(tracked)


def _character_books() -> dict[str, set[str]]:
    result: dict[str, set[str]] = {}
    for pack in PACKS.glob("*.json"):
        data = json.loads(pack.read_text(encoding="utf-8"))
        for entry in data.get("entries", []):
            name = entry.get("character_id")
            if isinstance(name, str) and name:
                result.setdefault(name, set()).add(pack.stem)
    return result


def _owner_for(path: Path, characters: dict[str, set[str]]) -> list[str]:
    rel = path.relative_to(CONTENT)
    parts = rel.parts
    if "TEMPLATE" in path.name.upper():
        return []
    if parts[0] == "characters" and len(parts) >= 3:
        book_id = str(_metadata(CONTENT / "characters" / parts[1] / "index.md").get("worldbook_id") or "")
        if book_id == "beyond-twin":
            return [book_id]
        return sorted(characters.get(parts[1]) or {book_id or "arknights"})
    if parts[0] == "plots" and len(parts) >= 3:
        book_id = _metadata(CONTENT / "plots" / parts[1] / "index.md").get("worldbook_id")
        return [str(book_id)] if book_id else list(ARK_STORIES)
    meta = _metadata(path)
    if path.suffix.lower() == ".json":
        try:
            meta = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            meta = {}
    book_id = str(meta.get("worldbook_id") or "")
    if book_id and book_id != "arknights":
        return [book_id]
    # Legacy source material predates ownership metadata. These are shared
    # resources for the optional Arknights story family, not platform defaults.
    if "beyond_twin" in rel.as_posix().lower() or any(
        name in rel.as_posix() for name in ("彼岸双生", "澜晶", "深湾市", "旧城200室")
    ):
        return ["beyond-twin"]
    return list(ARK_STORIES)


def main() -> None:
    characters = _character_books()
    directories: dict[str, list[str]] = {}
    files: dict[str, list[str]] = {}
    for path in _tracked_files():
        rel = path.relative_to(CONTENT)
        owners = _owner_for(path, characters)
        if not owners:
            continue
        parts = rel.parts
        key = None
        if parts[0] in {"characters", "plots", "classes", "races", "factions", "attributes", "rules", "items"} and len(parts) >= 3:
            key = "/".join(parts[:2]) + "/"
        elif parts[0] == "environment" and len(parts) >= 4:
            key = "/".join(parts[:3]) + "/"
        elif parts[0] == "combat" and len(parts) >= 4 and parts[1] == "backgrounds":
            key = "/".join(parts[:3]) + "/"
        if key is not None:
            prior = directories.get(key)
            if prior is not None and prior != owners:
                raise ValueError(f"conflicting owners for {key}: {prior} vs {owners}")
            directories[key] = owners
        else:
            files[rel.as_posix()] = owners
    payload = {"schema_version": 1, "directories": dict(sorted(directories.items())),
               "files": dict(sorted(files.items()))}
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{OUTPUT}: {len(directories)} directories, {len(files)} files")


if __name__ == "__main__":
    sys.exit(main())
