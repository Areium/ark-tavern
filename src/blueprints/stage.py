"""
Stage blueprint — 对话舞台（视觉小说视图）+ 角色数值 + 插件数据接口。

这组接口是「场景面板插件」与系统数据交互的正式边界（docs/design/session-scene-plugins.md）：

- `GET  /api/sessions/<id>/stage`                      舞台数据：背景图 / 场景角色立绘 / 环境
- `GET  /api/characters/<name>/stats`                  角色全局数值（frontmatter `stats` + 所属书字段）
- `PUT  /api/characters/<name>/stats`                  写角色全局数值
- `GET  /api/sessions/<id>/character-stats`            阵容全部角色的合并数值（默认 → 全局 → 会话）
- `PUT  /api/sessions/<id>/character-stats/<name>`     写会话数值（合并 / 替换）
- `DELETE /api/sessions/<id>/character-stats/<name>`   清空会话数值，回到全局值
- `GET  /api/sessions/<id>/plugin-data`                全部插件命名空间
- `GET/PUT/DELETE /api/sessions/<id>/plugin-data/<ns>` 单个命名空间的 JSON 数据
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from urllib.parse import quote

from flask import Blueprint, jsonify, request, send_from_directory
from worldbook_content import content_candidates

from shared.helpers import json_error
from story_rules import narration_guard
from document_manager import DocumentNotFoundError
from character_stats import (
    merge_character_stats, read_global_stats_from_meta, sanitize_values,
)
from session_stats import (
    read_character_stats_metadata, resolve_book_stat_fields, resolve_session_character_stats,
)

logger = logging.getLogger(__name__)

_NAMESPACE_RE = re.compile(r"^[a-z][a-z0-9_\-]{0,39}$")
_MAX_PLUGIN_BYTES = 64 * 1024


def _story_artwork(plot_id: str, book_ids: list[str] | None = None) -> list[dict]:
    """Curated art is opt-in per plot; image paths stay inside that plot's art folder."""
    if plot_id != "beyond_twin":
        return []
    try:
        sources = content_candidates(f"plots/{plot_id}/art/index.json", book_ids=book_ids)
    except ValueError:
        return []
    if not sources:
        return []
    owner, catalog = sources[0]
    art_dir = catalog.parent
    try:
        entries = json.loads(catalog.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(entries, list):
        return []
    result = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        filename = entry.get("image")
        if not isinstance(filename, str) or Path(filename).name != filename or not filename.lower().endswith((".png", ".jpg", ".webp")):
            continue
        image = art_dir / filename
        if not image.is_file():
            continue
        result.append({
            "id": str(entry.get("id") or filename),
            "act": str(entry.get("act") or ""),
            "title": str(entry.get("title") or ""),
            "caption": str(entry.get("caption") or ""),
            "url": (f"/api/assets/plots/{plot_id}/art/{quote(filename)}"
                    + (f"?worldbook_id={quote(owner)}" if owner else "")),
        })
    return result


def _skin_exists(name: str, book_ids: list[str] | None = None) -> bool:
    from avatar_color import find_skin_path
    return bool(find_skin_path(name, book_ids=book_ids))


def _avatar_exists(name: str, book_ids: list[str] | None = None) -> bool:
    from avatar_color import find_avatar_path
    return bool(find_avatar_path(name, book_ids=book_ids))


def register(app, managers):
    session_mgr = managers["session"]
    doc_mgr = managers["document"]
    wb_mgr = managers["worldbook"]

    bp = Blueprint("stage", __name__)

    @bp.route("/api/worldbooks/<book_id>/presentation-image", methods=["GET"])
    def presentation_preview(book_id):
        from scene_media import valid_scene_asset
        asset = request.args.get("asset")
        if not valid_scene_asset(asset):
            return json_error("图片资源路径无效", 404)
        try:
            sources = content_candidates(asset, book_ids=[book_id], project_root=doc_mgr._root)
        except ValueError:
            return json_error("图片资源路径无效", 404)
        if not sources or not sources[0][1].is_file():
            return json_error("本书图片不存在", 404)
        image = sources[0][1]
        return send_from_directory(image.parent, image.name)

    @bp.route("/api/sessions/<session_id>/presentation-assets/<filename>", methods=["GET"])
    def presentation_asset(session_id, filename):
        session = session_mgr.get_session(session_id)
        if session is None:
            return json_error("会话不存在", 404)
        if not re.fullmatch(r"[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif|bmp)", filename):
            return json_error("演出资源路径无效", 404)
        folder = Path(session.data_dir) / "presentation-assets"
        target = folder / filename
        if folder.is_symlink() or target.is_symlink() or not target.is_file():
            return json_error("演出资源不存在", 404)
        return send_from_directory(folder, filename)

    # ── 共用：字段解析 ──

    def _book_fields(book_id: str | None) -> tuple[list[dict], str]:
        return resolve_book_stat_fields(wb_mgr, book_id)

    def _character_meta(name: str, *, book_id: str | None = None,
                        book_ids: list[str] | None = None) -> dict | None:
        return read_character_stats_metadata(name, doc_mgr, book_id=book_id, book_ids=book_ids)

    # ── 舞台 ──

    @bp.route("/api/sessions/<session_id>/stage", methods=["GET"])
    def session_stage(session_id: str):
        """对话舞台所需的一切：背景、场景角色立绘、环境。

        背景解析与战斗共用同一条链（会话覆盖 > 地点 `combat_bg` > default），
        没有任何图片时 `background.url` 为 null，前端按时段/天气生成渐变背景。
        """
        session = session_mgr.get_session(session_id)
        if not session:
            return json_error("会话不存在", 404)
        from scene_media import presentation_frame
        from avatar_color import get_theme_color

        book_ids = session.overlay.get_worldbook_ids()
        session_dir = Path(session.data_dir)
        requested_round = request.args.get("round", type=int)
        try:
            frame = presentation_frame(session, requested_round)
        except ValueError as exc:
            return json_error(str(exc), 409)
        background = frame["background"]
        env = frame["environment"]
        location = env["location"]

        def media(name: str, kind: str) -> str:
            return f"/api/characters/{quote(name)}/{kind}?session_id={session_id}"

        from session_resources import find_session_media_path
        player = session.player_identity or "玩家"
        def has_media(name: str, kind: str) -> bool:
            if find_session_media_path(session_dir, name, kind):
                return True
            if wb_mgr.character_media_for_session(session.overlay, name, kind):
                return True
            return (_skin_exists(name, book_ids) if kind == "skin"
                    else _avatar_exists(name, book_ids))

        characters = []
        for name in session.scene_manager.get_scene_characters():
            if name == player:
                continue
            has_skin = has_media(name, "skin")
            has_avatar = has_media(name, "avatar")
            characters.append({
                "name": name,
                "skin_url": media(name, "skin") if has_skin else None,
                "avatar_url": media(name, "avatar") if has_avatar else None,
                "color": get_theme_color(name, book_ids=book_ids),
                "active": session.scene_manager.active == name,
            })
        player_has_skin = has_media(player, "skin")
        player_has_avatar = has_media(player, "avatar")
        return jsonify({
            "session_id": session_id,
            "location": location,
            "weather": env["weather"],
            "time": env["time"],
            "atmosphere": env["atmosphere"],
            "background": background,
            "scene_media": frame["scene_media"],
            "artwork": _story_artwork(getattr(session.overlay, "get_plot_id", lambda: None)() or "", book_ids),
            "characters": characters,
            "player": {
                "name": player,
                "skin_url": media(player, "skin") if player_has_skin else None,
                "avatar_url": media(player, "avatar") if player_has_avatar else None,
                "color": get_theme_color(player, book_ids=book_ids),
            },
        })

    # ── 角色全局数值 ──

    @bp.route("/api/characters/<path:name>/stats", methods=["GET"])
    def character_stats_get(name: str):
        meta = _character_meta(name, book_id=request.args.get("worldbook_id"))
        if meta is None:
            return json_error(f"角色不存在: {name}", 404)
        book_id = str(meta.get("worldbook_id") or "")
        fields, book_name = _book_fields(book_id)
        global_values = read_global_stats_from_meta(meta)
        values, sources = merge_character_stats(fields, global_values, None)
        return jsonify({
            "name": name,
            "worldbook_id": book_id,
            "worldbook_name": book_name,
            "fields": fields,
            "values": values,
            "sources": sources,
            "stored": sanitize_values(fields, global_values),
        })

    @bp.route("/api/characters/<path:name>/stats", methods=["PUT"])
    def character_stats_put(name: str):
        """写角色全局数值到 index.md frontmatter 的 `stats`。

        body: {"values": {key: value | null}, "replace": bool}
        `null` 删键；replace=true 时整份替换。字段内的值按类型校验，字段外自由填写。
        """
        try:
            selected_book = request.args.get("worldbook_id")
            doc = doc_mgr.read_document("characters", name, book_id=selected_book)
        except (DocumentNotFoundError, ValueError):
            return json_error(f"角色不存在: {name}", 404)
        meta = dict(doc.get("metadata") or {})
        data = request.json or {}
        book_id = str((_character_meta(name, book_id=selected_book) or {}).get("worldbook_id") or "")
        fields, _ = _book_fields(book_id)
        try:
            incoming = sanitize_values(fields, data.get("values"), strict=True)
        except ValueError as e:
            return json_error(str(e), 400)
        current = {} if data.get("replace") else read_global_stats_from_meta(meta)
        for key, value in incoming.items():
            if value is None:
                current.pop(key, None)
            else:
                current[key] = value
        if current:
            meta["stats"] = current
        else:
            meta.pop("stats", None)
        try:
            doc_mgr.save_document("characters", name, doc.get("content") or "", metadata=meta,
                                  book_id=selected_book)
        except Exception as e:
            return json_error(f"保存失败: {e}", 500)
        # 角色目录改了 frontmatter，实体索引 / 头像色等缓存要失效
        try:
            from shared.cache import invalidate_all_caches
            import index_manager as idxmgr
            invalidate_all_caches(idxmgr, managers.get("wiki"))
        except Exception:
            pass
        values, sources = merge_character_stats(fields, current, None)
        return jsonify({"name": name, "fields": fields, "values": values,
                        "sources": sources, "stored": current})

    # ── 会话数值 ──

    def _session_stats_payload(session, names: list[str]) -> dict:
        out = []
        for name in names:
            stats = resolve_session_character_stats(
                session, name, document_manager=doc_mgr, worldbook_manager=wb_mgr)
            out.append({
                **stats,
                "is_player": name == (session.player_identity or "玩家"),
            })
        return {"session_id": session.id, "characters": out}

    @bp.route("/api/sessions/<session_id>/character-stats", methods=["GET"])
    def session_character_stats(session_id: str):
        session = session_mgr.get_session(session_id)
        if not session:
            return json_error("会话不存在", 404)
        names = list(session.scene_manager.get_roster())
        # 会话里写过但已离队的角色也列出来，免得数据「消失」
        for extra in session.overlay.get_all_character_stats():
            if extra not in names:
                names.append(extra)
        return jsonify(_session_stats_payload(session, names))

    @bp.route("/api/sessions/<session_id>/character-stats/<path:name>", methods=["PUT"])
    @narration_guard(session_mgr)
    def session_character_stats_put(session_id: str, name: str):
        session = session_mgr.get_session(session_id)
        if not session:
            return json_error("会话不存在", 404)
        from session_resources import is_safe_entity_name
        if not is_safe_entity_name(name):
            return json_error("非法的角色名", 400)
        data = request.json or {}
        fields = resolve_session_character_stats(
            session, name, document_manager=doc_mgr, worldbook_manager=wb_mgr)["fields"]
        try:
            incoming = sanitize_values(fields, data.get("values"), strict=True)
        except ValueError as e:
            return json_error(str(e), 400)
        session.overlay.set_character_stats(name, incoming, replace=bool(data.get("replace")))
        payload = _session_stats_payload(session, [name])
        return jsonify(payload["characters"][0])

    @bp.route("/api/sessions/<session_id>/character-stats/<path:name>", methods=["DELETE"])
    @narration_guard(session_mgr)
    def session_character_stats_delete(session_id: str, name: str):
        session = session_mgr.get_session(session_id)
        if not session:
            return json_error("会话不存在", 404)
        session.overlay.delete_character_stats(name)
        payload = _session_stats_payload(session, [name])
        return jsonify(payload["characters"][0])

    # ── 插件数据 ──

    @bp.route("/api/sessions/<session_id>/plugin-data", methods=["GET"])
    def plugin_data_list(session_id: str):
        session = session_mgr.get_session(session_id)
        if not session:
            return json_error("会话不存在", 404)
        return jsonify({"session_id": session_id, "namespaces": session.overlay.list_plugin_data()})

    @bp.route("/api/sessions/<session_id>/plugin-data/<namespace>", methods=["GET"])
    def plugin_data_get(session_id: str, namespace: str):
        session = session_mgr.get_session(session_id)
        if not session:
            return json_error("会话不存在", 404)
        if not _NAMESPACE_RE.match(namespace):
            return json_error("命名空间只能是小写字母开头的 1–40 位 [a-z0-9_-]", 400)
        slot = session.overlay.get_plugin_data(namespace) or {"data": {}, "updated_at": None}
        return jsonify({"session_id": session_id, "namespace": namespace, **slot})

    @bp.route("/api/sessions/<session_id>/plugin-data/<namespace>", methods=["PUT"])
    def plugin_data_put(session_id: str, namespace: str):
        """body: {"data": {...}, "replace": bool}。默认顶层合并（`null` 删键）。"""
        session = session_mgr.get_session(session_id)
        if not session:
            return json_error("会话不存在", 404)
        if not _NAMESPACE_RE.match(namespace):
            return json_error("命名空间只能是小写字母开头的 1–40 位 [a-z0-9_-]", 400)
        body = request.json
        if not isinstance(body, dict):
            return json_error("请求体必须是 JSON 对象", 400)
        data = body.get("data")
        if not isinstance(data, dict):
            return json_error("data 必须是 JSON 对象", 400)
        try:
            size = len(json.dumps(data, ensure_ascii=False).encode("utf-8"))
        except (TypeError, ValueError):
            return json_error("data 必须可序列化为 JSON", 400)
        if size > _MAX_PLUGIN_BYTES:
            return json_error(f"单个命名空间的数据不能超过 {_MAX_PLUGIN_BYTES // 1024} KB", 413)
        slot = session.overlay.set_plugin_data(namespace, data, replace=bool(body.get("replace")))
        return jsonify({"session_id": session_id, "namespace": namespace, **slot})

    @bp.route("/api/sessions/<session_id>/plugin-data/<namespace>", methods=["DELETE"])
    def plugin_data_delete(session_id: str, namespace: str):
        session = session_mgr.get_session(session_id)
        if not session:
            return json_error("会话不存在", 404)
        removed = session.overlay.delete_plugin_data(namespace)
        return jsonify({"session_id": session_id, "namespace": namespace, "removed": removed})

    app.register_blueprint(bp)
