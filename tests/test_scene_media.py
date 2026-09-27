"""Authored graph images follow stable story references, not canvas layout."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from plot_graphs import validate_graph  # noqa: E402
from scene_media import resolve_scene_media, valid_scene_image_url  # noqa: E402


def _node(node_id, kind, ref, **media):
    return {"id": node_id, "type": kind, "title": node_id, "x": 0, "y": 0,
            "ref": ref, "scene_media": media}


def test_background_inherits_plot_then_chapter_then_beat_and_cg_is_beat_only():
    doc = {"plot_id": "p", "edges": [], "nodes": [
        _node("plot", "plot", None, background_url="/api/assets/plots/p/art/plot.png"),
        _node("chapter", "chapter", {"chapter_idx": 2}, background_url="/api/assets/plots/p/art/chapter.png"),
        _node("beat", "beat", {"chapter_idx": 2, "beat_id": "b"},
              background_url="/api/assets/plots/p/art/beat.png",
              cg_url="/api/assets/plots/p/art/cg.webp", cg_title="转折"),
    ]}
    assert validate_graph(doc) == []
    assert resolve_scene_media(doc, chapter_idx=1, beat_id="a") == {
        "background_url": "/api/assets/plots/p/art/plot.png", "cg": None}
    assert resolve_scene_media(doc, chapter_idx=2, beat_id="a")["background_url"].endswith("chapter.png")
    cue = resolve_scene_media(doc, chapter_idx=2, beat_id="b")
    assert cue["background_url"].endswith("beat.png")
    assert cue["cg"] == {"url": "/api/assets/plots/p/art/cg.webp", "title": "转折"}
    assert resolve_scene_media(doc, chapter_idx=3, beat_id="b")["cg"] is None


def test_invalid_urls_and_unanchored_cues_cannot_be_saved():
    for url in ("https://example.com/cg.png", "/api/assets/plots/../secret.png",
                "/api/assets/plots/%2e%2e/secret.png", "javascript:alert(1)"):
        assert not valid_scene_image_url(url)
    doc = {"plot_id": "p", "edges": [], "nodes": [
        _node("beat", "beat", None, cg_url="/api/assets/plots/p/art/cg.png"),
        _node("chapter", "chapter", {"chapter_idx": 1}, cg_url="/api/assets/plots/p/art/cg.png"),
    ]}
    errors = validate_graph(doc)
    assert any("节拍引用" in error for error in errors)
    assert any("只能在节拍" in error for error in errors)
    doc["nodes"][0]["ref"] = "malformed"
    assert any("节拍引用" in error for error in validate_graph(doc))
