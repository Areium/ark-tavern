"""
文档管理器：对所有 Markdown 数据文件的 CRUD 操作 + 哈希冲突检测。

设计：
- 从 data/categories.yaml 自动发现文档类别和路径
- 读文件时返回 SHA256 哈希，写文件时校验哈希以检测冲突
- 支持类别子目录（如 Location/Rhode_Island/）
"""

import os
import hashlib
import logging
import shutil
from typing import Optional

import frontmatter
import yaml
from data_paths import categories_path, content_root
from content_scope import is_content_visible
from worldbook_content import category_roots

logger = logging.getLogger(__name__)

# ── 异常类 ──


class DocumentNotFoundError(Exception):
    pass


class ConflictError(Exception):
    """保存冲突：文件已被其他进程修改。"""

    def __init__(self, path: str, current_hash: str, expected_hash: str,
                 current_content: str):
        self.path = path
        self.current_hash = current_hash
        self.expected_hash = expected_hash
        self.current_content = current_content
        super().__init__(f"文件已被修改: {path}")


# ── 类别描述 ──


class DocumentCategory:
    """一个文档类别（对应 categories.yaml 中的一个条目）。"""

    def __init__(self, category_id: str, directory: str):
        self.id = category_id
        self.directory = directory

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "directory": self.directory,
        }


class DocumentInfo:
    """单个文档的信息。

    `worldbook_id` 为「来源世界书」标注（实体文件夹 index.md frontmatter 的
    `worldbook_id`，与资产/卡牌界面同源）；传统 .md 文档与未标注实体一律为空串，
    消费方必须把空串当作「未分类」处理，不得据此报错。
    """

    def __init__(self, category_id: str, doc_id: str, title: str, path: str,
                 hash_str: str, mtime: float, summary: str = "",
                 worldbook_id: str = ""):
        self.category_id = category_id
        self.id = doc_id
        self.title = title
        self.path = path
        self.hash = hash_str
        self.mtime = mtime
        self.summary = summary
        self.worldbook_id = worldbook_id

    def to_dict(self) -> dict:
        return {
            "category_id": self.category_id,
            "id": self.id,
            "title": self.title,
            "name": self.title,  # 兼容别名：前端角色库/入队选择使用 name 字段
            "hash": self.hash,
            "mtime": self.mtime,
            "summary": self.summary,
            # 来源世界书标注（空串 = 未分类/未标注）；旧数据无此字段时前端按未分类处理
            "worldbook_id": self.worldbook_id,
        }


# ── 文档内容 ──


# ── 主类 ──


class DocumentManager:
    """文档管理器：读取/写入/列举所有数据文件。

    支持两种文档组织方式（双模式）：
    - 实体文件夹：目录包含 index.md（如 characters/银灰/index.md）
    - 传统文件：独立 .md 文件（如 characters/银灰.md），向后兼容
    """

    # 文件名白名单（不视为数据文档）
    _EXCLUDED_FILES = {"TEMPLATE", "_index", "_INDEX", "README"}

    def __init__(self, root_dir: str = None):
        if root_dir is None:
            # 从 __file__ 定位项目根目录
            self._root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        else:
            self._root = root_dir

        self._categories: dict[str, DocumentCategory] = {}
        self._hierarchy: list[dict] = []
        self._load_index()

    # ── 索引加载 ──

    def _load_index(self):
        """加载 data/categories.yaml 注册表。"""
        yaml_path = categories_path(self._root)
        if not os.path.isfile(yaml_path):
            logger.warning("categories.yaml 不存在: %s", yaml_path)
            return

        try:
            with open(yaml_path, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f)
            cat_data = data.get("categories", {})
            for cat_id, cat_info in cat_data.items():
                dir_path = cat_info if isinstance(cat_info, str) else cat_info.get("dir", "")
                self._categories[cat_id] = DocumentCategory(
                    category_id=cat_id,
                    directory=os.path.join(self._root, dir_path),
                )
            h_data = data.get("hierarchy", {})
            self._hierarchy = h_data.get("levels", [])
            logger.info("加载了 %d 个文档类别", len(self._categories))
        except Exception as e:
            logger.error("加载 categories.yaml 失败: %s", e)

    # ── 类别查询 ──

    def list_categories(self) -> list[dict]:
        """返回所有文档类别。"""
        return [cat.to_dict() for cat in self._categories.values()]

    def get_category(self, category_id: str) -> Optional[DocumentCategory]:
        return self._categories.get(category_id)

    def get_hierarchy(self) -> list[dict]:
        return self._hierarchy

    @staticmethod
    def _selected_book_ids(book_id: str | None):
        if book_id is not None and not isinstance(book_id, str):
            raise ValueError("worldbook_id 必须是字符串")
        return [book_id] if book_id else None

    def _category_roots(self, category_id: str, book_ids=None) -> list[tuple[str | None, str]]:
        cat = self._categories[category_id]
        content_base = os.path.abspath(content_root(self._root))
        directory = os.path.abspath(cat.directory)
        try:
            relative = os.path.relpath(directory, content_base).replace("\\", "/")
            inside = relative != ".." and not relative.startswith("../")
        except ValueError:
            inside = False
        roots = ([(owner, str(path)) for owner, path in category_roots(
            relative, book_ids=book_ids, project_root=self._root)]
            if inside and relative != "." else [])
        # User-authored files in the shared tree remain available without a binding.
        if book_ids is None and os.path.isdir(directory) and directory not in [path for _, path in roots]:
            roots.append((None, directory))
        return roots

    # ── 文档列举 ──

    def list_documents(self, category_id: str,
                       include_content: bool = False, *, book_id: str | None = None,
                       book_ids=None, include_duplicates: bool = False) -> list[dict]:
        """列出指定类别下的所有文档。

        支持两种文档模式：
        - 实体文件夹：目录含 index.md → doc_id 为文件夹名
        - 传统文件：独立 .md 文件（向后兼容）

        Args:
            category_id: 类别 ID（如 "characters"）
            include_content: 是否同时返回内容摘要

        Returns:
            文档信息列表
        """
        cat = self._categories.get(category_id)
        if not cat:
            raise ValueError(f"未知文档类别: {category_id}")

        docs = []
        seen = set()
        selected = self._selected_book_ids(book_id)
        roots = ([(None, cat.directory)] if book_id == "" else
                 self._category_roots(category_id,
                                      selected if book_id is not None else book_ids))
        for owner, base in roots:
            for doc in self._list_documents_in_root(category_id, base, include_content, owner):
                if include_duplicates or doc["id"] not in seen:
                    docs.append(doc)
                    seen.add(doc["id"])
        return docs

    def _list_documents_in_root(self, category_id: str, base: str,
                                include_content: bool, owner: str | None) -> list[dict]:
        docs = []
        if not os.path.isdir(base):
            return docs

        entity_dirs: set[str] = set()  # 已识别为实体的目录绝对路径

        for root, dirs, _files in os.walk(base):
            dirs[:] = sorted(d for d in dirs if is_content_visible(os.path.join(root, d), project_root=self._root))

            # 1. 识别实体文件夹（含 index.md 的目录）
            for d in dirs:
                d_full = os.path.join(root, d)
                index_md = os.path.join(d_full, "index.md")
                if os.path.isfile(index_md) and is_content_visible(index_md, project_root=self._root):
                    entity_dirs.add(d_full)
                    doc_rel = os.path.relpath(d_full, base).replace("\\", "/")
                    stat = os.stat(index_md)
                    file_hash = self._hash_file(index_md)

                    title = d
                    summary = ""
                    worldbook_id = owner or ""
                    # 实体文件夹总是解析 frontmatter：`worldbook_id`（来源世界书）
                    # 与 include_content 无关，title/summary 仍只在需要时取用。
                    try:
                        with open(index_md, "r", encoding="utf-8") as fh:
                            data = frontmatter.load(fh)
                        if not owner:
                            worldbook_id = str(data.metadata.get("worldbook_id") or "")
                        if include_content:
                            title = data.metadata.get("name", d)
                            summary = data.metadata.get("summary", "")
                            if not summary:
                                first_line = data.content.strip().split("\n")[0]
                                summary = first_line[:80] if first_line else ""
                    except Exception:
                        pass

                    docs.append(DocumentInfo(
                        category_id=category_id,
                        doc_id=doc_rel,
                        title=title,
                        path=doc_rel,  # 实体文件夹：路径不含 index.md
                        hash_str=file_hash,
                        mtime=stat.st_mtime,
                        summary=summary,
                        worldbook_id=worldbook_id,
                    ).to_dict())

        for root, _dirs, files in os.walk(base):
            _dirs[:] = [d for d in _dirs if is_content_visible(os.path.join(root, d), project_root=self._root)]
            for f in sorted(files):
                if not f.endswith(".md"):
                    continue
                stem = os.path.splitext(f)[0]
                if stem in self._EXCLUDED_FILES or stem == "index":
                    continue

                filepath = os.path.join(root, f)
                if not is_content_visible(filepath, project_root=self._root):
                    continue

                # 跳过已在实体文件夹内的 .md 文件（由第三遍扫描作为子文档处理）
                file_dir = os.path.dirname(filepath)
                is_in_entity = any(
                    file_dir == ed or file_dir.startswith(ed + os.sep)
                    for ed in entity_dirs
                )
                if is_in_entity:
                    continue

                cat_rel = os.path.relpath(filepath, base).replace("\\", "/")
                doc_id = os.path.splitext(cat_rel)[0]

                stat = os.stat(filepath)
                file_hash = self._hash_file(filepath)

                title = stem
                summary = ""
                if include_content:
                    try:
                        with open(filepath, "r", encoding="utf-8") as fh:
                            data = frontmatter.load(fh)
                        title = data.metadata.get("name", stem)
                        summary = data.metadata.get("summary", "")
                        if not summary:
                            first_line = data.content.strip().split("\n")[0]
                            summary = first_line[:80] if first_line else ""
                    except Exception:
                        pass

                docs.append(DocumentInfo(
                    category_id=category_id,
                    doc_id=doc_id,
                    title=title,
                    path=cat_rel,
                    hash_str=file_hash,
                    mtime=stat.st_mtime,
                    summary=summary,
                    worldbook_id=owner or "",
                ).to_dict())

        # 第三遍：收集实体目录内的子文档（非 index.md）
        for entity_dir in entity_dirs:
            entity_name = os.path.relpath(entity_dir, base).replace("\\", "/")
            for sub_root, _sub_dirs, sub_files in os.walk(entity_dir):
                _sub_dirs[:] = [d for d in _sub_dirs if is_content_visible(os.path.join(sub_root, d), project_root=self._root)]
                for f in sorted(sub_files):
                    if not f.endswith(".md"):
                        continue
                    stem = os.path.splitext(f)[0]
                    if stem == "index" or stem in self._EXCLUDED_FILES:
                        continue

                    filepath = os.path.join(sub_root, f)
                    if not is_content_visible(filepath, project_root=self._root):
                        continue
                    sub_rel = os.path.relpath(filepath, entity_dir).replace("\\", "/")
                    # 复合 doc_id: "entity_name/sub_name"
                    doc_id = f"{entity_name}/{os.path.splitext(sub_rel)[0]}"

                    stat = os.stat(filepath)
                    file_hash = self._hash_file(filepath)
                    cat_rel = os.path.relpath(filepath, base).replace("\\", "/")

                    title = stem
                    summary = ""
                    if include_content:
                        try:
                            with open(filepath, "r", encoding="utf-8") as fh:
                                data = frontmatter.load(fh)
                            title = data.metadata.get("name", stem)
                            summary = data.metadata.get("summary", "")
                            if not summary:
                                first_line = data.content.strip().split("\n")[0]
                                summary = first_line[:80] if first_line else ""
                        except Exception:
                            pass

                    docs.append(DocumentInfo(
                        category_id=category_id,
                        doc_id=doc_id,
                        title=title,
                        path=cat_rel,
                        hash_str=file_hash,
                        mtime=stat.st_mtime,
                        summary=summary,
                        worldbook_id=owner or "",
                    ).to_dict())

        return docs

    def list_all_documents(self) -> list[dict]:
        """递归列举所有类别的所有文档（供前端文档树使用）。"""
        result = []
        for cat_id in self._categories:
            try:
                docs = self.list_documents(cat_id, include_content=True)
                result.append({
                    "category": cat_id,
                    "category_info": self._categories[cat_id].to_dict(),
                    "documents": docs,
                })
            except Exception as e:
                logger.error("列举类别 %s 失败: %s", cat_id, e)
        return self._build_tree(result)

    def _build_tree(self, flat: list[dict]) -> list[dict]:
        """将平铺列表按目录层级组织成树结构。"""
        for cat_group in flat:
            cat_group["children"] = self._docs_to_tree(
                cat_group.pop("documents", []), cat_group["category"]
            )
        return flat

    def _docs_to_tree(self, documents: list[dict], category_id: str) -> list[dict]:
        """Build nested tree from flat document list by splitting doc id on '/' or '\\'.

        支持实体文件夹内含子文档的情况：当文档的中间路径也是另一个文档时，
        该节点升级为可展开的文档节点（带 children）。
        """
        root: dict[str, dict] = {}
        for doc in documents:
            parts = doc["id"].replace("\\", "/").split("/")
            current = root
            for i, part in enumerate(parts):
                if i == len(parts) - 1:
                    # 叶子节点：文档
                    node = {
                        "name": doc["title"],
                        "type": "document",
                        "id": doc["id"],
                        "hash": doc["hash"],
                        "mtime": doc["mtime"],
                        "summary": doc["summary"],
                        "category_id": doc["category_id"],
                        "worldbook_id": doc["worldbook_id"],
                    }
                    if part in current and "children" in current[part]:
                        # 已有中间路径创建的 folder → 升级为可展开文档
                        node["children"] = current[part]["children"]
                    current[part] = node
                else:
                    if part not in current:
                        current[part] = {"name": part, "type": "folder", "children": {}}
                    elif "children" not in current[part]:
                        # 已有文档节点但无 children → 添加 children
                        current[part]["children"] = {}
                    current = current[part]["children"]
        return self._dict_tree_to_list(root)

    @staticmethod
    def _dict_tree_to_list(d: dict[str, dict]) -> list[dict]:
        """Convert interim dict-tree to sorted list-tree (folders first, then A-Z)."""
        result: list[dict] = []
        folders = [(k, v) for k, v in d.items() if v.get("type") == "folder"]
        docs = [(k, v) for k, v in d.items() if v.get("type") != "folder"]
        for name, node in sorted(folders, key=lambda x: x[0].lower()) + sorted(docs, key=lambda x: x[0].lower()):
            entry = dict(node)
            if "children" in entry and isinstance(entry["children"], dict):
                entry["children"] = DocumentManager._dict_tree_to_list(entry["children"])
            result.append(entry)
        return result

    # ── 文档读写 ──

    def read_document(self, category_id: str, doc_path: str, *,
                      book_id: str | None = None, book_ids=None) -> dict:
        """读取文档内容。

        Args:
            category_id: 类别 ID
            doc_path: 文档相对路径（相对于类别目录，不含 .md 后缀）

        Returns:
            {"metadata": {...}, "content": "...", "hash": "...", "path": "...",
             "filepath": "...", "frontmatter_raw": "..."}
        """
        selected = self._selected_book_ids(book_id) if book_id is not None else book_ids
        filepath = self._resolve_path(category_id, doc_path, book_ids=selected,
                                      local_only=book_id == "")
        if not filepath or not os.path.isfile(filepath) or not is_content_visible(filepath, project_root=self._root):
            raise DocumentNotFoundError(
                f"文档不存在: {category_id}/{doc_path}"
            )

        with open(filepath, "r", encoding="utf-8") as f:
            raw = f.read()

        try:
            data = frontmatter.loads(raw)
            fm_raw = raw.split("---", 2)[1] if raw.startswith("---") else ""
        except Exception:
            data = type("obj", (object,), {"metadata": {}, "content": raw})()
            fm_raw = ""

        file_hash = self._hash_file(filepath)
        # 实体文件夹：path 不含 index.md，用文件夹名作为路径
        if os.path.basename(filepath) == "index.md":
            rel_path = os.path.relpath(os.path.dirname(filepath), self._root)
        else:
            rel_path = os.path.relpath(filepath, self._root)

        return {
            "metadata": data.metadata,
            "content": data.content,
            "frontmatter_raw": fm_raw,
            "hash": file_hash,
            "path": rel_path,
            "filepath": filepath,
        }

    def save_document(self, category_id: str, doc_path: str,
                      content: str, metadata: dict = None,
                      expected_hash: str = None, *, book_id: str | None = None) -> dict:
        """保存文档。

        如果提供了 expected_hash，写入前会校验文件当前哈希，
        不匹配则抛出 ConflictError。

        Args:
            category_id: 类别 ID
            doc_path: 文档相对路径（相对于类别目录，不含 .md）
            content: 正文内容（不含 frontmatter）
            metadata: frontmatter 字典（None 表示保留原值）
            expected_hash: 预期的文件哈希（用于冲突检测）

        Returns:
            {"hash": "...", "path": "..."}
        """
        filepath = self._resolve_path(category_id, doc_path,
                                      book_ids=self._selected_book_ids(book_id),
                                      local_only=book_id == "")
        if (not filepath or (book_id is not None and not os.path.isfile(filepath))
                or not is_content_visible(filepath, project_root=self._root)):
            raise DocumentNotFoundError(
                f"文档不存在: {category_id}/{doc_path}"
            )

        # 确保父目录存在（对实体文件夹尤其重要）
        os.makedirs(os.path.dirname(filepath), exist_ok=True)

        # 冲突检测
        if expected_hash:
            if os.path.isfile(filepath):
                current_hash = self._hash_file(filepath)
                if current_hash != expected_hash:
                    with open(filepath, "r", encoding="utf-8") as f:
                        current_content = f.read()
                    raise ConflictError(
                        path=filepath,
                        current_hash=current_hash,
                        expected_hash=expected_hash,
                        current_content=current_content,
                    )

        # 读取已有 frontmatter（如果 metadata 未提供则保留）
        if metadata is None:
            try:
                if os.path.isfile(filepath):
                    with open(filepath, "r", encoding="utf-8") as f:
                        existing = frontmatter.load(f)
                    metadata = existing.metadata
                else:
                    metadata = {}
            except Exception:
                metadata = {}

        # 写回文件
        with open(filepath, "w", encoding="utf-8") as f:
            if metadata:
                f.write("---\n")
                f.write(yaml.dump(metadata, allow_unicode=True,
                                  default_flow_style=False, sort_keys=False))
                f.write("---\n")
            f.write(content.lstrip("\n"))

        new_hash = self._hash_file(filepath)
        # 实体文件夹：path 用文件夹名
        if os.path.basename(filepath) == "index.md":
            rel_path = os.path.relpath(os.path.dirname(filepath), self._root)
        else:
            rel_path = os.path.relpath(filepath, self._root)
        logger.info("文档已保存: %s (%s)", rel_path, new_hash[:12])
        return {"hash": new_hash, "path": rel_path}

    def create_document(self, category_id: str, doc_id: str,
                        content: str = "", metadata: dict = None) -> dict:
        """创建新文档（实体文件夹模式：创建 {doc_id}/index.md）。

        Args:
            category_id: 类别 ID
            doc_id: 文档 ID（不含 .md 后缀，可包含子目录路径）
            content: 正文内容
            metadata: frontmatter 字典

        Returns:
            {"hash": "...", "path": "..."}
        """
        filepath = self._resolve_path(category_id, doc_id)
        if not filepath:
            if category_id not in self._categories:
                raise ValueError(f"未知文档类别: {category_id}")
            raise ValueError(f"非法文档路径: {doc_id}")
        if not is_content_visible(filepath, project_root=self._root):
            raise ValueError(f"文档路径不可用: {doc_id}")

        if os.path.isfile(filepath):
            raise FileExistsError(f"文档已存在: {doc_id}")

        entity_dir = os.path.dirname(filepath)
        os.makedirs(entity_dir, exist_ok=True)
        with open(filepath, "w", encoding="utf-8") as f:
            if metadata:
                f.write("---\n")
                f.write(yaml.dump(metadata, allow_unicode=True,
                                  default_flow_style=False, sort_keys=False))
                f.write("---\n")
            if content:
                f.write("\n")
                f.write(content)

        new_hash = self._hash_file(filepath)
        rel_path = os.path.relpath(entity_dir, self._root)
        logger.info("文档已创建: %s", rel_path)
        return {"hash": new_hash, "path": rel_path}

    def delete_document(self, category_id: str, doc_path: str, *,
                        book_id: str | None = None):
        """删除文档。

        实体文件夹模式：删除整个实体目录（含所有资产）。
        传统文件模式：仅删除 .md 文件。
        """
        filepath = self._resolve_path(category_id, doc_path,
                                      book_ids=self._selected_book_ids(book_id),
                                      local_only=book_id == "")
        if not filepath or not os.path.isfile(filepath) or not is_content_visible(filepath, project_root=self._root):
            raise DocumentNotFoundError(
                f"文档不存在: {category_id}/{doc_path}"
            )

        # 实体文件夹：删除整个目录
        if os.path.basename(filepath) == "index.md":
            entity_dir = os.path.dirname(filepath)
            shutil.rmtree(entity_dir)
            logger.info("实体文件夹已删除: %s", entity_dir)
        else:
            os.remove(filepath)
            logger.info("文档已删除: %s", filepath)

    # ── 文件夹操作 ──

    def create_folder(self, category_id: str, folder_path: str) -> dict:
        """在类别目录中创建空文件夹。"""
        cat = self._categories.get(category_id)
        if not cat:
            raise ValueError(f"未知文档类别: {category_id}")
        full_path = os.path.join(cat.directory, folder_path)
        if os.path.exists(full_path):
            raise FileExistsError(f"文件夹已存在: {folder_path}")
        os.makedirs(full_path, exist_ok=True)
        logger.info("文件夹已创建: %s", full_path)
        return {"path": folder_path, "category": category_id}

    def delete_folder(self, category_id: str, folder_path: str) -> dict:
        """删除空文件夹（仅当为空时允许）。"""
        cat = self._categories.get(category_id)
        if not cat:
            raise ValueError(f"未知文档类别: {category_id}")
        full_path = os.path.join(cat.directory, folder_path)
        if not os.path.isdir(full_path):
            raise DocumentNotFoundError(f"文件夹不存在: {folder_path}")
        if os.listdir(full_path):
            raise ValueError(f"文件夹非空: {folder_path}，请先删除内容")
        os.rmdir(full_path)
        logger.info("文件夹已删除: %s", full_path)
        return {"path": folder_path, "category": category_id}

    # ── 移动/重命名 ──

    def move_document(self, category_id: str, doc_path: str,
                      new_path: str = None, *, book_id: str | None = None) -> dict:
        """移动/重命名文档。

        实体文件夹：移动/重命名整个实体目录。
        传统文件：移动/重命名 .md 文件。
        new_path 为新的相对路径（相对于类别目录，不含 .md）。
        """
        old_filepath = self._resolve_path(category_id, doc_path,
                                          book_ids=self._selected_book_ids(book_id),
                                          local_only=book_id == "")
        if not old_filepath or not os.path.isfile(old_filepath) or not is_content_visible(old_filepath, project_root=self._root):
            raise DocumentNotFoundError(f"文档不存在: {category_id}/{doc_path}")

        target_rel = new_path or doc_path
        cat = self._categories[category_id]
        source_base = next((base for _, base in self._category_roots(category_id)
                            if os.path.commonpath((base, old_filepath)) == base), cat.directory)
        target_candidates = self._document_candidates(category_id, target_rel, base=source_base)
        if not target_candidates:
            raise ValueError(f"非法目标路径: {target_rel}")
        target_entity_file, target_flat_file = target_candidates
        if not is_content_visible(target_entity_file, project_root=self._root) or not is_content_visible(target_flat_file, project_root=self._root):
            raise ValueError(f"目标路径不可用: {target_rel}")
        existing_target = next((path for path in target_candidates if os.path.isfile(path)), None)
        if existing_target and os.path.isfile(existing_target):
            raise FileExistsError(f"目标已存在: {target_rel}")

        # 判断是实体文件夹还是传统文件
        if os.path.basename(old_filepath) == "index.md":
            old_entity_dir = os.path.dirname(old_filepath)
            new_entity_dir = os.path.dirname(target_entity_file)

            if old_entity_dir == new_entity_dir:
                raise ValueError("源路径和目标路径相同")

            if os.path.exists(new_entity_dir):
                raise FileExistsError(f"目标已存在: {target_rel}")

            os.makedirs(os.path.dirname(new_entity_dir), exist_ok=True)
            os.rename(old_entity_dir, new_entity_dir)
            self._cleanup_empty_dirs(os.path.dirname(old_entity_dir), cat.directory)
            logger.info("实体文件夹已移动: %s → %s", old_entity_dir, new_entity_dir)
        else:
            new_filepath = target_flat_file

            if old_filepath == new_filepath:
                raise ValueError("源路径和目标路径相同")

            if os.path.exists(new_filepath):
                raise FileExistsError(f"目标已存在: {target_rel}")

            os.makedirs(os.path.dirname(new_filepath), exist_ok=True)
            os.rename(old_filepath, new_filepath)
            self._cleanup_empty_dirs(os.path.dirname(old_filepath), cat.directory)
            logger.info("文档已移动: %s → %s", old_filepath, new_filepath)

        return {
            "old_path": f"{category_id}/{doc_path}",
            "new_path": f"{category_id}/{target_rel}",
            "category": category_id,
        }

    def move_folder(self, category_id: str, folder_path: str,
                    new_path: str = None) -> dict:
        """移动/重命名文件夹。"""
        cat = self._categories.get(category_id)
        if not cat:
            raise ValueError(f"未知文档类别: {category_id}")

        old_full = os.path.join(cat.directory, folder_path)
        if not os.path.isdir(old_full):
            raise DocumentNotFoundError(f"文件夹不存在: {folder_path}")

        target_rel = new_path or folder_path
        new_full = os.path.join(cat.directory, target_rel)

        if old_full == new_full:
            raise ValueError("源路径和目标路径相同")

        if os.path.exists(new_full):
            raise FileExistsError(f"目标已存在: {target_rel}")

        os.makedirs(os.path.dirname(new_full), exist_ok=True)
        os.rename(old_full, new_full)

        self._cleanup_empty_dirs(os.path.dirname(old_full), cat.directory)

        logger.info("文件夹已移动: %s → %s", old_full, new_full)
        return {
            "old_path": f"{category_id}/{folder_path}",
            "new_path": f"{category_id}/{target_rel}",
            "category": category_id,
        }

    @staticmethod
    def _cleanup_empty_dirs(start_dir: str, stop_dir: str):
        """删除空的父目录链，直到 stop_dir（不含）。"""
        current = start_dir
        while current and current.startswith(stop_dir) and current != stop_dir:
            try:
                if not os.path.isdir(current):
                    break
                if os.listdir(current):
                    break
                os.rmdir(current)
                current = os.path.dirname(current)
            except OSError:
                break

    # ── 内部方法 ──

    def _document_candidates(self, category_id: str,
                             doc_path: str, *, base: str | None = None) -> Optional[tuple[str, str]]:
        """Return safe entity and flat-file candidates for a document id."""
        cat = self._categories.get(category_id)
        if not cat or not isinstance(doc_path, str) or not doc_path.strip():
            return None

        relative = doc_path.strip().replace("\\", os.sep).replace("/", os.sep)
        base = os.path.realpath(base or cat.directory)
        entity_raw = os.path.abspath(os.path.join(base, relative, "index.md"))
        flat_raw = os.path.abspath(os.path.join(base, f"{relative}.md"))
        entity_path = os.path.realpath(entity_raw)
        flat_path = os.path.realpath(flat_raw)
        try:
            if (os.path.commonpath((base, entity_path)) != base
                    or os.path.commonpath((base, flat_path)) != base
                    or entity_raw != entity_path or flat_raw != flat_path):
                return None
        except ValueError:
            return None
        return entity_path, flat_path

    def _resolve_path(self, category_id: str, doc_path: str, *, book_ids=None,
                      local_only: bool = False) -> Optional[str]:
        """将 category_id + doc_path 解析为实际文件路径。

        实体文件夹 `{dir}/{doc_path}/index.md` 优先；若不存在则回退到
        传统平铺文件 `{dir}/{doc_path}.md`。两者都不存在时返回实体路径，
        供保存/创建沿用默认的实体文件夹格式。
        """
        local_candidates = self._document_candidates(category_id, doc_path)
        if not local_candidates:
            return None
        roots = ([(None, self._categories[category_id].directory)] if local_only else
                 self._category_roots(category_id, book_ids))
        for _, base in roots:
            candidates = self._document_candidates(category_id, doc_path, base=base)
            if not candidates:
                continue
            entity_path, flat_path = candidates
            if os.path.isfile(entity_path):
                return entity_path
            if os.path.isfile(flat_path):
                return flat_path
        return local_candidates[0] if book_ids is None and not local_only else None

    @staticmethod
    def _hash_file(filepath: str) -> str:
        """计算文件的 SHA256 哈希。"""
        h = hashlib.sha256()
        with open(filepath, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()
