"""Installed combat mode management (no package code runs in Flask)."""
import io
from functools import wraps

from flask import Blueprint, jsonify, request, send_file
from werkzeug.formparser import parse_form_data

from combat_mode_packages import ABI, MAX_PACKAGE_BYTES
from combat_mode_runs import CombatModeRuns, MAX_STATE_BYTES, RunConflict
from shared.helpers import json_error

BUILTINS = [
    {"id": "narrative", "name": "叙事战斗", "description": "通过剧情叙述处理冲突", "runtime": "builtin"},
    {"id": "tactical", "name": "回合战术", "description": "网格、卡牌与回合战术", "runtime": "builtin"},
    {"id": "sideview", "name": "横版动作", "description": "独立实时动作战斗", "runtime": "builtin"},
]


def register(app, managers):
    bp = Blueprint("combat_modes", __name__)
    packages = managers["combat_modes"]
    runs = CombatModeRuns(packages.root.parent.parent)

    def handled(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except FileNotFoundError:
                return json_error("战斗模式不存在", 404)
            except RunConflict as exc:
                return json_error(str(exc), 409)
            except (ValueError, OSError) as exc:
                return json_error(str(exc), 400)
        return wrapped

    @bp.get("/api/combat-modes")
    @handled
    def listing():
        result = packages.list()
        return jsonify({"abi": ABI,
                        "modes": [{**row, "enabled": True} for row in BUILTINS] +
                                 [{**row, "runtime": "browser"} for row in result["modes"]],
                        "errors": result["errors"]})

    @bp.post("/api/combat-modes/install")
    @handled
    def install():
        # Multipart overhead is bounded too; limit before Werkzeug parses it.
        _, _, files = parse_form_data(request.environ,
                                      max_content_length=MAX_PACKAGE_BYTES + 1024 * 1024,
                                      max_form_memory_size=64 * 1024)
        try:
            uploaded = files.get("file")
            if uploaded is None:
                return json_error("请选择 ZIP 模式包（file）")
            raw = uploaded.stream.read(MAX_PACKAGE_BYTES + 1)
            return jsonify(packages.install(raw)), 201
        finally:
            for uploaded in files.values():
                uploaded.close()

    @bp.put("/api/combat-modes/<identifier>/enabled")
    @handled
    def enabled(identifier):
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or type(data.get("enabled")) is not bool:
            return json_error("enabled 必须是布尔值")
        packages.set_enabled(identifier, data["enabled"])
        return jsonify({"id": identifier, "enabled": data["enabled"]})

    @bp.get("/api/combat-modes/<identifier>/export")
    @handled
    def export(identifier):
        package = packages.get(identifier, require_enabled=False)
        return send_file(io.BytesIO(package.archive()), mimetype="application/zip",
                         as_attachment=True,
                         download_name=f"{identifier}-{package.manifest['version']}.zip")

    @bp.delete("/api/combat-modes/<identifier>")
    @handled
    def uninstall(identifier):
        return jsonify(packages.uninstall(identifier))

    @bp.post("/api/combat-modes/<identifier>/practice")
    @handled
    def practice(identifier):
        return jsonify(runs.create(packages.get(identifier))), 201

    @bp.post("/api/combat-modes/<identifier>/compatibility")
    @handled
    def compatibility(identifier):
        from combat_mode_bindings import prepare_binding
        from combat_mode_packages import _json
        raw = request.stream.read(65537)
        if len(raw) > 65536:
            return json_error("Compatibility request exceeds size limit", 413)
        data = _json(raw)
        book_ids = data.get("worldbook_ids")
        if (not isinstance(book_ids, list) or len(book_ids) > 64
                or any(not isinstance(value, str) for value in book_ids)):
            return json_error("worldbook_ids 必须是世界书 ID 数组（最多 64 本）")
        package = packages.get(identifier)
        manager = managers.get("worldbook")
        try:
            for book_id in book_ids:
                book = manager.load(book_id) if manager else None
                if book is None or not book.enabled or book.is_reference:
                    raise ValueError(f"Worldbook {book_id} is not an enabled story book")
            prepared = prepare_binding(package, book_ids, packages.root.parent.parent)
        except ValueError as exc:
            return jsonify({"compatible": False, "errors": [str(exc)]})
        return jsonify({"compatible": True, "errors": [], **prepared.summary()})

    @bp.get("/api/combat-mode-runs")
    @handled
    def list_runs():
        return jsonify(runs.list())

    @bp.get("/api/combat-mode-runs/<run_id>")
    @handled
    def get_run(run_id):
        return jsonify(runs.get(run_id))

    @bp.put("/api/combat-mode-runs/<run_id>")
    @handled
    def save_run(run_id):
        # Read a bounded stream rather than trusting a potentially absent
        # Content-Length or changing global Flask upload limits.
        from combat_mode_packages import _json
        raw = request.stream.read(MAX_STATE_BYTES + 65537)
        if len(raw) > MAX_STATE_BYTES + 65536:
            return json_error("Snapshot request exceeds size limit", 413)
        data = _json(raw)
        if data.keys() - {"revision", "snapshot", "outcome"}:
            return json_error("Unknown run update fields")
        return jsonify(runs.update(run_id, data.get("revision"), data.get("snapshot"),
                                   data.get("outcome")))

    app.register_blueprint(bp)
