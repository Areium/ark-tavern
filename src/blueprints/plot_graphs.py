"""Plot graphs blueprint —— 剧情节点图（自由画布布局）的世界书存取。

端点：
  GET    /api/plot-graphs?book_id=               — 已存图文档的 plot_id 列表
  GET    /api/plot-graphs/<plot_id>?book_id=     — 读取图文档（无则 {graph: null}）
  PUT    /api/plot-graphs/<plot_id>              — 整图保存（写入世界书条目）
  DELETE /api/plot-graphs/<plot_id>?book_id=     — 删除图条目（不动底层数据）

图文档结构与"一剧情一条目"的粒度决策见 plot_graphs 模块 docstring。
"""

import logging

from flask import Blueprint, jsonify, request

from shared.helpers import json_error
from plot_graphs import (
    GraphError,
    GraphConflictError,
    delete_graph,
    list_graphs,
    load_graph,
    normalize_graph,
    save_graph,
    validate_graph,
)

logger = logging.getLogger(__name__)


def register(app, managers):
    book_mgr = managers["worldbook"]
    bp = Blueprint("plot_graphs", __name__)

    @bp.route("/api/plot-graphs/<path:plot_id>/media-options", methods=["GET"])
    def media_options(plot_id):
        from story_outline import load_outline, outline_to_beats, heuristic_outline
        from session_overlay import _read_plot_file
        from story_rules import rule_key
        book_id = str(request.args.get("book_id") or "")
        if not book_id or book_mgr.load(book_id) is None:
            return json_error("世界书不存在", 404)
        outline = load_outline(book_mgr, book_id, plot_id)
        if not outline:
            source = _read_plot_file(plot_id, [book_id])
            if not source:
                return json_error("剧情不存在", 404)
            outline = heuristic_outline(source[0], source[1], worldbook_id=book_id)
        choices = {beat["id"]: [{"rule_key": rule_key(branch), "label": branch["label"]}
                                for branch in beat.get("authored_branches", []) if branch.get("source") == "author"]
                   for chapter in outline_to_beats(outline) for beat in chapter["beats"]}
        return jsonify({"choices": choices})

    @bp.route("/api/plot-graphs", methods=["GET"])
    def index():
        """某书下已有图文档的 plot_id 列表（二级菜单角标用）。"""
        book_id = str(request.args.get("book_id") or "")
        if not book_id:
            return json_error("缺少 book_id", 400)
        return jsonify({"book_id": book_id, "graphs": list_graphs(book_mgr, book_id)})

    @bp.route("/api/plot-graphs/<path:plot_id>", methods=["GET"])
    def get_graph(plot_id: str):
        book_id = str(request.args.get("book_id") or "")
        if not book_id:
            return json_error("缺少 book_id", 400)
        try:
            doc = load_graph(book_mgr, book_id, plot_id)
        except GraphError as e:
            return json_error("；".join(e.errors), 422)
        return jsonify({"plot_id": plot_id, "book_id": book_id, "graph": doc})

    @bp.route("/api/plot-graphs/<path:plot_id>", methods=["PUT"])
    def put_graph(plot_id: str):
        data = request.json or {}
        book_id = str(data.get("book_id") or "")
        doc = data.get("graph") if isinstance(data.get("graph"), dict) else None
        if doc is None:
            return json_error("缺少 graph 文档", 400)
        doc = normalize_graph(doc, plot_id=plot_id)
        errors = validate_graph(doc, plot_id=plot_id)
        if errors:
            return json_error("；".join(errors), 400)
        try:
            saved = save_graph(book_mgr, book_id, doc,
                               display_name=str(data.get("display_name") or ""),
                               expected_revision=doc.get("_revision", "absent"))
        except GraphConflictError as e:
            return json_error("；".join(e.errors), 409)
        except GraphError as e:
            return json_error("；".join(e.errors), 400)
        return jsonify({"ok": True, "plot_id": plot_id, "book_id": book_id,
                        "saved_at": saved.get("updated_at", 0),
                        "_revision": saved["_revision"],
                        "node_count": len(saved.get("nodes") or []),
                        "edge_count": len(saved.get("edges") or [])})

    @bp.route("/api/plot-graphs/<path:plot_id>", methods=["DELETE"])
    def remove_graph(plot_id: str):
        book_id = str(request.args.get("book_id") or "")
        if not book_id:
            return json_error("缺少 book_id", 400)
        deleted = delete_graph(book_mgr, book_id, plot_id)
        return jsonify({"ok": True, "deleted": deleted})

    app.register_blueprint(bp)
    return bp
