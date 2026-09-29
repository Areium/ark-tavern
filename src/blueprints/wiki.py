"""
Wiki blueprint — 文档目录查询 + 摘要回填。
"""

from flask import Blueprint, jsonify, request

from shared.helpers import json_error


def register(app, managers):
    bp = Blueprint("wiki", __name__)
    wiki_manager = managers["wiki"]
    llm_backend = managers["llm_backend"]

    @bp.route("/api/wiki/catalog", methods=["GET"])
    def wiki_catalog():
        snapshot = wiki_manager.catalog_snapshot()
        catalog, by_category = snapshot
        return jsonify({
            "summary": wiki_manager.format_catalog_summary(snapshot=snapshot),
            "total_docs": len(catalog),
            "categories": {
                cat: ids
                for cat, ids in by_category.items()
            },
        })

    @bp.route("/api/wiki/query", methods=["GET"])
    def wiki_query():
        q = request.args.get("q", "").strip()
        if not q:
            return json_error("需要 q 参数")
        result = wiki_manager.query(q)
        return jsonify({"result": result})

    @bp.route("/api/wiki/refresh", methods=["POST"])
    def wiki_refresh():
        wiki_manager.refresh()
        catalog, _ = wiki_manager.catalog_snapshot()
        return jsonify({"message": "目录已刷新", "total": len(catalog)})

    @bp.route("/api/wiki/backfill-summaries", methods=["POST"])
    def wiki_backfill_summaries():
        data = request.json or {}
        dry_run = data.get("dry_run", False)
        llm, _ = llm_backend.get_llm()
        if not llm:
            return json_error("LLM 后端不可用", 503)
        result = wiki_manager.backfill_summaries(llm, dry_run=dry_run)
        return jsonify(result)

    app.register_blueprint(bp)
