"""Resolve authored stage images from a worldbook plot graph.

Graph edges and canvas coordinates are editorial only. Runtime cues are anchored
to stable plot/chapter/beat references, so rearranging the canvas cannot change
when an image appears.
"""

from __future__ import annotations

import re
from urllib.parse import unquote

_ASSET_URL = re.compile(r"^/api/assets/[a-z_]+/(?:[^/?#]+/)*[^/?#]+\.(?:png|jpe?g|webp|gif|bmp)$", re.I)


def valid_scene_image_url(url: object) -> bool:
    """Only local image assets may be persisted as authored scene media."""
    if not isinstance(url, str) or len(url) > 1024 or not _ASSET_URL.fullmatch(url):
        return False
    decoded = unquote(url)
    return all(part not in ("", ".", "..") and "\\" not in part
               for part in decoded.removeprefix("/api/assets/").split("/"))


def validate_node_scene_media(node: dict) -> list[str]:
    media = node.get("scene_media")
    if media is None:
        return []
    name = str(node.get("id") or "?")
    if not isinstance(media, dict):
        return [f"节点 {name} 的演出配置应为对象"]
    if node.get("type") not in ("plot", "chapter", "beat"):
        return [f"节点 {name} 不支持演出配置"]
    ref = node.get("ref") if isinstance(node.get("ref"), dict) else {}
    if node.get("type") == "chapter" and not isinstance(ref.get("chapter_idx"), int):
        return [f"章节节点 {name} 缺少有效章节引用"]
    if node.get("type") == "beat" and not str(ref.get("beat_id") or ""):
        return [f"节拍节点 {name} 缺少有效节拍引用"]
    errors = []
    for field in ("background_url", "cg_url"):
        value = media.get(field)
        if value and not valid_scene_image_url(value):
            errors.append(f"节点 {name} 的 {field} 必须是本站图片资源地址")
    if media.get("cg_url") and node.get("type") != "beat":
        errors.append(f"节点 {name} 只能在节拍上触发 CG")
    title = media.get("cg_title")
    if title is not None and (not isinstance(title, str) or len(title) > 100):
        errors.append(f"节点 {name} 的 CG 标题过长或格式无效")
    return errors


def resolve_scene_media(graph: dict | None, *, chapter_idx: int,
                        beat_id: str) -> dict:
    """Return current background and CG; chapter_idx is one based."""
    plot_bg = chapter_bg = beat_bg = None
    cg = None
    for node in (graph or {}).get("nodes") or []:
        if not isinstance(node, dict) or not isinstance(node.get("scene_media"), dict):
            continue
        media = node["scene_media"]
        ref = node.get("ref") if isinstance(node.get("ref"), dict) else {}
        bg = media.get("background_url")
        if bg and not valid_scene_image_url(bg):
            bg = None
        kind = node.get("type")
        if kind == "plot":
            plot_bg = plot_bg or bg
        elif kind == "chapter" and ref.get("chapter_idx") == chapter_idx:
            chapter_bg = chapter_bg or bg
        elif kind == "beat" and beat_id and ref.get("beat_id") == beat_id:
            # A duplicate beat id in another chapter must not leak its image.
            if ref.get("chapter_idx") not in (None, chapter_idx):
                continue
            beat_bg = beat_bg or bg
            url = media.get("cg_url")
            if cg is None and valid_scene_image_url(url):
                cg = {"url": url, "title": str(media.get("cg_title") or node.get("title") or "剧情画面")[:100]}
    return {"background_url": beat_bg or chapter_bg or plot_bg, "cg": cg}
