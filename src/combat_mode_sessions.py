"""Session-owned plugin lifecycle. Plugin results require explicit user acceptance.

No client-supplied reward/character mutations are accepted. State, history and
confirmation receipts are one overlay transaction, and follow story rollback.
"""
from __future__ import annotations

import copy
import math
import re
import time
import uuid

from combat_mode_bindings import read_frozen_binding
from combat_mode_packages import BUILTIN_IDS
from combat_mode_runs import OUTCOMES, RunConflict, json_object, runtime_bundle


def is_plugin_mode(value):
    return isinstance(value, str) and value not in BUILTIN_IDS


def session_binding(session):
    if not is_plugin_mode(session.combat_mode):
        raise ValueError("This session does not use a combat plugin")
    binding = read_frozen_binding(session.data_dir, session.combat_mode)
    expected = session.overlay._data.get("combat_plugin_binding", {})
    if (not isinstance(expected, dict) or expected.get("binding_digest") != binding.digest
            or expected.get("package_digest") != binding.package.digest):
        raise ValueError("Session combat plugin fingerprint mismatch")
    return binding


def plugin_state(session):
    state = session.overlay._data.get("combat_plugin", {})
    if not isinstance(state, dict) or set(state) - {"run", "history"}:
        raise ValueError("Invalid session plugin state")
    run = state.get("run")
    if run is not None:
        if (not isinstance(run, dict)
                or not {"runId", "encounter_id", "status", "revision", "snapshot", "outcome", "updatedAt"} <= run.keys()
                or not isinstance(run.get("runId"), str)
                or not re.fullmatch(r"[0-9a-f]{32}", run["runId"])
                or run.get("status") not in ("active", "settling", "completed")
                or type(run.get("revision")) is not int or run["revision"] < 0
                or not isinstance(run.get("encounter_id"), str)
                or not run["encounter_id"]):
            raise ValueError("Invalid session plugin run")
        if run.get("snapshot") is not None:
            json_object(run["snapshot"])
        if run["status"] in ("settling", "completed"):
            if not isinstance(run.get("outcome"), str) or run["outcome"] not in OUTCOMES:
                raise ValueError("Invalid session plugin outcome")
        elif run.get("outcome") is not None:
            raise ValueError("Active plugin run cannot have an outcome")
    history = state.get("history", [])
    if not isinstance(history, list) or len(history) > 100:
        raise ValueError("Invalid plugin history")
    seen = set()
    for entry in history:
        if (not isinstance(entry, dict)
                or not isinstance(entry.get("runId"), str)
                or not re.fullmatch(r"[0-9a-f]{32}", entry["runId"])
                or entry["runId"] in seen
                or not isinstance(entry.get("encounter_id"), str)
                or not isinstance(entry.get("name"), str)
                or not isinstance(entry.get("outcome"), str)
                or entry["outcome"] not in OUTCOMES
                or entry.get("verified") is not False
                or entry.get("accepted_by_user") is not True
                or entry.get("rewards") is not None
                or type(entry.get("created_at")) not in (int, float)
                or not math.isfinite(entry["created_at"])):
            raise ValueError("Invalid plugin history entry")
        seen.add(entry["runId"])
    if run is not None and run["status"] == "completed":
        receipt = run.get("completion")
        if (not isinstance(receipt, dict) or receipt.get("ok") is not True
                or not isinstance(receipt.get("auto_narrate_action"), str)
                or not receipt["auto_narrate_action"]
                or not history or receipt.get("history") != history[-1]
                or history[-1]["runId"] != run["runId"]
                or history[-1]["encounter_id"] != run["encounter_id"]
                or history[-1]["outcome"] != run["outcome"]):
            raise ValueError("Invalid plugin completion receipt")
    elif run is not None and ("completion" in run or run["runId"] in seen):
        raise ValueError("Unfinished plugin run has a completion receipt")
    return state


def run_status(session):
    if not is_plugin_mode(session.combat_mode):
        return ""
    return (plugin_state(session).get("run") or {}).get("status", "")


def _commit(session, state):
    overlay = session.overlay
    before = overlay._data
    draft = copy.deepcopy(before)
    draft["combat_plugin"] = state
    overlay._data = draft
    try:
        overlay._save()
    except Exception:
        overlay._data = before
        raise


def describe(session):
    binding = session_binding(session)
    state = plugin_state(session)
    run = copy.deepcopy(state.get("run"))
    bundle = None
    if run is not None:
        encounter = binding.encounters.get(run["encounter_id"])
        if encounter is None:
            raise ValueError("Saved encounter is absent from the frozen binding")
        run["input"] = copy.deepcopy(encounter["input"])
        run["name"] = encounter["name"]
        bundle = runtime_bundle(binding.package)
        bundle["resources"].update(encounter["resources"])
    return {"binding": binding.summary(), "run": run, "bundle": bundle,
            "history": copy.deepcopy(state.get("history", []))}


def start(session, encounter_id):
    with session.overlay._lock:
        binding = session_binding(session)
        state = copy.deepcopy(plugin_state(session))
        current = state.get("run")
        if current and current["status"] != "completed":
            if current["encounter_id"] == encounter_id:
                return describe(session)
            raise RunConflict("Another plugin encounter is active")
        if not isinstance(encounter_id, str) or encounter_id not in binding.encounters:
            raise ValueError("Encounter is not part of this session's frozen combat mode")
        if session.combat is not None or session.overlay.get_pending_settlement():
            raise RunConflict("Another combat or settlement is active")
        state["run"] = {"runId": uuid.uuid4().hex, "encounter_id": encounter_id,
                        "status": "active", "revision": 0, "snapshot": None,
                        "outcome": None, "updatedAt": time.time()}
        _commit(session, state)
        return describe(session)


def update(session, run_id, revision, snapshot, outcome=None):
    if type(revision) is not int or revision < 0:
        raise ValueError("revision must be a nonnegative integer")
    snapshot = json_object(snapshot)
    if outcome is not None and (not isinstance(outcome, str) or outcome not in OUTCOMES):
        raise ValueError("Unknown plugin outcome")
    with session.overlay._lock:
        session_binding(session)
        state = copy.deepcopy(plugin_state(session))
        run = state.get("run")
        if not run or run["runId"] != run_id:
            raise RunConflict("runId no longer matches the current encounter")
        if run["status"] != "active":
            if outcome and run["outcome"] == outcome and run["snapshot"] == snapshot:
                return copy.deepcopy(run)
            raise RunConflict("Run has already reported a result")
        if run["revision"] != revision:
            raise RunConflict("Stale run revision; reload before continuing")
        run.update(snapshot=snapshot, revision=revision + 1, updatedAt=time.time())
        if outcome:
            run.update(status="settling", outcome=outcome)
        _commit(session, state)
        return copy.deepcopy(run)


def confirm(session, run_id, revision, *, accept=False, retreat=False):
    """Only the user-facing host calls this, after an explicit confirmation.

    The iframe ABI exposes save/complete but not this acceptance capability.
    Retrying the same confirmation returns its persisted receipt.
    """
    if type(revision) is not int or type(accept) is not bool or type(retreat) is not bool:
        raise ValueError("Invalid confirmation parameters")
    if accept == retreat or revision < 0:
        raise ValueError("Explicit acceptance or retreat is required")
    with session.overlay._lock:
        binding = session_binding(session)
        state = copy.deepcopy(plugin_state(session))
        run = state.get("run")
        if not run or run["runId"] != run_id:
            raise RunConflict("runId no longer matches the current encounter")
        if run["status"] == "completed":
            return copy.deepcopy(run["completion"])
        if run["revision"] != revision:
            raise RunConflict("Stale run revision; reload before confirming")
        if not retreat and run["status"] != "settling":
            raise RunConflict("The plugin has not reported a result")
        outcome = "retreat" if retreat else run["outcome"]
        label = {"victory": "胜利", "defeat": "失利", "retreat": "撤退"}[outcome]
        encounter = binding.encounters.get(run["encounter_id"])
        if encounter is None:
            raise ValueError("Saved encounter is absent from the frozen binding")
        entry = {"runId": run_id, "encounter_id": run["encounter_id"], "name": encounter["name"],
                 "outcome": outcome, "verified": False, "accepted_by_user": True,
                 "rewards": None, "created_at": time.time()}
        history = state.setdefault("history", [])
        history.append(entry)
        state["history"] = history[-100:]
        completion = {"ok": True, "history": entry,
                      "auto_narrate_action": f"玩家确认插件战斗「{encounter['name']}」以{label}结束。描述战后的场景与后续发展，不额外发放经验或物品。"}
        run.update(status="completed", outcome=outcome, revision=revision + 1,
                   updatedAt=time.time(), completion=completion)
        _commit(session, state)
        return copy.deepcopy(completion)
