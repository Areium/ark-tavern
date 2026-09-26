"""Source/pack agreement and decision safety, without model calls or user data writes."""
import copy
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "src"), str(ROOT / "scripts")]

from generate_grey_lantern import build_book, build_outline
from generate_builtin_worldbook import collect_entries
from split_builtin_story_worldbooks import split_builtin_book
from story_outline import OutlineError, normalize_outline
from world_book import WorldBook, is_system_entry
from blueprints.chat import _build_branches
import session_overlay as so


def test_pack_is_reproducible_and_system_entries_never_inject():
    committed = json.loads((ROOT / "data/worldbooks/packs/grey-lantern.json").read_text(encoding="utf-8"))
    assert build_book() == committed
    book = WorldBook.from_dict(committed)
    assert len([e for e in book.entries if is_system_entry(e)]) == 1
    combat = [e for e in book.entries if e.uid.startswith("combat_node_")]
    assert len(combat) == 3 and all(not e.enabled for e in combat)
    assert all(e.always_active and e.position == 0 for e in book.entries
               if e.enabled and not is_system_entry(e))


def test_generator_accepts_absent_optional_graph_but_keeps_story_requirements():
    entries = [e for e in collect_entries() if e["uid"] != "plot_graph_near-light"]
    _, stories = split_builtin_book({"id": "arknights", "entries": entries})
    assert "near-light" in stories
    with pytest.raises(ValueError, match="grey-lantern"):
        split_builtin_book({"id": "arknights", "entries": [e for e in entries if e["uid"] != "world_灰灯渡口"]})


def test_required_choice_survives_completion_timeout_and_reload(tmp_path, monkeypatch):
    monkeypatch.setattr(so, "_SESSIONS_DIR", tmp_path)
    ov = so.SessionOverlay("grey_choice", "story")
    ov.init_session_docs("grey_lantern", outline=build_outline())
    ov.jump_to_beat("beat_grey_fork")
    ov.advance_beat()
    for _ in range(12):
        ov.update_beat_progress()
    ov.advance_beat(force=True)
    assert ov.get_current_beat_id() == "beat_grey_fork"
    restored = so.SessionOverlay("grey_choice", "story")
    assert restored.get_current_beat_id() == "beat_grey_fork"
    restored.set_pending_branch({"label": "查看地图", "target_beat_id": "beat_grey_rendezvous"})
    restored.advance_beat()
    assert restored.get_current_beat_id() == "beat_grey_fork"
    restored.set_pending_branch({"label": "模型捷径", "target_beat_id": "beat_grey_ending"})
    restored.advance_beat()
    assert restored.get_current_beat_id() == "beat_grey_fork"
    branches = _build_branches(SimpleNamespace(overlay=restored), [
        {"label": "先救泵房工人", "target_beat_id": None},
        {"label": "模型捷径", "target_beat_id": "beat_grey_ending"},
        {"label": "查看地图", "target_beat_id": "beat_grey_rendezvous"},
    ])
    rescue = next(b for b in branches if b["label"] == "先救泵房工人")
    assert rescue["target_beat_id"] == "beat_grey_rendezvous"
    assert next(b for b in branches if b["label"] == "模型捷径")["target_beat_id"] is None
    assert next(b for b in branches if b["label"] == "查看地图")["target_beat_id"] is None
    restored.set_pending_branch(rescue)
    restored.advance_beat()
    assert restored.get_current_beat_id() == "beat_grey_rendezvous"


def test_invalid_choice_gate_rejected_instead_of_deadlocking():
    outline = copy.deepcopy(build_outline())
    fork = outline["chapters"][2]["beats"][0]
    for branch in fork["branches"]:
        branch["target_beat_id"] = "missing"
    with pytest.raises(OutlineError, match="choice_required"):
        normalize_outline(outline)
