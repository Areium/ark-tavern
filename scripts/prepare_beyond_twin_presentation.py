"""Prepare Beyond Twin presentation bindings from its current outline and existing art.

Dry run by default. --apply preserves an exact backup and checks the source hash.
No session is changed and no image is generated or overwritten.
"""
import argparse
import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from plot_graphs import decode_graph_entry, encode_graph_for_worldbook, validate_graph
from story_outline import decode_outline_entry, normalize_outline, outline_to_beats
from story_rules import rule_key
from prepare_beyond_twin_story_rules import apply_prepared, _write_new

BACKGROUNDS = [
    "room200", "mall", "room200", "cafe", "sickroom", "room200",
    "lanjing", "lanjing", "factory", "cafe", "room200",
]
CGS = {
    "beat_act1_meet": "act1-nicole-rain.png",
    "beat_act2_mall": "act2-wasted-afternoon.png",
    "beat_act3_bill": "act3-credit-spike.png",
    "beat_act4_date": "act4-linnai-recognition.png",
    "beat_act5_fever": "act5-fever.png",
    "beat_act6_duke": "act6-duke-threshold.png",
    "beat_act6_truth": "act6-departure.png",
    "beat_act7_echo": "act7-chengxu-echo.png",
}


def visual(asset, cg=False):
    return {"kind": "image", "asset": asset, "role": "cg" if cg else "background",
            "fit": "contain" if cg else "cover", "position": [50, 50],
            "portraits": "hide" if cg else "show"}


def prepare_book(book):
    result = copy.deepcopy(book)
    entries = result["entries"]
    source = next(e for e in entries if e["uid"] == "story_outline_beyond_twin")
    outline = normalize_outline(decode_outline_entry(source), worldbook_id=result["id"])
    old_entry = next((e for e in entries if e["uid"] == "plot_graph_beyond_twin"), None)
    old = decode_graph_entry(old_entry) if old_entry else {"nodes": [], "edges": []}
    chapters = outline_to_beats(outline)
    valid_beats = {b["id"] for c in chapters for b in c["beats"]}
    stale = [n["id"] for n in old["nodes"] if n["type"] == "beat" and
             (n.get("ref") or {}).get("beat_id") not in valid_beats]
    graph = {"schema_version": 1, "plot_id": "beyond_twin", "worldbook_id": result["id"],
             "title": outline["title"], "nodes": [], "edges": []}
    def add(nid, kind, title, ref, x, y, media=None):
        previous = next((n for n in old["nodes"] if n["type"] == kind and n.get("ref") == ref), None)
        n = {**(previous or {}), "id": previous["id"] if previous else nid, "type": kind,
             "title": title, "content": (previous or {}).get("content", ""),
             "ref": ref, "x": (previous or {}).get("x", x), "y": (previous or {}).get("y", y)}
        if media is not None:
            n["scene_media"] = media
        else:
            n.pop("scene_media", None)
        graph["nodes"].append(n)
        return n["id"]
    root = add("bt_plot", "plot", outline["title"], None, 30, 80,
               {"background": visual("combat/backgrounds/beyond_twin_room200/bg.png")})
    ids, firsts = {}, []
    for ci, chapter in enumerate(chapters, 1):
        bg = "combat/backgrounds/beyond_twin_" + BACKGROUNDS[min(ci - 1, len(BACKGROUNDS) - 1)] + "/bg.png"
        chapter_id = add(f"bt_ch_{ci}", "chapter", chapter["title"], {"chapter_idx": ci},
                         80 + (ci - 1) * 260, 240, {"background": visual(bg)})
        firsts.append(chapter_id)
        prev = chapter_id
        for bi, beat in enumerate(chapter["beats"]):
            media = {}
            if beat["id"] in CGS:
                media["events"] = [{"id": "bt_" + beat["id"], "title": beat["title"],
                    "trigger": {"kind": "enter"}, "repeat": "entry", "priority": 10,
                    "actions": [{"kind": "set_visual", "visual": visual(
                        "plots/beyond_twin/art/" + CGS[beat["id"]], True)}]}]
            if beat["id"] == "beat_act1_meet" and beat["authored_branches"]:
                media.setdefault("events", []).append({
                    "id": "bt_fall_pov_choice", "title": "倒地后的仰望",
                    "trigger": {"kind": "choice", "choice_key": rule_key(beat["authored_branches"][0])},
                    "repeat": "entry", "priority": 20,
                    "actions": [{"kind": "set_visual", "visual": visual(
                        "plots/beyond_twin/art/cg-fall-pov-nicole.png", True)}]})
            if beat["id"] == "beat_act1_code":
                media["background"] = visual("combat/backgrounds/beyond_twin_room200/bg.png")
            nid = add("bt_" + beat["id"], "beat", beat["title"],
                      {"chapter_idx": ci, "beat_id": beat["id"]}, 80 + (ci - 1) * 260, 390 + bi * 150,
                      media if media else None)
            ids[beat["id"]] = nid
            graph["edges"].append({"id": f"bt_link_{len(graph['edges'])}", "from": prev, "to": nid})
            prev = nid
    for chapter_id in firsts:
        graph["edges"].append({"id": f"bt_link_{len(graph['edges'])}", "from": root, "to": chapter_id})
    for chapter in chapters:
        for beat in chapter["beats"]:
            for branch in beat["authored_branches"]:
                target = branch.get("target_beat_id")
                if target in ids:
                    edge = {"from": ids[beat["id"]], "to": ids[target]}
                    if not any(e["from"] == edge["from"] and e["to"] == edge["to"] for e in graph["edges"]):
                        graph["edges"].append({"id": f"bt_link_{len(graph['edges'])}", **edge})
    retained = {n["id"] for n in graph["nodes"]}
    for n in old["nodes"]:
        if n["id"] not in retained and n["type"] in ("note", "combat"):
            graph["nodes"].append(copy.deepcopy(n))
            retained.add(n["id"])
    for e in old["edges"]:
        if e["from"] in retained and e["to"] in retained and not any(
                x["from"] == e["from"] and x["to"] == e["to"] for x in graph["edges"]):
            graph["edges"].append(copy.deepcopy(e))
    errors = validate_graph(graph)
    if errors:
        raise ValueError("；".join(errors))
    encoded = encode_graph_for_worldbook(graph)
    if old_entry:
        index = entries.index(old_entry)
        old_raw, new_raw = old_entry.get("raw", {}), encoded["raw"]
        extensions = {**old_raw.get("extensions", {}), **new_raw.get("extensions", {})}
        extensions["arknights_tavern"] = {
            **old_raw.get("extensions", {}).get("arknights_tavern", {}),
            **new_raw["extensions"]["arknights_tavern"]}
        entries[index] = {**old_entry, **encoded, "raw": {**old_raw, **new_raw, "extensions": extensions}}
    else:
        entries.append(encoded)
    return result, {"nodes": len(graph["nodes"]), "events": sum(len(n.get("scene_media", {}).get("events", [])) for n in graph["nodes"]),
                    "stale_refs_replaced": stale}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("book", type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.book.is_symlink():
        raise ValueError("source book must not be a symlink")
    path = args.book.resolve(strict=True)
    original = path.read_bytes()
    prepared, report = prepare_book(json.loads(original.decode("utf-8-sig")))
    # Check every selected file before preparing a candidate or changing the book.
    graph = next(decode_graph_entry(e) for e in prepared["entries"] if e["uid"] == "plot_graph_beyond_twin")
    for node in graph["nodes"]:
        media = node.get("scene_media", {})
        visuals = [media["background"]] if media.get("background") else []
        visuals += [a["visual"] for e in media.get("events", []) for a in e["actions"]]
        for v in visuals:
            image = path.parent / v["asset"]
            if not image.is_file() or image.is_symlink() or not image.resolve().is_relative_to(path.parent):
                raise ValueError("missing or unsafe sample image: " + v["asset"])
    serialized = (json.dumps(prepared, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    report["changed"] = prepared != json.loads(original.decode("utf-8-sig"))
    if args.apply and report["changed"]:
        report["backup"] = str(apply_prepared(path, original, serialized))
    elif args.output:
        _write_new(args.output, serialized)
        report["candidate"] = str(args.output)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
