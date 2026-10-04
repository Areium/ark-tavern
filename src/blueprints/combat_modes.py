"""Installed combat mode management (no package code runs in Flask)."""
import io
from functools import wraps

from flask import Blueprint, jsonify, request, send_file
from werkzeug.formparser import parse_form_data

from combat_mode_packages import ABI, MAX_PACKAGE_BYTES
from shared.helpers import json_error

BUILTINS = [
    {"id": "narrative", "name": "叙事战斗", "description": "通过剧情叙述处理冲突", "runtime": "builtin"},
    {"id": "tactical", "name": "回合战术", "description": "网格、卡牌与回合战术", "runtime": "builtin"},
    {"id": "sideview", "name": "横版动作", "description": "独立实时动作战斗", "runtime": "builtin"},
]


def register(app, managers):
    bp = Blueprint("combat_modes", __name__)
    packages = managers["combat_modes"]

    def handled(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except FileNotFoundError:
                return json_error("战斗模式不存在", 404)
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

    app.register_blueprint(bp)
