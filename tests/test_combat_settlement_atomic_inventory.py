"""An interrupted inventory write must not duplicate battle rewards on retry."""

import copy
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from combat_settlement import SettlementApplyError, apply_settlement  # noqa: E402


class Overlay:
    def __init__(self):
        self._data = {"inventory": []}
        self.disk = copy.deepcopy(self._data)
        self.fail_once = True

    def set_pending_settlement(self, pending):
        self._data["pending_settlement"] = pending
        if self.fail_once:
            self.fail_once = False
            raise OSError("simulated disk write failure")
        self.disk = copy.deepcopy(self._data)


def test_inventory_and_applied_marker_commit_together():
    overlay = Overlay()
    session = SimpleNamespace(overlay=overlay)
    pending = {
        "data": {"characters": [], "rewards": {"items": [{"name": "源石碎片", "count": 2}]}},
        "applied": {"characters": [], "inventory": False},
    }

    with pytest.raises(SettlementApplyError):
        apply_settlement(session, pending)
    assert overlay._data["inventory"] == []
    assert overlay.disk["inventory"] == []
    assert pending["applied"]["inventory"] is False

    apply_settlement(session, pending)
    assert len(overlay.disk["inventory"]) == 1
    assert overlay.disk["inventory"][0]["name"] == "源石碎片"
    assert overlay.disk["inventory"][0]["count"] == 2
    assert overlay.disk["pending_settlement"]["applied"]["inventory"] is True
    apply_settlement(session, pending)
    assert len(overlay.disk["inventory"]) == 1
    assert overlay.disk["inventory"][0]["count"] == 2
