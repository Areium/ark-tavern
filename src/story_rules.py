"""Author-owned story choices. Models suggest prose; only these rules mutate state."""
from __future__ import annotations

import copy
import hashlib
import json
import math
from functools import wraps

from character_stats import coerce_value, is_valid_stat_key
from session_resources import is_safe_entity_name


class StoryRuleError(ValueError):
    pass


def _scalar(value):
    if not isinstance(value, (str, bool, int, float)):
        return False
    try:
        return not isinstance(value, (int, float)) or isinstance(value, bool) or math.isfinite(value)
    except OverflowError:
        return False


def validate_rules(branch: dict) -> dict:
    """Closed, bounded schema; invalid rules must never silently become free choices."""
    result = {}
    for key in ("conditions", "effects"):
        entries = branch.get(key, [])
        if not isinstance(entries, list) or len(entries) > 16:
            raise StoryRuleError(f"{key} 必须是最多 16 项的数组")
        cleaned = []
        for entry in entries:
            if not isinstance(entry, dict):
                raise StoryRuleError(f"{key} 的每项必须是对象")
            rule = dict(entry)
            kind = rule.get("kind")
            if kind == "item":
                allowed = {"kind", "item_id", "present" if key == "conditions" else "op"}
                if not isinstance(rule.get("item_id"), str) or not is_safe_entity_name(rule["item_id"]):
                    raise StoryRuleError("物品 ID 非法")
                if key == "conditions":
                    rule.setdefault("present", True)
                    if not isinstance(rule["present"], bool):
                        raise StoryRuleError("物品条件 present 必须是布尔值")
                elif rule.get("op") not in ("add", "remove"):
                    raise StoryRuleError("物品效果 op 必须是 add / remove")
            elif kind == "stat":
                allowed = {"kind", "actor", "key", "op", "value"}
                rule.setdefault("actor", "player")
                if not isinstance(rule["actor"], str) or not is_safe_entity_name(rule["actor"]) or not is_valid_stat_key(rule.get("key")):
                    raise StoryRuleError("数值角色或字段名非法")
                ops = ("eq", "ne", "gt", "gte", "lt", "lte") if key == "conditions" else ("set", "add")
                if rule.get("op") not in ops or not _scalar(rule.get("value")):
                    raise StoryRuleError("数值规则操作或值非法（不接受 NaN / Infinity）")
                if rule["op"] in ("gt", "gte", "lt", "lte", "add") and (
                        isinstance(rule["value"], bool) or not isinstance(rule["value"], (int, float))):
                    raise StoryRuleError("比较或增减操作需要有限数字")
            else:
                raise StoryRuleError("规则 kind 必须是 item / stat")
            if set(rule) - allowed:
                raise StoryRuleError("规则含未知字段: " + ", ".join(sorted(set(rule) - allowed)))
            cleaned.append(rule)
        result[key] = cleaned
    return result


def rule_key(branch):
    payload = {k: branch.get(k) for k in ("label", "target_beat_id", "conditions", "effects")}
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:20]


def _stat(session, rule, cache):
    from session_stats import resolve_session_character_stats
    name = session.player_identity if rule["actor"] == "player" else rule["actor"]
    if name not in session.scene_manager.get_roster():
        raise StoryRuleError(f"角色不在当前阵容：{name}")
    if name not in cache:
        cache[name] = copy.deepcopy(resolve_session_character_stats(session, name))
    payload = cache[name]
    field = next((f for f in payload["fields"] if f["key"] == rule["key"]), None)
    if field is None:
        raise StoryRuleError(f"世界书未声明数值字段：{rule['key']}")
    value = payload["values"].get(rule["key"])
    if not _scalar(value):
        raise StoryRuleError(f"数值状态无效：{field['label']}")
    if rule["op"] in ("gt", "gte", "lt", "lte", "add") and field["type"] != "number":
        raise StoryRuleError(f"字段不是数字：{field['label']}")
    expected = rule["value"]
    # Never coerce a boolean to 1 or a string to a number in a branch check.
    if field["type"] == "number":
        valid = isinstance(expected, (int, float)) and not isinstance(expected, bool)
    elif field["type"] == "bool":
        valid = isinstance(expected, bool)
    else:
        valid = isinstance(expected, str)
    if not valid or (rule["op"] != "add" and coerce_value(field, expected) != expected):
        raise StoryRuleError(f"规则值不符合字段类型或范围：{field['label']}")
    return name, field, value


def _item_metadata(session, item_id):
    import frontmatter
    from worldbook_content import content_candidates
    for _, path in content_candidates(f"items/{item_id}/index.md", book_ids=session.overlay.get_worldbook_ids()):
        if path.is_file():
            meta = dict(frontmatter.load(path).metadata)
            meta, _ = session.overlay.apply_item_overrides(item_id, meta, "")
            return {**meta, "id": item_id}
    manager = getattr(session.scene_manager, "_worldbook_manager", None)
    for book_id in session.overlay.get_worldbook_ids():
        book = manager.load(book_id) if manager else None
        if book is None:
            continue
        entry = next((entry for entry in book.entries if entry.uid == item_id
                      and entry.category_id == "items" and entry.enabled), None)
        if entry:
            meta = {"name": entry.name or entry.uid, "description": entry.content,
                    "worldbook_id": book_id}
            meta, _ = session.overlay.apply_item_overrides(item_id, meta, "")
            return {**meta, "id": item_id}
    raise StoryRuleError(f"绑定世界书中不存在物品：{item_id}")


_OPS = {"eq": "=", "ne": "≠", "gt": ">", "gte": "≥", "lt": "<", "lte": "≤"}


def _display(value):
    return ("是" if value else "否") if isinstance(value, bool) else str(value)


def evaluate_branch(session, branch):
    """Read-only preflight and UI explanation. Commit always runs this again."""
    rules = validate_rules(branch)
    items = {i["id"]: copy.deepcopy(i) for i in session.overlay.get_scene_state()["items"]}
    stats, changed, reasons, conditions, effects = {}, {}, [], [], []
    for rule in rules["conditions"]:
        if rule["kind"] == "item":
            item_id = rule["item_id"]
            item = items.get(item_id) or _item_metadata(session, item_id)
            text = ("持有" if rule["present"] else "未持有") + str(item.get("name") or item_id)
            ok = (item_id in items) == rule["present"]
        else:
            name, field, value = _stat(session, rule, stats)
            expected, op = rule["value"], rule["op"]
            text = f"{name} · {field['label']} {_OPS[op]} {_display(expected)}"
            ok = {"eq": lambda: value == expected, "ne": lambda: value != expected,
                  "gt": lambda: value > expected, "gte": lambda: value >= expected,
                  "lt": lambda: value < expected, "lte": lambda: value <= expected}[op]()
        conditions.append(text)
        if not ok:
            reasons.append("需要" + text)
    for rule in rules["effects"]:
        if rule["kind"] == "item":
            item_id = rule["item_id"]
            item = items.get(item_id) or _item_metadata(session, item_id)
            effects.append(("获得" if rule["op"] == "add" else "消耗") + str(item.get("name") or item_id))
            if rule["op"] == "remove":
                if item_id not in items:
                    reasons.append("没有可消耗的物品：" + str(item.get("name") or item_id))
                items.pop(item_id, None)
            else:
                items[item_id] = item
        else:
            name, field, value = _stat(session, rule, stats)
            wanted = value + rule["value"] if rule["op"] == "add" else rule["value"]
            if not _scalar(wanted):
                raise StoryRuleError("数值效果溢出")
            actual = coerce_value(field, wanted)
            stats[name]["values"][field["key"]] = actual
            changed.setdefault(name, {})[field["key"]] = actual
            change = f"{rule['value']:+g}" if rule["op"] == "add" else "设为 " + _display(actual)
            effects.append(f"{name} · {field['label']} {change}")
    return {"available": not reasons, "blocked_reasons": reasons,
            "condition_summary": conditions, "effect_summary": effects}, items, changed


def describe_branch(session, branch):
    try:
        return evaluate_branch(session, branch)[0]
    except (StoryRuleError, TypeError, ValueError) as exc:
        return {"available": False, "blocked_reasons": [f"分支配置无效：{exc}"],
                "condition_summary": [], "effect_summary": []}


def sync_scene_items(session):
    session.scene_manager._scene_items = {
        i["id"]: {k: copy.deepcopy(v) for k, v in i.items() if k != "id"}
        for i in session.overlay.get_scene_state()["items"]}


def settle_branch(session, selected):
    """Validate author identity and commit effects + destination + receipt in ONE replace.

    Generation is separate: on LLM failure the accepted choice remains pending and
    retrying its ID resumes narration without charging again. Rollback restores receipts.
    """
    overlay = session.overlay
    with overlay._lock:
        receipt_id = selected.get("id")
        receipts = overlay._data.get("story_choice_receipts", {})
        if receipt_id in receipts:
            if overlay._data.get("pending_story_choice", {}).get("id") == receipt_id:
                sync_scene_items(session)
                return
            raise StoryRuleError("该选项已结算，请刷新后选择当前分支")
        if selected.get("source_beat_id") != overlay.get_current_beat_id():
            raise StoryRuleError("选项已过期，请刷新当前剧情")
        canonical = next((b for b in overlay.get_authored_branches()
                          if rule_key(b) == selected.get("rule_key")), None)
        if canonical is None:
            raise StoryRuleError("选项不属于当前节拍")
        target = canonical.get("target_beat_id")
        index = overlay._beat_index()
        if target and target not in index:
            raise StoryRuleError("分支落点不存在")
        summary, items, stats = evaluate_branch(session, canonical)
        if not summary["available"]:
            raise StoryRuleError("；".join(summary["blocked_reasons"]))
        before = copy.deepcopy(overlay._data)
        draft = copy.deepcopy(before)
        draft.setdefault("scene", {"characters": [], "active": None})["items"] = list(items.values())
        for name, values in stats.items():
            draft.setdefault("character_stats", {}).setdefault(name, {}).update(values)
        if target and target != overlay.get_current_beat_id():
            bs = draft["beat_state"]
            current = overlay.get_current_beat_id()
            if current not in bs.setdefault("completed_beats", []):
                bs["completed_beats"].append(current)
            bs["chapter_idx"], bs["beat_idx"] = index[target]
            bs["narrations_on_beat"] = 0
            bs.pop("pending_branch", None)
        receipt = {**copy.deepcopy(selected), **summary}
        draft.setdefault("story_choice_receipts", {})[receipt_id] = receipt
        draft["pending_story_choice"] = receipt
        overlay._data = draft
        try:
            from scene_media import apply_presentation
            beat_id = overlay.get_current_beat_id() or ""
            chapter_idx = int(overlay.get_beat_state().get("chapter_idx", 0)) + 1 if beat_id else 0
            apply_presentation(session, chapter_idx=chapter_idx, beat_id=beat_id, choice=selected)
            overlay._save()
        except Exception:
            overlay._data = before
            raise
        sync_scene_items(session)
        # plot_state.md is a derived prompt cache, not the transaction authority.
        try:
            overlay._rewrite_plot_state()
        except OSError:
            import logging
            logging.getLogger(__name__).exception("分支已结算，剧情状态文档待重新生成")


def narration_guard(session_manager):
    """One in-flight narration per session, including the lifetime of an SSE response."""
    def decorate(fn):
        @wraps(fn)
        def wrapped(session_id, *args, **kwargs):
            from shared.helpers import json_error
            session = session_manager.get_session(session_id)
            if not session or not session.overlay:
                return fn(session_id, *args, **kwargs)
            lock = session.overlay._narration_lock
            if not lock.acquire(blocking=False):
                return json_error("本会话正在生成剧情，请稍后重试", 409)
            released = False

            def release():
                nonlocal released
                if not released:
                    released = True
                    lock.release()
            try:
                response = fn(session_id, *args, **kwargs)
                if getattr(response, "is_streamed", False):
                    original = response.response

                    def stream():
                        try:
                            yield from original
                        finally:
                            if hasattr(original, "close"):
                                original.close()
                            release()
                    response.response = stream()
                    response.call_on_close(release)
                else:
                    release()
                return response
            except BaseException:
                release()
                raise
        return wrapped
    return decorate
