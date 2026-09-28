"""Required story choices remain safe without installed content."""
import copy
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from story_outline import OutlineError, normalize_outline
from blueprints.chat import _build_branches
import session_overlay as so


def _choice_outline():
    return {
        "schema_version": 1, "plot_id": "choice_fixture", "title": "选择测试",
        "chapters": [
            {"id": "opening", "title": "开场", "beats": [
                {"id": "beat_opening", "title": "开场", "summary": "开场"}]},
            {"id": "fork", "title": "分叉", "beats": [
                {"id": "beat_fork", "title": "选择", "summary": "选择",
                 "choice_required": True, "branches": [
                     {"label": "先救泵房工人", "target_beat_id": "beat_rendezvous"}]}]},
            {"id": "rendezvous", "title": "汇合", "beats": [
                {"id": "beat_rendezvous", "title": "汇合", "summary": "汇合"}]},
            {"id": "ending", "title": "结尾", "beats": [
                {"id": "beat_ending", "title": "结尾", "summary": "结尾"}]},
        ],
    }


def test_required_choice_survives_completion_timeout_and_reload(tmp_path, monkeypatch):
    monkeypatch.setattr(so, "_SESSIONS_DIR", tmp_path)
    ov = so.SessionOverlay("choice", "story")
    ov.init_session_docs("choice_fixture", outline=_choice_outline())
    ov.jump_to_beat("beat_fork")
    ov.advance_beat()
    for _ in range(12):
        ov.update_beat_progress()
    ov.advance_beat(force=True)
    assert ov.get_current_beat_id() == "beat_fork"
    restored = so.SessionOverlay("choice", "story")
    assert restored.get_current_beat_id() == "beat_fork"
    restored.set_pending_branch({"label": "查看地图", "target_beat_id": "beat_rendezvous"})
    restored.advance_beat()
    assert restored.get_current_beat_id() == "beat_fork"
    restored.set_pending_branch({"label": "模型捷径", "target_beat_id": "beat_ending"})
    restored.advance_beat()
    assert restored.get_current_beat_id() == "beat_fork"
    branches = _build_branches(SimpleNamespace(overlay=restored, narration_count=0), [
        {"label": "先救泵房工人", "target_beat_id": None},
        {"label": "模型捷径", "target_beat_id": "beat_ending"},
        {"label": "查看地图", "target_beat_id": "beat_rendezvous"},
    ])
    rescue = next(b for b in branches if b["label"] == "先救泵房工人")
    assert rescue["target_beat_id"] == "beat_rendezvous"
    assert next(b for b in branches if b["label"] == "模型捷径")["target_beat_id"] is None
    assert next(b for b in branches if b["label"] == "查看地图")["target_beat_id"] is None
    restored.set_pending_branch(rescue)
    restored.advance_beat()
    assert restored.get_current_beat_id() == "beat_rendezvous"


def test_invalid_choice_gate_rejected_instead_of_deadlocking():
    outline = copy.deepcopy(_choice_outline())
    fork = outline["chapters"][1]["beats"][0]
    for branch in fork["branches"]:
        branch["target_beat_id"] = "missing"
    with pytest.raises(OutlineError, match="choice_required"):
        normalize_outline(outline)
