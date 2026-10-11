"""
会话回退 blueprint。
"""

import logging

from flask import Blueprint, jsonify, request

from shared.helpers import json_error
from story_rules import narration_guard

logger = logging.getLogger(__name__)


def _get_session(session_mgr, session_id):
    """获取会话，不存在则返回 None。"""
    session = session_mgr.get_session(session_id)
    if not session:
        return None
    return session


def register(app, managers):
    bp = Blueprint("memories", __name__)
    session_mgr = managers["session"]
    @bp.route("/api/sessions/<session_id>/rollback", methods=["POST"])
    @narration_guard(session_mgr)
    def rollback_session(session_id: str):
        """回退会话到指定轮次，删除其后的叙述历史。"""
        session = _get_session(session_mgr, session_id)
        if not session:
            return json_error("会话不存在", 404)

        data = request.json or {}
        target_round = data.get("round")

        if target_round is None:
            return json_error("需要 round 参数")

        try:
            target_round = int(target_round)
        except (ValueError, TypeError):
            return json_error("round 必须是非负整数")

        if target_round < 0:
            return json_error("round 必须是非负整数")

        receipts = session.overlay._data.get("story_choice_receipts", {})
        if receipts and (
                target_round < session.narration_count or session.overlay._data.get("pending_story_choice")):
            return json_error("当前剧情已结算作者选项，请使用节点图回档以完整恢复状态", 409)
        try:
            result = session.rollback_to_round(target_round)
        except ValueError as exc:
            return json_error(str(exc), 409)
        return jsonify(result)

    app.register_blueprint(bp)
