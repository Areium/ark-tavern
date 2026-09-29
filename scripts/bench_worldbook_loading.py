"""Read-only shelf/detail benchmark against an existing local bookshelf.

Run in separate processes with --code-root pointing to each revision's worktree.
No app startup, LLM, sessions, or metadata writes are performed.
"""

import argparse
import json
import statistics
import sys
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, required=True)
    parser.add_argument("--code-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--runs", type=int, default=5)
    args = parser.parse_args()
    data = args.project_root / "data" / "worldbooks"
    if not (data / "books").is_dir() or args.runs < 1:
        parser.error("An existing bookshelf and at least one run are required")
    sys.path.insert(0, str(args.code_root / "src"))
    from flask import Flask
    from blueprints.worldbook import register
    from wiki_manager import WikiManager
    from world_book import WorldBookManager

    manager = WorldBookManager(data)
    wiki = WikiManager(str(args.project_root))
    app = Flask(__name__)
    register(app, {"worldbook": manager, "wiki": wiki})
    client = app.test_client()
    shelf_ms, detail_ms = [], []
    for _ in range(args.runs):
        start = time.perf_counter()
        response = client.get("/api/worldbook")
        shelf_ms.append(round((time.perf_counter() - start) * 1000, 2))
        assert response.status_code == 200
        books = response.json["books"]
        if books:
            start = time.perf_counter()
            response = client.get(f'/api/worldbook/{books[0]["id"]}')
            detail_ms.append(round((time.perf_counter() - start) * 1000, 2))
            assert response.status_code == 200
    print(json.dumps({
        "books": len(books), "entries": sum(book["entry_count"] for book in books),
        "shelf_ms": shelf_ms, "shelf_median_ms": statistics.median(shelf_ms),
        "first_book_detail_ms": detail_ms,
        "detail_median_ms": statistics.median(detail_ms) if detail_ms else None,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
