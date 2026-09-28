"""Move legacy installed books into data/worldbooks/books/ without editing them.

Run without --apply first. Stop the app before applying the move.
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from data_paths import worldbooks_root  # noqa: E402
from world_book import WorldBook, WorldBookManager  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="move validated files")
    args = parser.parse_args()
    root = worldbooks_root(ROOT)
    planned = []
    problems = []
    for path in sorted(root.glob("*.json")):
        if path.name in {"settings.json", "content_manifest.json",
                         "local_content_manifest.json"}:
            continue
        target = root / "books" / path.name
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or data.get("id") != path.stem:
                raise ValueError("file name and worldbook ID differ")
            WorldBook.from_dict(data)
            if target.exists():
                raise FileExistsError(target)
            planned.append(path.stem)
        except (OSError, ValueError, TypeError, KeyError) as exc:
            problems.append((path.name, str(exc)))
    print(f"Legacy books ready to move: {len(planned)}")
    for book_id in planned:
        print(f"  {book_id}.json -> books/{book_id}.json")
    for filename, reason in problems:
        print(f"  SKIP {filename}: {reason}")
    if args.apply and not problems:
        manager = WorldBookManager(root)
        moved = manager.migrate_legacy_books()
        print(f"Moved: {len(moved)}")
        return 0 if len(moved) == len(planned) else 1
    if problems:
        print("Resolve skipped files before applying; no files were moved.")
        return 1
    if not args.apply:
        print("Preview only. Stop the app, then rerun with --apply.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
