"""Independent side view combat routes. No grid CombatSession is created."""

from __future__ import annotations

import copy
import logging
import time
import uuid
from functools import wraps

from flask import Blueprint, jsonify, request

from combat_approaches import list_approaches, resolve_approach, roll_check
from combat_data_loader import CombatDataLoader
from combat_resume import session_resume_path
from combat_settlement import (SettlementApplyError, apply_settlement, append_history,
                               compute_character_growth)
from document_manager import DocumentNotFoundError
from shared.helpers import build_character_metas, json_error
from sideview_combat import (apply_combat_params, initial_snapshot, load_level,
                             minimum_victory_ms, validate_snapshot, victory_satisfied)

logger = logging.getLogger(__name__)


def _state(run: dict) -> dict:
    state = {"engine": "sideview", "runId": run["runId"], "level": run["level"],
             "operator": run["operator"], "supportName": run.get("supportName"),
             "snapshot": run["snapshot"], "status": run["status"],
             "appliedEffects": run.get("appliedEffects", {})}
    if run["status"] == "settling":
        state["outcome"] = run["outcome"]
    return state


def _active_run(session, run_id: str | None):
    run = session.overlay._data.get("sideview_run")
    if not isinstance(run, dict) or run.get("status") not in ("active", "suspended", "settling"):
        return None
    return run if isinstance(run_id, str) and run_id == run.get("runId") else None


def _settlement(session, run: dict, outcome: str) -> dict:
    victory = outcome == "victory"
    reward_mult = float(run["rewardMult"])
    xp = round(int(run["level"]["rewards"]["xp"]) * reward_mult) if victory else 0
    rewards = run["level"]["rewards"]
    items = ([{"name": item, "count": 1} if isinstance(item, str) else copy.deepcopy(item)
              for item in rewards.get("items", [])] if victory else [])
    # Growth uses the same overlay progress as tactical combat. Only the deployed
    # operator receives battle XP; support is visual assistance in this mode.
    name = run["operator"]["name"]
    meta = run["operatorMeta"]
    overrides = session.overlay.get_character_overrides(name) or {}
    progress = overrides.get("progress", {}) or {}
    attrs = dict(meta.get("attributes", {}) or {})
    attrs.update((overrides.get("metadata", {}) or {}).get("attributes", {}) or {})
    character = compute_character_growth(name, attrs, progress, xp,
                                         in_battle=True, alive=run["snapshot"]["player"]["hp"] > 0)
    return {
        "settlement_id": uuid.uuid4().hex[:12], "engine": "sideview",
        "durationMs": run["snapshot"]["elapsedMs"],
        "appliedEffects": run.get("appliedEffects", {}),
        "encounter_id": run["encounterId"],
        "encounter_name": run["level"]["name"],
        "winner": "player" if victory else "enemy", "rounds": 0,
        "reward_mult": reward_mult, "victory": victory,
        "characters": [character] if victory else [],
        "rewards": {"xp_total": xp, "enemy_xp": 0, "items": items,
                    "cards": [], "unwired": [], "xp_formula": "关卡经验 × 打法倍率"},
        "has_reward": victory and (xp > 0 or bool(items)),
        "empty_message": None if victory else "战斗未获胜，没有经验与奖励",
        "created_at": time.time(),
    }


def register(app, managers):
    bp = Blueprint("sideview", __name__)
    session_mgr = managers["session"]
    doc_mgr = managers["document"]

    def get_session(session_id):
        session = session_mgr.get_session(session_id)
        if session is None:
            return None, json_error("会话不存在", 404)
        if session.combat_mode != "sideview":
            return None, json_error("会话不是侧卷轴模式", 400)
        return session, None

    def locked_session_route(handler):
        """Serialize each session's check and writeback with overlay's RLock."""
        @wraps(handler)
        def wrapped(session_id):
            session, error = get_session(session_id)
            if error:
                return error
            with session.overlay._lock:
                return handler(session_id)
        return wrapped

    def clear_run_pending(session, run):
        pending = session.overlay.get_pending_settlement()
        if not pending or pending.get("sideview_run_id") != run["runId"]:
            return None
        try:
            session.overlay.clear_pending_settlement()
        except Exception:
            # clear_pending_settlement removes the in-memory key before _save;
            # restore it so another request can retry without restarting.
            session.overlay._data["pending_settlement"] = pending
            logger.exception("Could not clear sideview settlement for %s", run["runId"])
            return json_error("结算已完成，但清理待结算记录失败，请重试", 500)
        return None

    @bp.post("/api/sessions/<session_id>/sideview/start")
    @locked_session_route
    def start(session_id):
        session, error = get_session(session_id)
        if error:
            return error
        data = request.get_json(silent=True) or {}
        if not isinstance(data, dict):
            return json_error("请求体无效", 400)
        existing = session.overlay._data.get("sideview_run")
        if isinstance(existing, dict) and existing.get("status") in ("active", "suspended", "settling"):
            return json_error("已有未完成的侧卷轴战斗", 409)
        if session.combat is not None or session_resume_path(session).is_file():
            return json_error("已有旧战斗或挂起存档，不能启动侧卷轴战斗", 409)
        if session.overlay.get_pending_settlement() is not None:
            return json_error("存在未完成的战斗结算，请先重试结算", 409)
        encounter_id = data.get("encounter_id")
        if not isinstance(encounter_id, str) or not encounter_id.strip() or len(encounter_id) > 120:
            return json_error("encounter_id 无效", 400)
        encounter_id = encounter_id.strip()
        encounter = CombatDataLoader().load_node(encounter_id)
        if encounter is None:
            return json_error("遭遇节点不存在或未启用", 404)
        metas = build_character_metas(session, doc_mgr)
        known_names = {meta.get("name") for meta in metas}
        # Scene characters are NPC teammates; the chosen player identity is a
        # roster member but intentionally absent from get_scene_characters().
        for name in session.scene_manager.get_roster():
            if name in known_names:
                continue
            try:
                document = doc_mgr.read_document("characters", name)
                metadata, _ = session.overlay.apply_character_overrides(
                    name, document["metadata"], document.get("content", ""))
            except (DocumentNotFoundError, OSError, KeyError, TypeError, ValueError):
                logger.warning("Sideview roster character unavailable: %s", name)
                continue
            metas.append(metadata)
            known_names.add(metadata.get("name"))
        if not metas:
            return json_error("没有可用角色，请先加载角色到场景中", 400)
        requested = data.get("operator_name") or session.scene_manager.active
        if requested not in known_names and not data.get("operator_name"):
            requested = session.player_identity
        if requested:
            operator = next((meta for meta in metas if meta.get("name") == requested), None)
            if operator is None:
                return json_error("参战角色不在当前场景中", 400)
        else:
            operator = metas[0]
        support = next((meta.get("name") for meta in metas if meta.get("name") != operator.get("name")), None)
        approach_id = data.get("approach_id")
        if approach_id is None and encounter.get("approaches"):
            return jsonify({"ok": True, "kind": "approaches", "encounter_id": encounter_id,
                            "approaches": list_approaches(encounter)})
        if approach_id is not None and not any(a["id"] == approach_id for a in list_approaches(encounter)):
            return json_error("approach_id 无效", 400)
        resolved = resolve_approach(encounter, approach_id)
        kind = resolved["kind"]
        base = {"ok": True, "encounter_id": encounter_id, "label": resolved["label"],
                "hint": resolved["hint"]}
        if kind == "avoid":
            return jsonify({**base, "kind": "avoid"})
        check = None
        if kind == "check":
            check = roll_check(metas, resolved["check"])
            if check["success"]:
                return jsonify({**base, "kind": "check", "check": check,
                                "combat_started": False})
        try:
            level = load_level(encounter_id)
        except (OSError, ValueError, KeyError) as exc:
            logger.exception("Failed to load sideview level")
            return json_error(f"关卡加载失败：{exc}", 500)
        # Keep a frozen copy of the level and combat modifiers with the run.
        # Config edits after start must not change an existing run's rewards.
        attrs = operator.get("attributes") or {}
        def attribute(key):
            try:
                value = attrs.get(key)
                if value is None and key == "特殊技艺":
                    value = attrs.get("源石技艺适应性")  # 旧角色资料兼容
                return max(1, min(10, int(value if value is not None else 5)))
            except (TypeError, ValueError):
                return 5
        hp = 80 + attribute("生理耐受") * 12
        public_operator = {"name": operator["name"], "maxHp": hp,
                           "attack": 12 + attribute("物理强度") * 2,
                           "skillPower": 20 + attribute("特殊技艺") * 3}
        params = (resolved["fail_combat_params"] if kind == "check"
                  else resolved["combat_params"])
        level, applied = apply_combat_params(level, params, operator["name"])
        previous_status = session.overlay._data.get("sideview_status") or {}
        if previous_status.get("operatorName") == operator["name"]:
            previous_hp = previous_status.get("hp")
            if isinstance(previous_hp, (int, float)) and not isinstance(previous_hp, bool):
                starting_hp = (min(hp, max(1, round(hp * 0.25))) if previous_hp <= 0
                               else min(hp, max(1, round(previous_hp))))
                applied["inheritedHp"] = starting_hp
                applied["recoveredFromDefeat"] = previous_hp <= 0
            else:
                starting_hp = hp
        else:
            starting_hp = hp
        starting_hp = max(1, starting_hp - round(hp * applied["hpPenalty"]))
        applied["startingHp"] = starting_hp
        run = {"runId": uuid.uuid4().hex, "encounterId": encounter_id,
               "levelId": level["id"], "level": level, "configVersion": level["schemaVersion"],
               "operator": public_operator, "operatorMeta": copy.deepcopy(operator),
               "supportName": support,
               "initialHp": hp, "rewardMult": resolved["reward_mult"],
               "snapshot": initial_snapshot(level, starting_hp), "status": "active",
               "appliedEffects": applied,
               "createdAt": time.time(), "updated_at": time.time()}
        session.overlay._data["sideview_run"] = run
        session.overlay._save()
        response = {**base, "kind": "sideview", "state": _state(run)}
        if check is not None:
            response.update(check=check, combat_started=True)
        return jsonify(response)

    @bp.get("/api/sessions/<session_id>/sideview/state")
    def state(session_id):
        session, error = get_session(session_id)
        if error:
            return error
        run = session.overlay._data.get("sideview_run")
        if not isinstance(run, dict):
            return json_error("没有侧卷轴战斗存档", 404)
        return jsonify({"ok": True, "state": _state(run)})

    @bp.post("/api/sessions/<session_id>/sideview/save")
    @locked_session_route
    def save(session_id):
        session, error = get_session(session_id)
        if error:
            return error
        data = request.get_json(silent=True) or {}
        run = _active_run(session, data.get("runId") if isinstance(data, dict) else None)
        if not run or run["status"] == "settling":
            return json_error("runId 不匹配或战斗不可保存", 409)
        if "suspended" in data and type(data["suspended"]) is not bool:
            return json_error("suspended 必须是布尔值", 400)
        try:
            snapshot = validate_snapshot(data.get("snapshot"), run["level"], run["initialHp"], run["snapshot"])
        except (ValueError, KeyError, TypeError) as exc:
            return json_error(str(exc), 400)
        run["snapshot"] = snapshot
        run["status"] = "suspended" if data.get("suspended") else "active"
        run["updated_at"] = time.time()
        session.overlay._save()
        return jsonify({"ok": True, "state": _state(run)})

    @bp.post("/api/sessions/<session_id>/sideview/complete")
    @locked_session_route
    def complete(session_id):
        session, error = get_session(session_id)
        if error:
            return error
        data = request.get_json(silent=True) or {}
        if not isinstance(data, dict):
            return json_error("请求体无效", 400)
        run = session.overlay._data.get("sideview_run")
        if not isinstance(run, dict) or data.get("runId") != run.get("runId"):
            return json_error("runId 不匹配", 409)
        if data.get("levelId") != run.get("levelId"):
            return json_error("levelId 不匹配", 409)
        if run["status"] == "completed":
            cleanup_error = clear_run_pending(session, run)
            if cleanup_error:
                return cleanup_error
            return jsonify(run["completion"])
        if run["status"] not in ("active", "suspended", "settling"):
            return json_error("战斗不可结算", 409)
        outcome = data.get("outcome")
        if outcome not in ("victory", "defeat"):
            return json_error("outcome 无效", 400)
        pending = session.overlay.get_pending_settlement()
        if run["status"] == "settling":
            if not pending or pending.get("sideview_run_id") != run["runId"]:
                return json_error("结算进度缺失", 409)
        else:
            try:
                snapshot = validate_snapshot(data.get("snapshot"), run["level"],
                                             run["initialHp"], run["snapshot"])
            except (ValueError, KeyError, TypeError) as exc:
                return json_error(str(exc), 400)
            if (not isinstance(data.get("durationMs"), int)
                    or type(data["durationMs"]) is bool
                    or data["durationMs"] != snapshot["elapsedMs"]
                    or data.get("hpRemaining") != snapshot["player"]["hp"]
                    or data.get("kills") != sum(e["hp"] == 0 for e in snapshot["enemies"])
                    or not isinstance(data.get("damageTaken"), (int, float))
                    or isinstance(data["damageTaken"], bool)
                    or not 0 <= data["damageTaken"] <= 1000000
                    or data.get("damageTaken") != snapshot.get("damageTaken", data.get("damageTaken"))):
                return json_error("战斗结果与快照不匹配", 400)
            if outcome == "victory" and not victory_satisfied(snapshot, run["level"]):
                return json_error("胜利条件未达成", 400)
            if outcome == "victory":
                minimum_ms = minimum_victory_ms(run["level"])
                if (snapshot["elapsedMs"] < minimum_ms
                        or (time.time() - run["createdAt"]) * 1000 < minimum_ms):
                    return json_error("到达终点所需时间尚未达到", 400)
            if outcome == "defeat" and snapshot["player"]["hp"] > 0:
                return json_error("主控仍存活，不能申报战败", 400)
            run["snapshot"] = snapshot
            run["status"] = "settling"
            run["updated_at"] = time.time()
            run["outcome"] = outcome
            settlement = _settlement(session, run, outcome)
            pending = {"data": settlement, "applied": {"characters": [], "inventory": False},
                       "sideview_run_id": run["runId"]}
            session.overlay.set_pending_settlement(pending)
        try:
            apply_settlement(session, pending)
        except SettlementApplyError as exc:
            logger.error("侧卷轴结算待重试 %s: %s", run["runId"], exc)
            return json_error(f"战斗结算写入失败：{exc}", 500)
        settlement = pending["data"]
        outcome = run["outcome"]
        status = {"operatorName": run["operator"]["name"],
                  "hp": run["snapshot"]["player"]["hp"],
                  "maxHp": run["initialHp"], "outcome": outcome,
                  "runId": run["runId"]}
        session.overlay._data["sideview_status"] = status
        if not run.get("historyWritten"):
            history = append_history(session, encounter_id=run["encounterId"],
                                     winner="player" if outcome == "victory" else "enemy",
                                     rounds=0, reward_mult=run["rewardMult"],
                                     settlement=settlement,
                                     extra={"engine": "sideview", "runId": run["runId"],
                                            "durationMs": run["snapshot"]["elapsedMs"]})
            run["historyWritten"] = True
        else:
            history = session.overlay._data.get("combat_history", [])
        action = ("战斗结束，玩家获胜，描述战斗后的场景" if outcome == "victory" else
                  "战斗失利，描述战败后的场景与代价（fail-forward，剧情继续推进）")
        response = {"ok": True, "settlement": settlement, "history": history,
                    "auto_narrate_action": action}
        run["completion"] = response
        run["status"] = "completed"
        run["updated_at"] = time.time()
        session.overlay._save()
        cleanup_error = clear_run_pending(session, run)
        if cleanup_error:
            return cleanup_error
        session.scene_manager._log_event(
            f"⚔ 侧卷轴战斗结束：遭遇战「{run['encounterId']}」— {'胜利' if outcome == 'victory' else '战败'}")
        return jsonify(response)

    @bp.post("/api/sessions/<session_id>/sideview/abandon")
    @locked_session_route
    def abandon(session_id):
        session, error = get_session(session_id)
        if error:
            return error
        data = request.get_json(silent=True) or {}
        run = _active_run(session, data.get("runId") if isinstance(data, dict) else None)
        if not run or run["status"] == "settling":
            return json_error("runId 不匹配或战斗不可放弃", 409)
        run["status"] = "abandoned"
        run["updated_at"] = time.time()
        session.overlay._data["sideview_status"] = {
            "operatorName": run["operator"]["name"],
            "hp": run["snapshot"]["player"]["hp"], "maxHp": run["initialHp"],
            "outcome": "abandoned", "runId": run["runId"]}
        session.overlay._save()
        session.scene_manager._log_event(f"⚔ 侧卷轴战斗已放弃：遭遇战「{run['encounterId']}」")
        return jsonify({"ok": True, "message": "战斗已放弃",
                        "auto_narrate_action": "战斗已放弃，描述当前场景"})

    app.register_blueprint(bp)
