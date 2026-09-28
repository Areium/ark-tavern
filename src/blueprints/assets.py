"""
Assets blueprint — 静态资源服务。
"""

import json
from pathlib import Path
from urllib.parse import quote
from flask import Blueprint, jsonify, request, send_from_directory
from data_paths import CONTENT_ROOT, content_root
from content_scope import is_content_visible
from worldbook_content import book_directory, category_roots, content_candidates, enabled_book_ids


def _visible_category_path(cat, filename, *, project_root=None):
    """Validate a local file path; old manifest-owned files stay hidden."""
    from pathlib import Path

    base = Path(cat.directory).resolve()
    candidate = Path(cat.directory) / filename
    try:
        candidate.resolve().relative_to(base)
    except ValueError:
        return None
    if not is_content_visible(candidate, project_root=project_root):
        return None
    return candidate


def _book_category_key(cat, *, project_root):
    """Map an API category to its configured path inside a book's content tree."""
    try:
        relative = Path(cat.directory).absolute().relative_to(content_root(project_root).absolute())
    except ValueError:
        return None
    if not relative.parts or any(part in ("", ".", "..") for part in relative.parts):
        return None
    return relative.as_posix()


def _book_asset_path(cat, filename, *, project_root, book_id):
    """Return a safe path in one enabled book, including for files not yet made."""
    category_key = _book_category_key(cat, project_root=project_root)
    if category_key is None or book_id not in enabled_book_ids(project_root):
        return None
    relative = f"{category_key}/{filename}"
    if (not filename or "\\" in relative or ":" in relative or "\x00" in relative
            or any(part in ("", ".", "..") or part.rstrip(" .") != part
                   for part in relative.split("/"))):
        return None
    root = book_directory(book_id, project_root)
    if root.is_symlink() or root.resolve() != root.absolute():
        return None
    target = root
    for part in relative.split("/"):
        target /= part
        if target.is_symlink():
            return None
    return target if target.resolve().is_relative_to(root) else None

def register(app, managers):
    bp = Blueprint("assets", __name__)
    doc_mgr = managers["document"]

    @bp.route("/api/assets/images", methods=["GET"])
    def list_asset_images():
        return jsonify(_list_entity_images(doc_mgr, book_id=request.args.get("worldbook_id")))

    @bp.route("/api/assets/data-dir", methods=["GET"])
    def get_data_dir():
        return jsonify({"path": str(CONTENT_ROOT)})

    @bp.route("/api/assets/spine-variants", methods=["GET"])
    def spine_variants():
        """Expose optional content-pack animation mappings for visible actors only."""
        selected_book = request.args.get("worldbook_id")
        try:
            catalogs = content_candidates(
                "spine_variants.json",
                book_ids=[selected_book] if selected_book is not None else None,
                project_root=doc_mgr._root,
            )
        except ValueError:
            return jsonify({"variants": {}})
        if selected_book is None:
            local_catalog = content_root(doc_mgr._root) / "spine_variants.json"
            if local_catalog.is_file():
                catalogs.append((None, local_catalog))
        visible = {}
        for owner, catalog in catalogs:
            allowed = [selected_book] if selected_book is not None else None
            if (not catalog.is_file() or not is_content_visible(
                    catalog, project_root=doc_mgr._root, allowed_book_ids=allowed)):
                continue
            try:
                raw = json.loads(catalog.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(raw, dict):
                continue
            root = catalog.parent
            for name, variant in raw.items():
                if (name in visible or not isinstance(name, str) or not name
                        or Path(name).name != name or name in (".", "..")
                        or not isinstance(variant, str) or not variant
                        or any(part in ("", ".", "..") for part in variant.split("/"))
                        or "\\" in variant):
                    continue
                character = root / "characters" / name
                if (character.is_dir() and not character.is_symlink()
                        and is_content_visible(character, project_root=doc_mgr._root,
                                               allowed_book_ids=[owner] if owner else allowed)):
                    visible[name] = variant
        return jsonify({"variants": visible})

    @bp.route("/api/assets/<category>/<path:filename>", methods=["GET"])
    def serve_asset(category, filename):
        import os as _os
        cat = doc_mgr.get_category(category)
        if not cat:
            return jsonify({"error": f"未知类别: {category}"}), 404
        selected_book = request.args.get("worldbook_id")
        category_key = _book_category_key(cat, project_root=doc_mgr._root)
        if selected_book is not None and category_key is None:
            return jsonify({"error": "文件不存在"}), 404
        if category_key is not None:
            try:
                candidates = content_candidates(
                    f"{category_key}/{filename}",
                    book_ids=[selected_book] if selected_book is not None else None,
                    project_root=doc_mgr._root,
                )
            except ValueError:
                return jsonify({"error": "无效的文件路径"}), 404
            for _, path in candidates:
                if (path.is_file() and (selected_book is None or is_content_visible(
                        path, project_root=doc_mgr._root,
                        allowed_book_ids=[selected_book]))):
                    return send_from_directory(path.parent, path.name)
            if selected_book is not None:
                return jsonify({"error": "文件不存在"}), 404
        filepath = _visible_category_path(cat, filename, project_root=doc_mgr._root)
        if filepath is None or not filepath.is_file():
            return jsonify({"error": "文件不存在"}), 404
        directory = _os.path.dirname(filepath)
        basename = _os.path.basename(filepath)
        return send_from_directory(directory, basename)

    @bp.route("/api/assets/<category>/upload", methods=["POST"])
    def upload_asset(category):
        """上传图片到分类/实体目录。"""
        import os as _os

        cat = doc_mgr.get_category(category)
        if not cat:
            return jsonify({"error": f"未知类别: {category}"}), 404

        if "file" not in request.files:
            return jsonify({"error": "缺少上传文件"}), 400

        file = request.files["file"]
        if not file.filename:
            return jsonify({"error": "文件名为空"}), 400

        ext = _os.path.splitext(file.filename)[1].lower()
        if ext not in _IMAGE_EXTS:
            return jsonify({"error": f"不支持的文件格式: {ext}"}), 400

        subdir = request.form.get("subdir", "").strip()
        if ".." in subdir or subdir.startswith("/") or subdir.startswith("\\"):
            return jsonify({"error": "无效的子目录路径"}), 400

        if _os.path.basename(file.filename) != file.filename:
            return jsonify({"error": "无效的文件名"}), 400

        selected_book = (request.form.get("worldbook_id") if "worldbook_id" in request.form
                         else request.args.get("worldbook_id"))
        if selected_book is not None:
            filepath = _book_asset_path(
                cat, "/".join(part for part in (subdir, file.filename) if part),
                project_root=doc_mgr._root, book_id=selected_book)
            if filepath is None:
                return jsonify({"error": "目标路径不可用"}), 403
            target_dir = str(filepath.parent)
            category_dir = book_directory(selected_book, doc_mgr._root) / _book_category_key(cat, project_root=doc_mgr._root)
        else:
            target_dir = _os.path.join(cat.directory, subdir) if subdir else cat.directory
            category_dir = cat.directory
            if _visible_category_path(cat, _os.path.join(subdir, file.filename), project_root=doc_mgr._root) is None:
                return jsonify({"error": "目标路径不可用"}), 403
            filepath = Path(target_dir) / file.filename
        _os.makedirs(target_dir, exist_ok=True)
        if _os.path.exists(filepath):
            return jsonify({"error": f"文件已存在: {file.filename}"}), 409

        file.save(filepath)
        file_stat = _os.stat(filepath)
        entity_rel = _os.path.relpath(target_dir, category_dir).replace("\\", "/")
        path_key = f"{category}/{entity_rel}/{file.filename}" if entity_rel != "." else f"{category}/{file.filename}"

        return jsonify({
            "message": "上传成功",
            "name": file.filename,
            "path": path_key,
            "url": f"/api/assets/{quote(path_key, safe='/')}"
                   + (f"?worldbook_id={quote(selected_book)}" if selected_book else ""),
            "size": file_stat.st_size,
        }), 201

    @bp.route("/api/assets/<category>/<path:filename>", methods=["DELETE"])
    def delete_asset(category, filename):
        """删除指定图片资产。"""
        import os as _os

        cat = doc_mgr.get_category(category)
        if not cat:
            return jsonify({"error": f"未知类别: {category}"}), 404

        selected_book = request.args.get("worldbook_id")
        if selected_book is not None:
            filepath = _book_asset_path(cat, filename, project_root=doc_mgr._root,
                                        book_id=selected_book)
            if filepath is None:
                return jsonify({"error": "无效的文件路径"}), 403
            if not filepath.is_file():
                return jsonify({"error": "文件不存在"}), 404
            if filepath.suffix.lower() not in _IMAGE_EXTS:
                return jsonify({"error": "不允许删除非图片文件"}), 403
            filepath.unlink()
            return jsonify({"message": "已删除", "path": f"{category}/{filename}"})

        # 路径穿越防护
        filepath = _os.path.join(cat.directory, filename.replace("\\", "/"))
        real_base = _os.path.realpath(cat.directory)
        real_file = _os.path.realpath(filepath)
        if not real_file.startswith(real_base + _os.sep) and real_file != real_base:
            return jsonify({"error": "无效的文件路径"}), 403

        if not _os.path.isfile(filepath):
            return jsonify({"error": "文件不存在"}), 404
        if not is_content_visible(filepath, project_root=doc_mgr._root):
            return jsonify({"error": "文件不存在"}), 404

        ext = _os.path.splitext(filepath)[1].lower()
        if ext not in _IMAGE_EXTS:
            return jsonify({"error": "不允许删除非图片文件"}), 403

        _os.remove(filepath)
        return jsonify({"message": "已删除", "path": f"{category}/{filename}"})

    @bp.route("/api/assets/<category>/<path:entity>/default-image", methods=["GET"])
    def get_default_image(category, entity):
        """读取实体的默认头像/立绘设置。"""
        import os as _os
        import frontmatter as _fm

        cat = doc_mgr.get_category(category)
        if not cat:
            return jsonify({"error": f"未知类别: {category}"}), 404

        selected_book = request.args.get("worldbook_id")
        if selected_book is not None:
            index_md = _book_asset_path(cat, f"{entity}/index.md",
                                        project_root=doc_mgr._root, book_id=selected_book)
        else:
            index_md = _visible_category_path(cat, _os.path.join(entity, "index.md"),
                                              project_root=doc_mgr._root)
        if index_md is None or not index_md.is_file():
            return jsonify({"error": "实体不存在"}), 404

        try:
            with open(index_md, "r", encoding="utf-8") as f:
                meta = _fm.load(f).metadata
            crop = None
            keys = ("card_face_crop_x", "card_face_crop_y", "card_face_crop_w", "card_face_crop_h")
            if all(k in meta for k in keys):
                try:
                    crop = {
                        "x": float(meta["card_face_crop_x"]),
                        "y": float(meta["card_face_crop_y"]),
                        "w": float(meta["card_face_crop_w"]),
                        "h": float(meta["card_face_crop_h"]),
                    }
                except (ValueError, TypeError):
                    crop = None
            return jsonify({
                "default_avatar": meta.get("default_avatar", ""),
                "default_skin": meta.get("default_skin", ""),
                "card_face": meta.get("card_face", ""),
                "card_face_crop": crop,
            })
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @bp.route("/api/assets/<category>/<path:entity>/default-image", methods=["PUT"])
    def set_default_image(category, entity):
        """设置实体的默认头像/立绘。写入 index.md frontmatter。"""
        import os as _os
        import frontmatter as _fm

        cat = doc_mgr.get_category(category)
        if not cat:
            return jsonify({"error": f"未知类别: {category}"}), 404

        selected_book = request.args.get("worldbook_id")
        if selected_book is not None:
            index_md = _book_asset_path(cat, f"{entity}/index.md",
                                        project_root=doc_mgr._root, book_id=selected_book)
        else:
            index_md = _visible_category_path(cat, _os.path.join(entity, "index.md"),
                                              project_root=doc_mgr._root)
        if index_md is None or not index_md.is_file():
            return jsonify({"error": "实体不存在"}), 404

        data = request.json or {}
        img_type = data.get("type", "").strip()
        filename = data.get("filename", "").strip()

        if selected_book is not None and filename and (
                Path(filename).name != filename or "\\" in filename
                or filename in (".", "..") or ":" in filename):
            return jsonify({"error": "无效的文件名"}), 400

        if img_type not in ("avatar", "skin", "card_face"):
            return jsonify({"error": "type 必须为 'avatar'、'skin' 或 'card_face'"}), 400

        if img_type == "card_face":
            field = "card_face"
        else:
            field = f"default_{img_type}"

        # card_face: 将文件复制到 card_face/ 目录（如果不在其中）
        if img_type == "card_face":
            import shutil as _shutil
            entity_dir = _os.path.dirname(index_md)
            card_face_dir = _os.path.join(entity_dir, "card_face")
            dest = _os.path.join(card_face_dir, filename)
            if selected_book is not None and filename and _book_asset_path(
                    cat, f"{entity}/card_face/{filename}",
                    project_root=doc_mgr._root, book_id=selected_book) is None:
                return jsonify({"error": "目标路径不可用"}), 403
            src_path = None
            for sub in ("avatar", "skin"):
                candidate = _os.path.join(entity_dir, sub, filename)
                if _os.path.isfile(candidate) and (selected_book is None or _book_asset_path(
                        cat, f"{entity}/{sub}/{filename}",
                        project_root=doc_mgr._root, book_id=selected_book) is not None):
                    src_path = candidate
                    break
            if not src_path:
                candidate = _os.path.join(entity_dir, filename)
                if _os.path.isfile(candidate) and (selected_book is None or _book_asset_path(
                        cat, f"{entity}/{filename}",
                        project_root=doc_mgr._root, book_id=selected_book) is not None):
                    src_path = candidate
            if src_path and src_path != dest:
                _os.makedirs(card_face_dir, exist_ok=True)
                _shutil.copy2(src_path, dest)

        try:
            with open(index_md, "r", encoding="utf-8") as f:
                post = _fm.load(f)
            post.metadata[field] = filename

            # card_face 可附带裁剪参数
            if img_type == "card_face":
                crop = data.get("crop")
                if crop and isinstance(crop, dict):
                    post.metadata["card_face_crop_x"] = crop.get("x", 0)
                    post.metadata["card_face_crop_y"] = crop.get("y", 0)
                    post.metadata["card_face_crop_w"] = crop.get("w", 100)
                    post.metadata["card_face_crop_h"] = crop.get("h", 100)
                elif "crop" in data and data["crop"] is None:
                    # 仅当明确传入 crop=null 时清除裁剪
                    for k in ("card_face_crop_x", "card_face_crop_y", "card_face_crop_w", "card_face_crop_h"):
                        post.metadata.pop(k, None)

            with open(index_md, "w", encoding="utf-8") as f:
                f.write(_fm.dumps(post))
            return jsonify({"message": "已更新", "field": field, "filename": filename})
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    app.register_blueprint(bp)


_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}


def _list_entity_images(doc_mgr, *, book_id=None):
    """递归扫描所有实体文件夹及其子目录下的图片文件。

    每个实体附带上级目录（`category/entity`）与实际书文件夹 ID。
    """
    import os
    import frontmatter

    categories = doc_mgr.list_categories()
    result = []

    for cat_meta in categories:
        cat_id = cat_meta["id"]
        cat = doc_mgr.get_category(cat_id)
        if not cat:
            continue
        category_key = _book_category_key(cat, project_root=doc_mgr._root)
        if category_key is None:
            continue
        try:
            roots = category_roots(
                category_key, book_ids=[book_id] if book_id is not None else None,
                project_root=doc_mgr._root)
        except ValueError:
            continue
        if book_id is None:
            local_root = Path(cat.directory)
            if local_root.is_dir():
                roots.append((None, local_root))
        book_paths = set()
        for owner, cat_dir in roots:
            allowed = [owner] if owner else ([book_id] if book_id is not None else None)

            def visible(path):
                return (not Path(path).is_symlink() and is_content_visible(
                    path, project_root=doc_mgr._root, allowed_book_ids=allowed))

            # Collect entity folders with a visible index.md, including nested entities.
            entity_dirs = []
            for root, dirs, _files in os.walk(cat_dir):
                dirs[:] = [d for d in dirs if not d.startswith(".") and visible(Path(root) / d)]
                index_md = Path(root) / "index.md"
                if index_md.is_file() and visible(index_md):
                    entity_name = Path(root).name
                    source_book = owner or ""
                    try:
                        with index_md.open("r", encoding="utf-8") as fh:
                            meta = frontmatter.load(fh).metadata
                        entity_name = meta.get("name", entity_name)
                    except (OSError, ValueError):
                        pass
                    entity_dirs.append((Path(root), entity_name, source_book))

            for entity_root, entity_name, source_book in entity_dirs:
                images = []
                entity_rel = entity_root.relative_to(cat_dir).as_posix()
                for walk_root, walk_dirs, walk_files in os.walk(entity_root):
                    walk_dirs[:] = [d for d in walk_dirs if not d.startswith(".") and d != "spine"
                                    and visible(Path(walk_root) / d)]
                    for name in sorted(walk_files):
                        if Path(name).suffix.lower() not in _IMAGE_EXTS:
                            continue
                        filepath = Path(walk_root) / name
                        if not visible(filepath):
                            continue
                        try:
                            size = filepath.stat().st_size
                        except OSError:
                            continue
                        inner_rel = Path(walk_root).relative_to(entity_root).as_posix()
                        parts = [cat_id, entity_rel]
                        if inner_rel != ".":
                            parts.append(inner_rel)
                        parts.append(name)
                        path_key = "/".join(parts)
                        if owner is None and book_id is None and path_key in book_paths:
                            continue
                        url = f"/api/assets/{quote(path_key, safe='/')}"
                        if owner or book_id is not None:
                            url += f"?worldbook_id={quote(owner or book_id, safe='')}"
                        if owner is not None:
                            book_paths.add(path_key)
                        images.append({
                            "name": name,
                            "path": path_key,
                            "url": url,
                            "size": size,
                            "subdir": inner_rel if inner_rel != "." else "",
                            "parent_dir": f"{cat_id}/{entity_rel}",
                        })
                if images:
                    result.append({
                        "category": cat_id,
                        "entity": entity_rel,
                        "entity_name": entity_name,
                        "parent_dir": f"{cat_id}/{entity_rel}",
                        "worldbook_id": source_book,
                        "images": images,
                    })

    return result
