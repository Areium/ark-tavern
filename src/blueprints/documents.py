"""
Documents blueprint — 文档 CRUD、搜索、导入依赖管理、实体列表。
"""

import os
import logging
from pathlib import Path

import yaml
from flask import Blueprint, jsonify, request
from data_paths import categories_path

from shared.helpers import json_error
from shared.cache import invalidate_all_caches
from document_manager import ConflictError, DocumentNotFoundError
import index_manager as idxmgr

logger = logging.getLogger(__name__)

# Project root from inside blueprints/ is two levels up → src/
_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_REPO_ROOT = Path(_project_root).parent  # repo root for data/ access

# ── 辅助函数 ──


def _load_hierarchy():
    """加载 categories.yaml 的层级结构，返回按 level 排序的列表。"""
    yaml_path = categories_path(_REPO_ROOT)
    if not yaml_path.is_file():
        logger.warning("categories.yaml not found: %s", yaml_path)
        return []

    try:
        with open(yaml_path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        levels = data.get("hierarchy", {}).get("levels", [])
        levels.sort(key=lambda x: x.get("level", 99))
        return levels
    except Exception as e:
        logger.error("Failed to load hierarchy: %s", e)
        return []


def _load_all_entities(doc_mgr):
    """Use document visibility rules for the live bookshelf entity directory."""
    result = {}
    for category in doc_mgr.list_categories():
        cat_id = category["id"]
        docs = doc_mgr.list_documents(cat_id, include_content=True,
                                      include_duplicates=True)
        if docs:
            result[cat_id] = [{
                "id": doc["id"],
                "name": doc["name"],
                "summary": doc["summary"],
                "worldbook_id": doc["worldbook_id"],
            } for doc in docs]
    return result


# ── Blueprint 注册 ──


def register(app, managers):
    bp = Blueprint("documents", __name__)
    doc_mgr = managers["document"]
    wiki_manager = managers["wiki"]

    # ── 1. GET /tree ──
    @bp.route("/api/documents/tree", methods=["GET"])
    def doc_tree():
        """返回所有类别及其文档树结构。"""
        return jsonify(doc_mgr.list_all_documents())

    # ── 2. GET /categories ──
    @bp.route("/api/documents/categories", methods=["GET"])
    def doc_categories():
        """返回文档类别列表 + 层级信息。"""
        return jsonify({
            "categories": doc_mgr.list_categories(),
            "hierarchy": doc_mgr.get_hierarchy(),
        })

    # ── 3. GET /<category> ──
    @bp.route("/api/documents/<category>", methods=["GET"])
    def list_docs(category: str):
        """列出指定类别下的所有文档。"""
        try:
            docs = doc_mgr.list_documents(
                category, include_content=True,
                book_id=request.args.get("worldbook_id"),
                include_duplicates=request.args.get("include_duplicates") == "1",
            )
        except ValueError as e:
            return json_error(str(e), 400)
        return jsonify(docs)

    # ── 4. GET /<category>/<doc_id> ──
    @bp.route("/api/documents/<category>/<path:doc_id>", methods=["GET"])
    def get_doc(category: str, doc_id: str):
        """读取单个文档（包含内容和元数据）。"""
        try:
            doc = doc_mgr.read_document(
                category, doc_id, book_id=request.args.get("worldbook_id"))
        except DocumentNotFoundError:
            return json_error(f"文档不存在: {category}/{doc_id}", 404)
        except ValueError as e:
            return json_error(str(e), 400)
        return jsonify({
            "content": doc["content"],
            "metadata": doc["metadata"],
            "hash": doc["hash"],
        })

    # ── 5. PUT /<category>/<doc_id> ──
    @bp.route("/api/documents/<category>/<path:doc_id>", methods=["PUT"])
    def save_doc(category: str, doc_id: str):
        """保存文档内容，可选重命名。处理冲突检测。"""
        data = request.json or {}
        content = data.get("content", "")
        new_id = data.get("new_id", "").strip()
        expected_hash = data.get("hash") or data.get("expected_hash") or ""
        book_id = data.get("worldbook_id", request.args.get("worldbook_id"))

        try:
            result = doc_mgr.save_document(
                category, doc_id, content,
                expected_hash=expected_hash or None,
                book_id=book_id,
            )
        except ConflictError:
            return json_error(
                "保存冲突：文件已被其他进程修改。请刷新后重试。",
                409,
            )
        except DocumentNotFoundError:
            return json_error(f"文档不存在: {category}/{doc_id}", 404)
        except ValueError as e:
            return json_error(str(e), 400)

        # 重命名（如果提供了 new_id 且不同）
        if new_id and new_id != doc_id:
            try:
                move_result = doc_mgr.move_document(
                    category, doc_id, new_id, book_id=book_id)
                result.update(move_result)
            except Exception as e:
                logger.warning("重命名失败 %s -> %s: %s", doc_id, new_id, e)

        # 失效缓存
        try:
            invalidate_all_caches(idxmgr, wiki_manager)
        except Exception:
            pass

        return jsonify(result)

    # ── 6. POST /<category> ──
    @bp.route("/api/documents/<category>", methods=["POST"])
    def create_doc(category: str):
        """创建新文档。"""
        data = request.json or {}
        doc_id = data.get("id", "").strip()
        content = data.get("content", "")

        if not doc_id:
            return json_error("需要 id 参数")

        try:
            result = doc_mgr.create_document(
                category, doc_id, content=content,
                book_id=data.get("worldbook_id", request.args.get("worldbook_id")))
        except FileExistsError:
            return json_error(f"文档已存在: {doc_id}", 409)
        except ValueError as e:
            return json_error(str(e), 400)

        try:
            invalidate_all_caches(idxmgr, wiki_manager)
        except Exception:
            pass

        return jsonify(result), 201

    # ── 7. DELETE /<category>/<doc_id> ──
    @bp.route("/api/documents/<category>/<path:doc_id>", methods=["DELETE"])
    def delete_doc(category: str, doc_id: str):
        """删除文档。"""
        try:
            doc_mgr.delete_document(
                category, doc_id, book_id=request.args.get("worldbook_id"))
        except DocumentNotFoundError:
            return json_error(f"文档不存在: {category}/{doc_id}", 404)
        except ValueError as e:
            return json_error(str(e), 400)

        try:
            invalidate_all_caches(idxmgr, wiki_manager)
        except Exception:
            pass

        return jsonify({"message": "文档已删除"})

    # ── 8. POST /<category>/folders ──
    @bp.route("/api/documents/<category>/folders", methods=["POST"])
    def create_folder(category: str):
        """在指定类别中创建子文件夹。"""
        data = request.json or {}
        path = data.get("path", "").strip()
        if not path:
            return json_error("需要 path 参数")
        try:
            result = doc_mgr.create_folder(
                category, path,
                book_id=data.get("worldbook_id", request.args.get("worldbook_id")))
        except (FileExistsError, ValueError) as e:
            return json_error(str(e), 409)
        return jsonify(result), 201

    # ── 9. DELETE /<category>/folders/<path> ──
    @bp.route("/api/documents/<category>/folders/<path:path>", methods=["DELETE"])
    def delete_folder(category: str, path: str):
        """删除空文件夹。"""
        try:
            result = doc_mgr.delete_folder(
                category, path, book_id=request.args.get("worldbook_id"))
        except (DocumentNotFoundError, ValueError) as e:
            return json_error(str(e), 400)
        return jsonify(result)

    # ── 10. POST /<category>/<doc_id>/move ──
    @bp.route("/api/documents/<category>/<path:doc_id>/move", methods=["POST"])
    def move_doc(category: str, doc_id: str):
        """移动/重命名文档。"""
        data = request.json or {}
        new_path = data.get("new_path", "").strip()
        if not new_path:
            return json_error("需要 new_path 参数")
        try:
            result = doc_mgr.move_document(
                category, doc_id, new_path,
                book_id=data.get("worldbook_id", request.args.get("worldbook_id")))
        except (DocumentNotFoundError, FileExistsError, ValueError) as e:
            code = 404 if isinstance(e, DocumentNotFoundError) else 409
            return json_error(str(e), code)
        return jsonify(result)

    # ── 11. POST /<category>/folders/<path>/move ──
    @bp.route("/api/documents/<category>/folders/<path:path>/move", methods=["POST"])
    def move_folder(category: str, path: str):
        """移动/重命名文件夹。"""
        data = request.json or {}
        new_path = data.get("new_path", "").strip()
        if not new_path:
            return json_error("需要 new_path 参数")
        try:
            result = doc_mgr.move_folder(
                category, path, new_path,
                book_id=data.get("worldbook_id", request.args.get("worldbook_id")))
        except (DocumentNotFoundError, FileExistsError, ValueError) as e:
            code = 404 if isinstance(e, DocumentNotFoundError) else 409
            return json_error(str(e), code)
        return jsonify(result)

    # ── 12. GET /search ──
    @bp.route("/api/documents/search", methods=["GET"])
    def search_docs():
        """搜索文档（按名称、摘要模糊匹配，支持可选分类过滤）。"""
        q = request.args.get("q", "").strip()
        filter_category = request.args.get("category", "").strip()
        exclude_doc_id = request.args.get("exclude_doc_id", "").strip()

        # 确定要搜索的类别列表
        if filter_category:
            search_categories = [filter_category]
        else:
            # 使用层级结构确定所有相关类别
            levels = _load_hierarchy()
            search_categories = []
            level_map = {}  # category -> level
            for level in levels:
                for c in level.get("categories", []):
                    search_categories.append(c)
                    level_map[c] = level["level"]
            # 如果没有层级配置，回退到所有类别
            if not search_categories:
                search_categories = [c["id"] for c in doc_mgr.list_categories()]

        results = []

        for cat in search_categories:
            try:
                docs = doc_mgr.list_documents(cat, include_content=True)
            except (ValueError, Exception):
                continue

            for doc in docs:
                doc_id = doc.get("id", "")
                title = doc.get("title", "")
                summary = doc.get("summary", "")

                # 排除当前编辑的文档自身
                if exclude_doc_id and doc_id == exclude_doc_id and cat == filter_category:
                    continue

                # 模糊匹配：标题、摘要、文档ID、完整路径
                if q:
                    q_lower = q.lower()
                    doc_path = f"{cat}/{doc_id}".lower()
                    if (q_lower not in title.lower()
                        and q_lower not in summary.lower()
                        and q_lower not in doc_id.lower()
                        and not doc_path.startswith(q_lower)
                        and q_lower not in doc_path):
                        continue

                cat_level = level_map.get(cat, 99) if not filter_category else 99

                results.append({
                    "category": cat,
                    "id": doc_id,
                    "path": f"{cat}/{doc_id}",
                    "title": title,
                    "summary": summary,
                    "level": cat_level,
                    "hash": doc.get("hash", ""),
                    "mtime": doc.get("mtime", 0),
                })

        results.sort(key=lambda r: r["title"].lower())
        return jsonify({"results": results, "total": len(results)})

    # ── 13. GET /<category>/<doc_id>/imports ──
    @bp.route("/api/documents/<category>/<path:doc_id>/imports", methods=["GET"])
    def get_doc_imports(category: str, doc_id: str):
        """读取文档的 imports（含显示名称）。"""
        try:
            doc = doc_mgr.read_document(
                category, doc_id, book_id=request.args.get("worldbook_id"))
        except DocumentNotFoundError:
            return json_error(f"文档不存在: {category}/{doc_id}", 404)
        except ValueError as e:
            return json_error(str(e), 400)

        raw_imports = doc["metadata"].get("imports", [])
        if not isinstance(raw_imports, list):
            raw_imports = []

        imports = []
        for imp in raw_imports:
            if isinstance(imp, str) and imp.strip():
                path, name = idxmgr.parse_import_entry(imp.strip())
                if not name:
                    name = idxmgr.resolve_doc_display_name(path, doc_mgr)
                imports.append({"path": path, "name": name})

        return jsonify({"imports": imports})

    # ── 14. PUT /<category>/<doc_id>/imports ──
    @bp.route("/api/documents/<category>/<path:doc_id>/imports", methods=["PUT"])
    def update_doc_imports(category: str, doc_id: str):
        """更新文档的 imports 并失效缓存。"""
        try:
            doc = doc_mgr.read_document(
                category, doc_id,
                book_id=(request.json or {}).get("worldbook_id", request.args.get("worldbook_id")))
        except DocumentNotFoundError:
            return json_error(f"文档不存在: {category}/{doc_id}", 404)
        except ValueError as e:
            return json_error(str(e), 400)

        data = request.json or {}
        imports_list = data.get("imports", [])
        if not isinstance(imports_list, list):
            return json_error("imports 必须是数组")

        filepath = doc["filepath"]
        idxmgr.write_imports_to_file(filepath, imports_list, doc_mgr)

        try:
            invalidate_all_caches(idxmgr, wiki_manager)
        except Exception:
            pass

        return jsonify({"message": "imports 已更新", "imports": imports_list})

    # ── 15. POST /<category>/<doc_id>/imports/scan ──
    @bp.route("/api/documents/<category>/<path:doc_id>/imports/scan", methods=["POST"])
    def scan_import_candidates(category: str, doc_id: str):
        """扫描可引用的文档候选（基于标题关键词匹配）。"""
        try:
            doc = doc_mgr.read_document(category, doc_id)
        except DocumentNotFoundError:
            return json_error(f"文档不存在: {category}/{doc_id}", 404)

        title = doc.get("metadata", {}).get("name", doc_id)

        # 从层级配置中获取要扫描的类别及其层级
        levels = _load_hierarchy()
        scan_categories = set()
        cat_level_map: dict[str, int] = {}
        for level in levels:
            for c in level.get("categories", []):
                scan_categories.add(c)
                cat_level_map[c] = level["level"]
        # 回退到所有类别
        if not scan_categories:
            scan_categories = {c["id"] for c in doc_mgr.list_categories()}

        suggestions: list[dict] = []

        for scan_cat in scan_categories:
            if scan_cat == category:
                continue
            try:
                cat_docs = doc_mgr.list_documents(scan_cat, include_content=True)
            except Exception:
                continue

            for d in cat_docs:
                d_title = d.get("title", "")
                d_summary = d.get("summary", "")
                # 在文档标题/摘要中匹配关键词
                if title and title.lower() in d_title.lower():
                    match_type = "title_match"
                elif d_summary and title and title.lower() in d_summary.lower():
                    match_type = "summary_match"
                else:
                    # 在正文中搜索引用
                    try:
                        full_doc = doc_mgr.read_document(scan_cat, d["id"])
                        if title and title.lower() in full_doc.get("content", "").lower():
                            match_type = "content_match"
                        else:
                            continue
                    except Exception:
                        continue

                suggestions.append({
                    "category": scan_cat,
                    "id": d["id"],
                    "path": f"{scan_cat}/{d['id']}",
                    "title": d_title,
                    "name": d_title,
                    "level": cat_level_map.get(scan_cat, 99),
                    "summary": d_summary,
                    "match_type": match_type,
                })

        suggestions.sort(key=lambda s: s["title"].lower())
        return jsonify({"suggestions": suggestions, "total": len(suggestions)})

    # ── 16. GET /<category>/<doc_id>/imports/verify ──
    @bp.route("/api/documents/<category>/<path:doc_id>/imports/verify", methods=["GET"])
    def verify_doc_imports(category: str, doc_id: str):
        """验证文档的 imports 有效性（所有引用路径是否存在）。"""
        try:
            doc = doc_mgr.read_document(category, doc_id)
        except DocumentNotFoundError:
            return json_error(f"文档不存在: {category}/{doc_id}", 404)

        raw_imports = doc["metadata"].get("imports", [])
        if not isinstance(raw_imports, list):
            raw_imports = []

        results = []
        for imp in raw_imports:
            if not isinstance(imp, str) or not imp.strip():
                continue
            path, _ = idxmgr.parse_import_entry(imp.strip())
            if "/" not in path:
                results.append({
                    "path": imp,
                    "valid": False,
                    "error": "格式错误：需要 'category/id' 格式",
                })
                continue

            imp_cat, imp_id = path.split("/", 1)
            try:
                doc_mgr.read_document(imp_cat, imp_id)
                results.append({"path": path, "valid": True, "category": imp_cat, "id": imp_id})
            except DocumentNotFoundError:
                results.append({
                    "path": path,
                    "valid": False,
                    "error": f"文档不存在: {path}",
                })

        return jsonify({
            "total": len(raw_imports),
            "valid": sum(1 for r in results if r.get("valid")),
            "invalid": sum(1 for r in results if not r.get("valid")),
            "results": results,
        })

    # ── 17. GET /api/entities ──
    @bp.route("/api/entities", methods=["GET"])
    def list_entities():
        """Return currently visible entities with their owning worldbooks."""
        data = _load_all_entities(doc_mgr)
        return jsonify(data)

    app.register_blueprint(bp)
