"""Edit beats in their actual plot source and commit the accompanying graph."""

from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import re
import tempfile
import time
import uuid

import frontmatter

from plot_graphs import (GraphError, GraphConflictError, decode_graph_entry,
                         encode_graph_for_worldbook, graph_revision,
                         normalize_graph, validate_graph, _find_entry)
from story_outline import (OutlineError, decode_outline_entry, entry_uid,
                           encode_outline_for_worldbook, heuristic_outline,
                           is_outline_entry, normalize_outline, _outline_plot_id)
from world_book import WorldBookEntry
# Share structure recognition with the graph overview.
from combat_nodes import _CHAPTER_RE, _BEAT_RE


class AuthoringError(GraphError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _source_path(mgr, book_id, plot_id):
    if (not isinstance(plot_id, str) or not plot_id or plot_id in (".", "..")
            or any(c in plot_id for c in "/\\:\x00") or plot_id.rstrip(" .") != plot_id):
        raise AuthoringError("非法剧情 ID")
    root = mgr._installed_path(book_id).parent.resolve()
    base = root / "plots"
    path = base / plot_id / "index.md"
    if not path.is_file():
        raise AuthoringError("剧情不属于该世界书或不存在", 404)
    if not path.resolve().is_relative_to(root):
        raise AuthoringError("剧情路径超出世界书")
    if any(p.is_symlink() or (getattr(p, "is_junction", lambda: False)())
           for p in (path, path.parent, base)):
        raise AuthoringError("剧情路径不能是符号链接或目录联接")
    return path


def _narrative(body):
    """Recognize the overview's chapters/beats while retaining write offsets."""
    chapters, chapter, offset = [], None, 0
    for raw_line in body.splitlines(keepends=True):
        line = raw_line.strip()
        match = _CHAPTER_RE.match(line)
        if match:
            if chapter is not None:
                chapter["_end"] = offset
            chapter = {"idx": int(match.group(1)), "title": match.group(2).strip(),
                       "beats": [], "_start": offset, "_end": len(body)}
            chapters.append(chapter)
        elif line.startswith("## "):
            if chapter is not None:
                chapter["_end"] = offset
                break
        elif chapter is not None:
            beat = _BEAT_RE.match(line)
            if beat:
                if chapter["beats"]:
                    chapter["beats"][-1]["_end"] = offset
                chapter["beats"].append({"id": beat.group(1), "_start": offset + len(raw_line)})
        offset += len(raw_line)
    for ch in chapters:
        for beat in ch["beats"]:
            beat.setdefault("_end", ch["_end"])
            lines = body[beat["_start"]:beat["_end"]].strip().splitlines()
            beat["title"] = re.sub(r"^\*\*内容\*\*[：:]\s*", "", lines[0]) if lines else beat["id"]
            beat["content"] = "\n".join(lines[1:]).strip()
    return chapters


def _state(mgr, book_id, plot_id):
    book = mgr.load(book_id)
    if book is None:
        raise AuthoringError("世界书不存在", 404)
    path = _source_path(mgr, book_id, plot_id)
    raw = path.read_bytes()
    post = frontmatter.loads(raw.decode("utf-8"))
    outlines = [e for e in book.entries if e.uid == entry_uid(plot_id)
                or (is_outline_entry(e) and _outline_plot_id(e) == plot_id)]
    outline = None
    if outlines:
        outline = deepcopy(decode_outline_entry(outlines[0]))
        normalize_outline(outline, plot_id=plot_id, worldbook_id=book_id)
    chapters = _narrative(post.content)
    source = "narrative" if chapters else "outline"
    if not chapters:
        if outline is None:
            try:
                outline = heuristic_outline({**post.metadata, "id": plot_id}, post.content,
                                            worldbook_id=book_id)
            except OutlineError as exc:
                if str(exc) != "大纲至少需要 1 个章节":
                    raise
                outline = {"plot_id": plot_id, "title": post.metadata.get("name") or plot_id,
                           "worldbook_id": book_id, "source": "heuristic", "chapters": []}
        chapters = [{"idx": i + 1, "title": ch.get("title") or "",
                     "beats": [{"id": b["id"], "title": b.get("title") or "",
                                "content": b.get("content") or ""} for b in ch.get("beats", [])]}
                    for i, ch in enumerate(outline["chapters"])]
    digest = hashlib.sha256(raw)
    digest.update(json.dumps([{"uid": e.uid, "content": e.content} for e in book.entries
                              if e in outlines or e.uid == f"plots_{plot_id}_index"], ensure_ascii=False,
                             sort_keys=True).encode("utf-8"))
    public = {"source": source, "source_revision": digest.hexdigest(),
              "chapters": [{"idx": ch["idx"], "title": ch["title"],
                            "beats": [{k: b[k] for k in ("id", "title", "content")}
                                      for b in ch["beats"]]} for ch in chapters]}
    return book, path, raw, post, outline, chapters, public


def load_authoring(mgr, book_id, plot_id):
    with mgr.book_lock(book_id):
        return _state(mgr, book_id, plot_id)[-1]


def _upsert(book, payload, existing=None):
    existing = existing or next((e for e in book.entries if e.uid == payload["uid"]), None)
    new = WorldBookEntry.from_dict(payload)
    if existing is None:
        book.entries.append(new)
    else:
        book.entries[book.entries.index(existing)] = new


def _replace_bytes(path, data):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".plot-authoring-",
                                         suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(data)
        temporary.replace(path)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


def write_beat(mgr, book_id, plot_id, data, *, beat_id=None):
    """Create with a complete graph draft, or update an existing source beat."""
    title, content = data.get("title"), data.get("content")
    if (not isinstance(title, str) or not title.strip() or len(title) > 200
            or any(c in title for c in "\r\n\x00")):
        raise AuthoringError("标题必须为不超过 200 字的单行文字")
    if not isinstance(content, str) or len(content) > 100000 or "\x00" in content:
        raise AuthoringError("正文必须为有效文字且不超过 100000 字")
    title = title.strip()
    with mgr.book_lock(book_id):
        original, path, raw, post, outline, chapters, public = _state(mgr, book_id, plot_id)
        # Structural Markdown inside a narrative body would create different beats.
        if public["source"] == "narrative" and any(
                _CHAPTER_RE.match(line.strip()) or line.strip().startswith("## ")
                or _BEAT_RE.match(line.strip()) for line in content.splitlines()):
            raise AuthoringError("正文不能包含章节或节拍结构标题")
        if data.get("source_revision") != public["source_revision"]:
            raise GraphConflictError("剧情源已修改，请重新加载后合并")
        source_entry = next((e for e in original.entries if e.uid == f"plots_{plot_id}_index"), None)
        if (public["source"] == "narrative" and source_entry is not None
                and source_entry.content.strip() != post.content.strip()):
            raise GraphConflictError("剧情原文与世界书条目内容不一致，请先核对并同步两处内容")
        book = deepcopy(original)
        graph, node = None, None
        if beat_id is None:
            idx = data.get("chapter_idx")
            if idx is None and not chapters:
                chapters = [{"idx": 1, "title": "第一章", "beats": []}]
                outline["chapters"] = [{"id": "ch_1", "title": "第一章", "beats": []}]
                idx = 1
            if isinstance(idx, bool) or not isinstance(idx, int):
                raise AuthoringError("chapter_idx 必须为有效章节编号")
            chapter = next((ch for ch in chapters if ch["idx"] == idx), None)
            if chapter is None:
                raise AuthoringError("章节不存在")
            supplied = data.get("graph")
            if not isinstance(supplied, dict) or not isinstance(supplied.get("nodes"), list) or not isinstance(supplied.get("edges"), list):
                raise AuthoringError("缺少有效完整 graph 文档")
            if supplied.get("plot_id", plot_id) != plot_id or supplied.get("worldbook_id", book_id) != book_id:
                raise AuthoringError("graph 归属不一致")
            errors = validate_graph(supplied, plot_id=plot_id)
            if errors:
                raise AuthoringError(errors)
            existing = _find_entry(original, plot_id)
            current = normalize_graph(decode_graph_entry(existing.to_dict()), plot_id=plot_id) if existing else None
            if supplied.get("_revision", "absent") != graph_revision(current):
                raise GraphConflictError("节点图已修改，请重新加载后合并")
            position = data.get("position")
            if (not isinstance(position, dict) or any(isinstance(position.get(k), bool)
                    or not isinstance(position.get(k), (int, float)) or not math.isfinite(position[k]) for k in ("x", "y"))):
                raise AuthoringError("position 必须包含有限数字 x/y")
            beat_id = "beat_" + uuid.uuid4().hex
            node = {"id": "n_" + uuid.uuid4().hex, "type": "beat", "title": title,
                    "content": "", "x": position["x"], "y": position["y"],
                    "ref": {"chapter_idx": idx, "beat_id": beat_id}}
            graph = normalize_graph(deepcopy(supplied), plot_id=plot_id, worldbook_id=book_id)
            graph["nodes"].append(node)
            graph = normalize_graph(graph, plot_id=plot_id, worldbook_id=book_id)
            node = graph["nodes"][-1]
            errors = validate_graph(graph, plot_id=plot_id)
            if errors:
                raise AuthoringError(errors)
            graph["updated_at"] = time.time()
            _upsert(book, encode_graph_for_worldbook(graph), _find_entry(book, plot_id))
            creating = True
        else:
            chapter = next((ch for ch in chapters if any(b["id"] == beat_id for b in ch["beats"])), None)
            if chapter is None:
                raise AuthoringError("节拍不存在", 404)
            creating = False
        new_raw = None
        if public["source"] == "outline":
            target = outline["chapters"][chapter["idx"] - 1]
            if creating:
                target["beats"].append({"id": beat_id, "title": title, "content": content})
            else:
                target_beat = next(b for b in target["beats"] if b["id"] == beat_id)
                target_beat.update(title=title, content=content)
            normalized = normalize_outline(outline, plot_id=plot_id, worldbook_id=book_id)
            if creating:
                target["beats"][-1] = normalized["chapters"][chapter["idx"] - 1]["beats"][-1]
            # Validation supplies defaults, while existing author fields stay intact.
            outline = {**normalized, **outline}
            outline_entry = next((e for e in book.entries if e.uid == entry_uid(plot_id)
                                  or (is_outline_entry(e) and _outline_plot_id(e) == plot_id)), None)
            _upsert(book, encode_outline_for_worldbook(outline), outline_entry)
        else:
            body = post.content
            replacement = "\n\n**内容**：" + title + ("\n" + content if content else "") + "\n\n"
            if creating:
                offset = chapter["_end"]
                body = body[:offset].rstrip() + "\n\n#### " + beat_id + replacement + body[offset:]
            else:
                target_beat = next(b for b in chapter["beats"] if b["id"] == beat_id)
                body = body[:target_beat["_start"]] + replacement + body[target_beat["_end"]:]
            # Preserve the original frontmatter text rather than reserializing YAML.
            text = raw.decode("utf-8")
            front = re.match(r"\A---\r?\n.*?\r?\n---(?:\r?\n|$)", text, re.DOTALL)
            new_text = (text[:front.end()] + "\n" if front else "") + body + "\n"
            new_raw = new_text.replace("\r\n", "\n").replace("\n", "\r\n").encode("utf-8")
            uid = f"plots_{plot_id}_index"
            entry = next((e for e in book.entries if e.uid == uid), None)
            if entry:
                entry.content = body
            else:
                name = post.metadata.get("name") or plot_id
                book.entries.append(WorldBookEntry(uid=uid, name=name, content=body,
                                                   group="剧情", trigger_keys=[name]))
            _replace_bytes(path, new_raw)
        try:
            mgr.save(book)
        except Exception:
            mgr._cache[book_id] = original
            if new_raw is not None:
                _replace_bytes(path, raw)
            raise
        result = {"authoring": _state(mgr, book_id, plot_id)[-1]}
        if graph is not None:
            graph["_revision"] = graph_revision(graph)
            result.update(graph=graph, node=node)
        return result
