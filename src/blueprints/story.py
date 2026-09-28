"""
Story blueprint — 剧情状态展示、节点回档与参考大纲。

端点：
  GET  /api/sessions/<session_id>/story-state  — 当前位置（章节/节拍路线图 + 角色状态）
  POST /api/sessions/<session_id>/rollback-node — 回档到某关键节点并恢复该节点状态
  GET  /api/worldbooks/<book_id>/story-outline?plot_id=  — 读取书内参考大纲（系统层条目）
  POST /api/worldbooks/<book_id>/story-outline  — 从书内参考条目生成大纲并保存
        body: {"plot_id": "...", "mode": "llm" | "heuristic", "generate_combat": true}
  DELETE /api/worldbooks/<book_id>/story-outline?plot_id=  — 删除大纲条目
  POST /api/sessions/<session_id>/deviation-check — 手动触发一次偏离检测
"""

import logging

from flask import Blueprint, jsonify, request

from shared.helpers import json_error

logger = logging.getLogger(__name__)


def _get_session(session_mgr, session_id):
    """获取会话，不存在则返回 None。"""
    return session_mgr.get_session(session_id)


def register(app, managers):
    bp = Blueprint("story", __name__)
    session_mgr = managers["session"]
    wb_mgr = managers.get("worldbook")
    llm_backend = managers.get("llm_backend")

    # ── 0. 参考大纲：从指定世界书的参考条目生成节点参考 ──
    @bp.route("/api/worldbooks/<book_id>/story-outline", methods=["GET"])
    def get_story_outline(book_id: str):
        from story_outline import load_outline
        plot_id = str(request.args.get("plot_id") or "").strip()
        if not plot_id:
            return json_error("需要 plot_id 参数")
        if wb_mgr is None or wb_mgr.load(book_id) is None:
            return json_error("世界书不存在", 404)
        outline = load_outline(wb_mgr, book_id, plot_id)
        if outline is None:
            return jsonify({"exists": False, "book_id": book_id, "plot_id": plot_id, "outline": None})
        return jsonify({"exists": True, "book_id": book_id, "plot_id": plot_id, "outline": outline})

    @bp.route("/api/worldbooks/<book_id>/story-outline", methods=["POST"])
    def generate_story_outline(book_id: str):
        """从书内参考条目（剧情 + 世界/角色/地点/阵营/物品）生成参考大纲并保存为系统层条目。"""
        from session_overlay import _read_plot_file
        from story_outline import (OutlineError, generate_outline_with_llm,
                                   heuristic_outline, save_outline)

        data = request.json or {}
        plot_id = str(data.get("plot_id") or "").strip()
        if not plot_id:
            return json_error("需要 plot_id 参数")
        mode = str(data.get("mode") or "llm")
        if mode not in ("llm", "heuristic"):
            return json_error("mode 必须是 'llm' 或 'heuristic'")
        if wb_mgr is None:
            return json_error("世界书管理器不可用", 500)
        book = wb_mgr.load(book_id)
        if book is None:
            return json_error("世界书不存在", 404)
        result = _read_plot_file(plot_id, [book_id])
        if not result:
            return json_error(f"剧情不存在: {plot_id}", 404)
        meta, body = result

        if mode == "heuristic":
            outline = heuristic_outline(meta, body, worldbook_id=book_id)
            outline["generation"] = {"ok": True, "error": None, "usage": None}
        else:
            llm = None
            if llm_backend is not None:
                try:
                    llm, _ = llm_backend.get_llm()
                except Exception:
                    logger.warning("获取 LLM 失败，参考大纲改用启发式", exc_info=True)
            enemy_names: list[str] = []
            try:
                from combat_data_loader import CombatDataLoader
                enemy_names = CombatDataLoader().list_enemy_names()
            except Exception:
                logger.debug("读取敌人目录失败", exc_info=True)
            outline = generate_outline_with_llm(
                llm, meta, body, book=book, worldbook_id=book_id, available_enemies=enemy_names)

        combat_results = []
        if data.get("generate_combat", True):
            try:
                from combat_generation import materialize_outline_combat
                combat_results = materialize_outline_combat(
                    outline, worldbook_id=book_id, simulate=bool(data.get("simulate", True)))
            except Exception:
                logger.warning("大纲战斗节点物化失败", exc_info=True)
        generation = outline.pop("generation", None)
        try:
            saved = save_outline(wb_mgr, book_id, outline)
        except OutlineError as exc:
            return json_error(str(exc), 400)
        return jsonify({
            "book_id": book_id, "plot_id": plot_id, "outline": saved,
            "generation": generation, "combat_nodes": combat_results,
        })

    @bp.route("/api/worldbooks/<book_id>/story-outline", methods=["DELETE"])
    def delete_story_outline(book_id: str):
        from story_outline import delete_outline
        plot_id = str(request.args.get("plot_id") or "").strip()
        if not plot_id:
            return json_error("需要 plot_id 参数")
        if wb_mgr is None or wb_mgr.load(book_id) is None:
            return json_error("世界书不存在", 404)
        return jsonify({"deleted": delete_outline(wb_mgr, book_id, plot_id)})

    # ── 0b. 手动偏离检测 ──
    @bp.route("/api/sessions/<session_id>/deviation-check", methods=["POST"])
    def deviation_check(session_id: str):
        session = _get_session(session_mgr, session_id)
        if not session:
            return json_error("会话不存在", 404)
        if session.mode != "story" or session.overlay is None:
            return json_error("仅剧情会话支持偏离检测", 400)
        if not session.is_usable:
            return json_error("LLM 不可用", 503)
        data = request.json or {}
        threshold = float(data.get("threshold", 0.6))
        ctx = session.overlay.build_deviation_context()
        if not ctx.get("reference"):
            return json_error("会话没有参考节拍骨架，无法检测偏离", 409)
        result = session.scene_manager.assess_deviation(
            ctx["reference"], ctx["trajectory"], ctx.get("node_chain", ""))
        if result.get("usage"):
            session.accumulate_usage(result["usage"])
        if result.get("error"):
            return json_error(f"偏离检测失败: {result['error']}", 502)
        outcome = session.overlay.apply_deviation_result(
            result, threshold=threshold, round_num=session.narration_count)
        return jsonify({**outcome, "context": ctx})

    # ── 1. GET /api/sessions/<session_id>/story-state ──
    @bp.route("/api/sessions/<session_id>/story-state", methods=["GET"])
    def story_state(session_id: str):
        """剧情状态：玩家当前在节点结构中的位置 + 节拍路线图 + 角色/任务状态。"""
        session = _get_session(session_mgr, session_id)
        if not session:
            return json_error("会话不存在", 404)

        state = session.overlay.build_story_state() if session.overlay else {"has_plot": False, "roads": []}
        if not state.get("has_plot"):
            return jsonify(state)

        # 战斗节点进度（仅含 [COMBAT:] 引用的节拍）
        try:
            from combat_nodes import node_progress
            progress, _ = node_progress(session)
            state["combat_nodes"] = progress
        except Exception:
            logger.warning("计算战斗节点进度失败", exc_info=True)
            state["combat_nodes"] = {}
        return jsonify(state)

    # ── 2. POST /api/sessions/<session_id>/rollback-node ──
    @bp.route("/api/sessions/<session_id>/rollback-node", methods=["POST"])
    def rollback_node(session_id: str):
        """回档到某关键节点，恢复该节点时的叙述历史与全部会话状态。"""
        session = _get_session(session_mgr, session_id)
        if not session:
            return json_error("会话不存在", 404)
        if session.combat is not None:
            return json_error("战斗进行中，无法回档。请先完成或退出战斗。", 423)

        data = request.json or {}
        node_id = str(data.get("node_id") or "").strip()
        if not node_id:
            return json_error("需要 node_id 参数")

        try:
            result = session.rollback_to_node(node_id)
        except ValueError as e:
            return json_error(str(e), 400)
        except Exception as e:
            logger.error("节点回档失败: %s", e)
            return json_error(f"节点回档失败: {e!s}", 500)

        return jsonify(result)

    app.register_blueprint(bp)
