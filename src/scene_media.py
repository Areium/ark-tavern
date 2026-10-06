"""Frozen, book-owned presentation actions and rollback-safe runtime state.

Only set_visual/image is enabled. Future set_bgm/video variants must be explicitly
implemented; unsupported actions are rejected rather than silently ignored.
"""
from __future__ import annotations
import copy
import hashlib
import math
import re
from pathlib import Path
from urllib.parse import quote

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


def valid_scene_asset(asset):
    if not isinstance(asset, str) or not asset or len(asset) > 1024:
        return False
    if any(c in asset for c in "\\:?#%") or any(ord(c) < 32 for c in asset):
        return False
    parts = asset.split("/")
    return (len(parts) >= 2 and re.fullmatch(r"[a-z][a-z_]*", parts[0]) is not None
            and all(p and p not in (".", "..") for p in parts)
            and Path(asset).suffix.lower() in IMAGE_EXTENSIONS)


def validate_visual(visual):
    if not isinstance(visual, dict) or set(visual) != {"kind", "asset", "role", "fit", "position", "portraits"}:
        raise ValueError("画面动作字段不完整或含未知字段")
    if visual["kind"] != "image":
        raise ValueError("当前仅支持图片画面；视频播放尚未启用")
    if not valid_scene_asset(visual["asset"]):
        raise ValueError("图片必须是本书内的相对资源路径")
    if visual["role"] not in ("background", "cg") or visual["fit"] not in ("cover", "contain"):
        raise ValueError("画面用途或图片适配无效")
    if visual["portraits"] not in ("show", "hide"):
        raise ValueError("立绘设置应为 show / hide")
    pos = visual["position"]
    if not isinstance(pos, list) or len(pos) != 2 or any(
            isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v)
            or not 0 <= v <= 100 for v in pos):
        raise ValueError("图片焦点应为两个 0–100 的有限数字")


def validate_node_scene_media(node):
    media = node.get("scene_media")
    if media is None:
        return []
    try:
        if not isinstance(media, dict) or set(media) - {"background", "events"}:
            raise ValueError("演出配置应使用 background / events；旧图片地址字段已移除")
        kind, ref = node.get("type"), node.get("ref") or {}
        if kind not in ("plot", "chapter", "beat") or not isinstance(ref, dict):
            raise ValueError("该节点不支持演出配置")
        if kind in ("chapter", "beat") and (type(ref.get("chapter_idx")) is not int or ref["chapter_idx"] < 1):
            raise ValueError("缺少有效章节引用")
        if kind == "beat" and (not isinstance(ref.get("beat_id"), str) or not ref["beat_id"]):
            raise ValueError("缺少有效节拍引用")
        if "background" in media:
            validate_visual(media["background"])
        events = media.get("events", [])
        if not isinstance(events, list) or len(events) > 32:
            raise ValueError("每个节点最多 32 个演出事件")
        from story_rules import validate_rules
        for event in events:
            if not isinstance(event, dict) or set(event) - {"id", "title", "trigger", "conditions", "repeat", "priority", "actions"}:
                raise ValueError("事件格式无效或含未知字段")
            if not isinstance(event.get("id"), str) or not _ID.fullmatch(event["id"]):
                raise ValueError("事件 ID 无效")
            if "title" in event and (not isinstance(event["title"], str) or len(event["title"]) > 100):
                raise ValueError("事件标题过长或无效")
            trigger = event.get("trigger")
            if not isinstance(trigger, dict) or set(trigger) - {"kind", "choice_key"} or trigger.get("kind") not in ("enter", "choice", "condition"):
                raise ValueError("触发条件格式无效")
            if trigger["kind"] == "choice":
                if kind != "beat" or not isinstance(trigger.get("choice_key"), str) or not re.fullmatch(r"[a-f0-9]{20}", trigger["choice_key"]):
                    raise ValueError("选项事件必须绑定节拍中的有效作者选项")
            elif "choice_key" in trigger:
                raise ValueError("仅选项事件可设置 choice_key")
            validate_rules({"conditions": event.get("conditions", [])})
            if trigger["kind"] == "condition" and not event.get("conditions"):
                raise ValueError("条件变化事件至少需要一个条件")
            if event.get("repeat") not in ("session", "entry"):
                raise ValueError("重复规则应为 session / entry")
            if type(event.get("priority")) is not int or not 0 <= event["priority"] <= 100:
                raise ValueError("事件优先级应为 0–100 的整数")
            actions = event.get("actions")
            if not isinstance(actions, list) or not 1 <= len(actions) <= 8:
                raise ValueError("事件需要 1–8 个演出动作")
            for action in actions:
                if not isinstance(action, dict) or set(action) != {"kind", "visual"} or action["kind"] != "set_visual":
                    raise ValueError("当前仅支持 set_visual；BGM 动作尚未启用")
                validate_visual(action["visual"])
        return []
    except ValueError as exc:
        return [f"节点 {node.get('id', '?')}：{exc}"]


def _scope(node):
    ref = node.get("ref") or {}
    return node["type"], ref.get("chapter_idx"), ref.get("beat_id")


def _matches(node, chapter_idx, beat_id):
    kind, chapter, beat = _scope(node)
    return kind == "plot" or chapter == chapter_idx and (kind == "chapter" or beat == beat_id)


def _condition(session, event):
    roster = session.scene_manager.get_roster()
    for rule in event.get("conditions", []):
        if rule.get("kind") == "stat":
            actor = session.player_identity if rule.get("actor", "player") == "player" else rule["actor"]
            if actor not in roster:
                return False
    from story_rules import evaluate_branch
    return evaluate_branch(session, {"conditions": event.get("conditions", [])})[0]["available"]


def _pin_image(session, owner, asset, project_root):
    from worldbook_content import content_candidates
    candidates = content_candidates(asset, book_ids=[owner], project_root=project_root)
    if not candidates:
        raise ValueError(f"本书缺少演出图片：{asset}")
    path = candidates[0][1]
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 20 * 1024 * 1024:
        raise ValueError(f"演出图片无效或超过 20 MB：{asset}")
    payload = path.read_bytes()
    from PIL import Image
    from io import BytesIO
    try:
        with Image.open(BytesIO(payload)) as image:
            image.verify()
    except Exception as exc:
        raise ValueError(f"图片内容无效：{asset}") from exc
    filename = hashlib.sha256(payload).hexdigest() + path.suffix.lower()
    folder = Path(session.data_dir) / "presentation-assets"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / filename
    if not target.exists():
        target.write_bytes(payload)
    return {"book_id": owner, "file": filename}


def initialize_presentation(session, book_manager):
    """Only after new-session binding/outline initialization; never on restore."""
    from plot_graphs import load_graph, validate_graph
    from worldbook_content import content_candidates
    overlay = session.overlay
    project_root = Path(book_manager._dir).parent.parent if book_manager is not None else None
    plot_id, owner, nodes = overlay.get_plot_id() or "", "", []
    if plot_id and book_manager:
        paths = content_candidates(f"plots/{plot_id}/index.md", book_ids=overlay.get_worldbook_ids(), project_root=project_root)
        owner = paths[0][0] if paths else overlay.get_worldbook_id() or ""
        graph = load_graph(book_manager, owner, plot_id)
        if graph:
            errors = validate_graph(graph)
            if errors:
                raise ValueError("；".join(errors))
            nodes = [{k: copy.deepcopy(n.get(k)) for k in ("id", "type", "ref", "scene_media")}
                     for n in graph["nodes"] if n.get("scene_media")]
    index = overlay._beat_index()
    chapters = overlay._ensure_narrative_beats()
    for node in nodes:
        ref = node.get("ref") or {}
        if node["type"] == "beat" and (ref["beat_id"] not in index or index[ref["beat_id"]][0] + 1 != ref["chapter_idx"]):
            raise ValueError(f"演出绑定节拍不存在或章节不匹配：{ref['beat_id']}")
        if node["type"] == "chapter" and ref["chapter_idx"] > len(chapters):
            raise ValueError("演出绑定章节不存在")
    p = {"plot_id": plot_id, "book_id": owner, "nodes": nodes, "assets": {},
         "runtime": {"anchor": None, "entries": {}, "visual": None, "receipts": {}, "truth": {}, "event_ids": []},
         "frames": {}}
    overlay._data["presentation"] = p
    for node in nodes:
        media = node["scene_media"]
        visuals = [media["background"]] if media.get("background") else []
        visuals += [a["visual"] for e in media.get("events", []) for a in e["actions"]]
        for visual in visuals:
            asset = visual["asset"]
            if asset not in p["assets"]:
                p["assets"][asset] = _pin_image(session, owner, asset, project_root)
        for event in media.get("events", []):
            p["runtime"]["truth"][event["id"]] = _condition(session, event)
            if event["trigger"]["kind"] == "choice":
                from story_rules import rule_key
                beat = next((b for c in chapters for b in c.get("beats", [])
                             if b["id"] == node["ref"]["beat_id"]), {})
                if event["trigger"]["choice_key"] not in {rule_key(b) for b in beat.get("authored_branches", [])}:
                    raise ValueError(f"演出绑定选项已变更：{event.get('title') or event['id']}")
    beat_id = overlay.get_current_beat_id() or ""
    chapter_idx = int(overlay.get_beat_state().get("chapter_idx", 0)) + 1 if beat_id else 0
    apply_presentation(session, chapter_idx=chapter_idx, beat_id=beat_id)
    p["baseline"] = copy.deepcopy(p["runtime"])
    p["frames"]["0"] = _frame(session, 0, chapter_idx, beat_id)
    p["runtime"]["event_ids"] = []
    overlay._save()


def apply_presentation(session, *, chapter_idx, beat_id, choice=None):
    """Mutate the existing overlay draft only; caller owns the save transaction."""
    p = session.overlay._data.get("presentation")
    if not p:
        return
    runtime = p["runtime"]
    prior, anchor = runtime["anchor"], [chapter_idx, beat_id]
    changed = prior != anchor
    source_entries = dict(runtime["entries"])
    active = [n for n in p["nodes"] if _matches(n, chapter_idx, beat_id)]
    entered = [n for n in active if prior is None or n["type"] == "chapter" and prior[0] != chapter_idx
               or n["type"] == "beat" and changed]
    runtime["anchor"] = anchor
    for node in entered:
        runtime["entries"][node["id"]] = runtime["entries"].get(node["id"], 0) + 1

    def display(visual):
        runtime["visual"] = {**copy.deepcopy(visual), **p["assets"][visual["asset"]]}

    for node in sorted(entered, key=lambda n: {"plot": 0, "chapter": 1, "beat": 2}[n["type"]]):
        if node["scene_media"].get("background"):
            display(node["scene_media"]["background"])
    sources = []
    if choice:
        source = choice.get("source_beat_id")
        sources = [n for n in p["nodes"] if n["type"] == "beat" and (n.get("ref") or {}).get("beat_id") == source]
    candidates = {n["id"]: n for n in active + sources}
    events = [(n, e) for n in candidates.values() for e in n["scene_media"].get("events", [])]
    for node, event in sorted(events, key=lambda pair: (pair[1]["priority"], pair[1]["id"])):
        event_id, kind = event["id"], event["trigger"]["kind"]
        truth = _condition(session, event)
        previous_truth = runtime["truth"].get(event_id, truth)
        runtime["truth"][event_id] = truth
        fires = (kind == "enter" and node in entered or kind == "condition" and truth and not previous_truth
                 or kind == "choice" and choice and node in sources and event["trigger"]["choice_key"] == choice.get("rule_key"))
        entry = (source_entries if kind == "choice" else runtime["entries"]).get(node["id"], 0)
        receipt = event_id if event["repeat"] == "session" else f"{event_id}:{entry}"
        if not fires or not truth or receipt in runtime["receipts"]:
            continue
        for action in event["actions"]:
            display(action["visual"])
        runtime["receipts"][receipt] = True
        runtime["event_ids"].append(event_id)
    for node in p["nodes"]:
        if node["id"] not in candidates:
            for event in node["scene_media"].get("events", []):
                runtime["truth"][event["id"]] = _condition(session, event)


def _fallback_background(session):
    from combat_data_loader import CombatDataLoader
    loader = CombatDataLoader(book_ids=session.overlay.get_worldbook_ids())
    bg_id = loader.location_background_id(session.environment.location or "")
    for candidate, source in ((bg_id, "location"), (loader._DEFAULT_BG_ID, "default")):
        if candidate:
            url = loader._session_background_url(Path(session.data_dir), session.id, candidate)
            if url:
                return {"url": url, "source": "session", "bg_id": candidate}
            url = loader.background_image_url(candidate)
            if url:
                return {"url": url, "source": source, "bg_id": candidate}
    return {"url": None, "source": "none", "bg_id": bg_id or loader._DEFAULT_BG_ID}


def _frame(session, round_num, chapter_idx, beat_id):
    runtime = copy.deepcopy(session.overlay._data.get("presentation", {}).get("runtime", {}))
    visual = runtime.get("visual")
    background = _fallback_background(session)
    if visual and background["source"] != "session":
        background = {"url": None, "source": "graph", "bg_id": "",
                      **{k: visual[k] for k in ("fit", "position", "role", "portraits")}}
    return {"runtime": runtime, "background": background,
            "environment": {"location": session.environment.location, "weather": session.environment.weather,
                            "time": session.environment.time_of_day, "atmosphere": list(session.environment.atmosphere or [])},
            "scene_media": {"beat_id": beat_id, "chapter_idx": chapter_idx, "round": round_num,
                            "event_ids": runtime.get("event_ids", []), "visual": visual}}


def record_presentation(session, *, chapter_idx, beat_id):
    overlay = session.overlay
    with overlay._lock:
        before = copy.deepcopy(overlay._data)
        try:
            apply_presentation(session, chapter_idx=chapter_idx, beat_id=beat_id)
            p = overlay._data.get("presentation")
            if p:
                p["frames"][str(session.narration_count + 1)] = _frame(session, session.narration_count + 1, chapter_idx, beat_id)
                p["runtime"]["event_ids"] = []
                p["frames"][str(session.narration_count + 1)]["runtime"]["event_ids"] = []
                overlay._save()
        except Exception:
            overlay._data = before
            raise


def _public_frame(session, frame):
    """Serving URLs belong to the current session ID, including imported copies."""
    frame = copy.deepcopy(frame)
    visual = frame["scene_media"].get("visual")
    if visual:
        filename = visual.get("file")
        if not isinstance(filename, str) or not re.fullmatch(r"[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif|bmp)", filename):
            raise ValueError("该演出帧缺少完整图片引用")
        url = f"/api/sessions/{quote(session.id)}/presentation-assets/{filename}"
        frame["scene_media"]["visual"] = {k: v for k, v in visual.items() if k != "file"}
        frame["scene_media"]["visual"]["url"] = url
        if frame["background"]["source"] == "graph":
            frame["background"]["url"] = url
    elif frame["background"]["source"] == "graph":
        raise ValueError("该演出帧缺少完整图片引用")
    if frame["background"]["source"] == "session" and frame["background"].get("url"):
        frame["background"]["url"] = re.sub(r"^/api/sessions/[^/]+/", f"/api/sessions/{quote(session.id)}/",
                                            frame["background"]["url"])
    return frame


def presentation_frame(session, round_num=None):
    p = session.overlay._data.get("presentation", {})
    frames = p.get("frames", {})
    if round_num is not None:
        if str(round_num) not in frames:
            raise ValueError("该轮没有完整演出快照")
        return _public_frame(session, frames[str(round_num)])
    if session.overlay._data.get("pending_story_choice") and frames:
        return _public_frame(session, frames[str(session.narration_count)])
    beat_id = session.overlay.get_current_beat_id() or ""
    state = session.overlay.get_beat_state()
    return _public_frame(session, _frame(session, session.narration_count, int(state.get("chapter_idx", 0)) + 1 if beat_id else 0, beat_id))


def restore_presentation_round(session, round_num, *, frozen_frame=None):
    p = session.overlay._data.get("presentation")
    if not p:
        return
    frame = frozen_frame if frozen_frame else p.get("frames", {}).get(str(round_num))
    if frame is None:
        raise ValueError("该轮缺少完整演出快照，无法安全回档")
    p["runtime"] = copy.deepcopy(frame["runtime"])
    p["frames"] = {key: value for key, value in p["frames"].items() if int(key) <= round_num}
    p["frames"][str(round_num)] = copy.deepcopy(frame)
    session.overlay._save()
