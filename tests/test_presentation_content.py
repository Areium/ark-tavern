"""Sample authoring stays pure and portable; never reads an installed user book."""
import copy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))
from prepare_beyond_twin_presentation import prepare_book
from plot_graphs import encode_graph_for_worldbook, decode_graph_entry, validate_graph
from story_outline import encode_outline_for_worldbook, normalize_outline


def sample():
    outline = normalize_outline({"plot_id": "beyond_twin", "title": "彼岸双生", "chapters": [
        {"id": "act_1", "beats": [
            {"id": "beat_act1_meet", "branches": [{"label": "询问身份", "target_beat_id": "beat_act1_call"}]},
            {"id": "beat_act1_call", "branches": []}, {"id": "beat_act1_code", "branches": []}]}]})
    graph = {"plot_id": "beyond_twin", "nodes": [
        {"id": "custom_note", "type": "note", "title": "作者笔记", "content": "保留正文", "ref": None, "x": 98, "y": 120},
        {"id": "meet", "type": "beat", "title": "相遇", "ref": {"chapter_idx": 1, "beat_id": "beat_act1_meet"}, "x": 222, "y": 333},
    ], "edges": []}
    entry = encode_graph_for_worldbook(graph)
    entry["raw"]["extensions"]["author"] = {"keep": True}
    return {"id": "sample", "stat_fields": [{"key": "custom", "type": "bool"}],
            "entries": [encode_outline_for_worldbook(outline), entry, {"uid": "user", "content": "原始正文"}]}


def test_example_is_idempotent_preserves_other_content_and_valid_layout():
    book = sample()
    original = copy.deepcopy(book)
    prepared, report = prepare_book(book)
    assert book == original
    repeated, _ = prepare_book(prepared)
    assert repeated == prepared
    assert prepared["stat_fields"] == book["stat_fields"]
    assert prepared["entries"][0] == book["entries"][0]
    assert prepared["entries"][-1] == book["entries"][-1]
    graph_entry = next(e for e in prepared["entries"] if e["uid"] == "plot_graph_beyond_twin")
    assert graph_entry["raw"]["extensions"]["author"] == {"keep": True}
    graph = decode_graph_entry(graph_entry)
    assert validate_graph(graph) == []
    note = next(n for n in graph["nodes"] if n["id"] == "custom_note")
    assert note["content"] == "保留正文" and note["x"] == 98
    meet = next(n for n in graph["nodes"] if n["id"] == "meet")
    assert (meet["x"], meet["y"]) == (222, 333)
    assert report["events"] == 2
    assert all(not n.get("scene_media") for n in graph["nodes"] if (n.get("ref") or {}).get("beat_id") == "beat_act1_call")
