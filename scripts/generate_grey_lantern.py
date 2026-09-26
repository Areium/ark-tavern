"""Rebuild only the Grey Lantern pack; Markdown and node JSON remain source of truth."""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import frontmatter

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from story_outline import encode_outline_for_worldbook, heuristic_outline, normalize_outline

BOOK_ID = "grey-lantern"
STAGES = ("arrival", "checkpoint", "fork", "warehouse", "rendezvous", "bridge", "ending")


def build_outline():
    doc = frontmatter.load(ROOT / "data/worldbooks/content/plots/grey_lantern/index.md")
    outline = heuristic_outline(doc.metadata, doc.content, worldbook_id=BOOK_ID)
    assert len(outline["chapters"]) == len(STAGES)
    for stage, chapter in zip(STAGES, outline["chapters"]):
        chapter["id"] = f"grey_{stage}"
        beat = chapter["beats"][0]
        beat["id"] = f"beat_grey_{stage}"
        beat["min_rounds"] = 1
        if stage == "rendezvous":
            beat["min_rounds"] = 3  # 救援过程、核对人员、回应苏禾留出独立回合。
        beat["combat"] = None  # 不把正文中的“战斗/冲突”误判为新增遭遇。
        beat["branches"] = []
        if stage in ("checkpoint", "warehouse", "bridge"):
            beat["combat"] = {"required": True, "node_id": f"enc_grey_{stage}",
                              "band": "T1", "description": beat["summary"], "enemies": []}
        if stage == "fork":
            beat["choice_required"] = True
            beat["branches"] = [
                {"label": "先救泵房工人", "intent": "救援", "target_beat_id": "beat_grey_rendezvous"},
                {"label": "先取注销原册", "intent": "取证", "target_beat_id": "beat_grey_warehouse"},
            ]
    outline["source"] = "authored"
    outline["generated_at"] = datetime(2026, 9, 26, tzinfo=timezone.utc).timestamp()
    return normalize_outline(outline)


def enrich_grey_lantern(book):
    """Attach system outline and disabled combat-definition reference entries."""
    system_entries = [encode_outline_for_worldbook(build_outline())]
    for stage in ("checkpoint", "warehouse", "bridge"):
        node_id = f"enc_grey_{stage}"
        path = ROOT / f"data/worldbooks/content/combat/nodes/{node_id}.json"
        node = json.loads(path.read_text(encoding="utf-8"))
        system_entries.append({
            "uid": f"combat_node_{node_id}", "name": node["name"],
            "content": "```json combat-node\n" + json.dumps(node, ensure_ascii=False, separators=(",", ":")) + "\n```",
            "trigger_keys": [], "always_active": False, "position": 1, "enabled": False,
            "raw": {"extensions": {"arknights_tavern": {"entry_type": "combat_node", "node_id": node_id}}},
        })
    book["entries"].extend(system_entries)
    book["entry_order"].extend(entry["uid"] for entry in system_entries)


def build_book():
    from generate_builtin_worldbook import collect_entries
    from split_builtin_story_worldbooks import split_builtin_book
    entries = collect_entries()
    _, stories = split_builtin_book({"id": "arknights", "entries": entries})
    book = stories[BOOK_ID]
    enrich_grey_lantern(book)
    return book


if __name__ == "__main__":
    book = build_book()
    path = ROOT / f"data/worldbooks/packs/{BOOK_ID}.json"
    path.write_text(json.dumps(book, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Generated {path} ({len(book['entries'])} entries)")
