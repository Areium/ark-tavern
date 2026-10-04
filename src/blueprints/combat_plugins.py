"""Session-scoped combat plugin operations, separate from tactical/sideview APIs."""
from functools import wraps

from flask import Blueprint, jsonify, request

import combat_mode_sessions as lifecycle
from combat_mode_packages import _json
from combat_mode_runs import MAX_STATE_BYTES, RunConflict
from shared.helpers import json_error
from story_rules import narration_guard


def register(app, managers):
    bp = Blueprint("combat_plugins", __name__)
    session_mgr = managers["session"]

    def route(fn):
        @wraps(fn)
        def wrapped(session_id):
            session = session_mgr.get_session(session_id)
            if session is None:
                return json_error("会话不存在", 404)
            if not lifecycle.is_plugin_mode(session.combat_mode):
                return json_error("会话未使用可安装战斗模式", 409)
            try:
                with session.overlay._lock:
                    return fn(session)
            except RunConflict as exc:
                return json_error(str(exc), 409)
            except (ValueError, OSError) as exc:
                return json_error(str(exc), 400)
        return wrapped

    def body(allowed):
        raw = request.stream.read(MAX_STATE_BYTES + 65537)
        if len(raw) > MAX_STATE_BYTES + 65536:
            raise ValueError("Plugin request exceeds size limit")
        data = _json(raw)
        if data.keys() - set(allowed):
            raise ValueError("Unknown plugin request fields")
        return data

    @bp.get("/api/sessions/<session_id>/combat-plugin")
    @route
    def state(session):
        return jsonify(lifecycle.describe(session))

    @bp.post("/api/sessions/<session_id>/combat-plugin/start")
    @narration_guard(session_mgr)
    @route
    def start(session):
        data = body({"encounter_id"})
        return jsonify(lifecycle.start(session, data.get("encounter_id")))

    @bp.put("/api/sessions/<session_id>/combat-plugin/state")
    @narration_guard(session_mgr)
    @route
    def update(session):
        data = body({"runId", "revision", "snapshot", "outcome"})
        return jsonify(lifecycle.update(session, data.get("runId"), data.get("revision"),
                                        data.get("snapshot"), data.get("outcome")))

    @bp.post("/api/sessions/<session_id>/combat-plugin/confirm")
    @narration_guard(session_mgr)
    @route
    def confirm(session):
        data = body({"runId", "revision", "accept", "retreat"})
        return jsonify(lifecycle.confirm(session, data.get("runId"), data.get("revision"),
                                         accept=data.get("accept", False), retreat=data.get("retreat", False)))

    app.register_blueprint(bp)
