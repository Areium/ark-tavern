"""Preview or explicitly copy old worldbooks into self-contained folders."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from data_paths import WORLDBOOKS_ROOT
from world_book import WorldBook
from worldbook_bundle import _read_json
from worldbook_folder_store import migrate_json


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worldbooks-dir", type=Path, default=WORLDBOOKS_ROOT)
    parser.add_argument("--apply", action="store_true", help="Copy books and owned resources; retain old sources")
    args = parser.parse_args()
    root = args.worldbooks_dir
    sources = [*sorted((root / "books").glob("*.json")), *sorted(root.glob("*.json"))]
    report = []
    for source in sources:
        if source.name in {"settings.json", "content_manifest.json", "local_content_manifest.json"}:
            continue
        target = root / "books" / source.stem
        try:
            if source.is_symlink():
                raise ValueError("Source is a symlink")
            payload = _read_json(source.read_bytes())
            if payload.get("id") != source.stem:
                raise ValueError("Filename and book ID differ")
            WorldBook.from_dict(payload)
            if target.exists() or target.is_symlink():
                raise FileExistsError("Target folder already exists")
            if args.apply:
                migrate_json(source, root)
            report.append({"id": source.stem, "source": str(source),
                           "target": str(target), "status": "copied" if args.apply else "ready"})
        except (OSError, ValueError) as exc:
            report.append({"source": str(source), "status": "skipped", "reason": str(exc)})
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if not any(item["status"] == "skipped" for item in report) else 1


if __name__ == "__main__":
    raise SystemExit(main())
