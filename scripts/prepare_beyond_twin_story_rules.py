"""Prepare Beyond Twin's item choices without touching a live book by default.

Usage: python scripts/prepare_beyond_twin_story_rules.py PATH/TO/book.json
       ... --output NEW_CANDIDATE.json   # exclusive creation, never overwrites
       ... --apply                       # backup, SHA-256 recheck, atomic replace

prepare_book is a pure, idempotent transformation. The CLI does not load managers,
install books, edit companion documents, assign character identities, or call a
running service. Apply requires a saved-work window: the final hash check detects
changes before replacement, but is not an OS-level compare-and-swap against an
uncooperative writer in the tiny check/replace interval.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile


BOOK_ID = "beyond-twin"
OUTLINE_UID = "story_outline_beyond_twin"
TERMINAL_UID = "items_Agent终端"
CAT_UID = "items_黑猫玩偶"
LOG_KEY = "bt_device_logs_saved"
STAT_FIELD = {
    "key": LOG_KEY,
    "label": "病中设备日志已留存",
    "type": "bool",
    "default": False,
    "group": "剧情记录",
    "description": "记录主控是否在妮可病中保存设备日志；不代表已确认异常原因或人格身份。",
}

COMFORT_LABEL = "把黑猫玩偶放到她手边，留下来照顾她"
LOG_LABEL = "保存终端唤醒记录，与病中设备日志对照"
MEMORY_LABEL = "先保存本地证据，再问起抓到黑猫玩偶的下午"
CRITICAL_BEATS = ("beat_act2_mall", "beat_act5_fever", "beat_act6_truth", "beat_act7_echo")

ITEM_NOTES = {
    TERMINAL_UID: (
        "# 剧情机制：Agent终端\n\n"
        "物品标识：items_Agent终端。完成‘从未打过的电话’到‘无人输入的问好’的选择转场后，"
        "随三周后回到公司工位登记终端可用；不是把企业设备变成随身道具，也不在开局凭空发放。\n\n"
        "终端与已留存的病中设备日志共同开启唤醒记录、输入来源和时间戳对照路线；"
        "终端与黑猫玩偶共同开启以抓娃娃的下午为线索的记忆核验路线。"
        "核验只提供观察和证据，不证明妮可完整上传，不突破企业账号、网络策略或安全审计。"
        "终端不会因普通调查被消耗，原有回应、追查、联系林奈和寻找载体路线均不以持有物品为门槛。"
    ),
    CAT_UID: (
        "# 剧情机制：黑猫玩偶\n\n"
        "物品标识：items_黑猫玩偶。商场获得玩偶的节拍完成选择后登记为可使用的共同场景物品，"
        "仍由妮可抱着，不意味着主控夺走她的所有权；开局不持有。\n\n"
        "持有时可在病中把玩偶放到妮可手边安抚她，或在终端前以共同生活细节试探人格连续性。"
        "它不是退烧药，不消除高烧或记忆缺口；没有默认芯片、存储、通信或灵魂载体功能。"
        "安抚和回忆不消耗玩偶；若已经丢弃或遗失，终幕只可回忆它，不强制它重新出现在显示器旁。"
        "所有基础推进路线保持无物品门槛。"
    ),
}
ECHO_GUIDANCE = (
    "以当前物品状态为准：仅持有黑猫玩偶时描写它在显示器旁；已丢弃或遗失时只回忆共同生活，"
    "不补发、不暗示它仍在场。终端问候及全部基础续写路线不因缺少玩偶或日志而阻断。"
)
WEEKEND_OLD = "当作自己和黑猫玩偶的窝"
WEEKEND_NEW = "当作自己的窝"
ECHO_REPLACEMENTS = {
    "content": (
        "妮可留下的黑猫玩偶放在显示器旁",
        "若仍持有妮可留下的黑猫玩偶，它放在显示器旁；若已丢弃或遗失，程叙只回忆那个共同度过的下午",
    ),
    "must_keep": (
        "黑猫玩偶放在显示器旁",
        "仅仍持有黑猫玩偶时它才在显示器旁；未持有时以共同生活的回忆承接，不强制实物出现",
    ),
}
_FENCE = re.compile(
    r"(?m)^```json[ \t]+story-outline[ \t]*\r?\n(?P<payload>[\s\S]*?)\r?\n```[ \t]*\r?$"
)


class PreparationError(ValueError):
    """Source content or user customizations cannot be changed unambiguously."""


def _same_json(left, right) -> bool:
    # Python equality conflates True and 1; the engine deliberately does not.
    return (json.dumps(left, sort_keys=True, allow_nan=False)
            == json.dumps(right, sort_keys=True, allow_nan=False))


def _unique(rows: list, key: str, value: str, context: str) -> dict:
    matches = [row for row in rows if isinstance(row, dict) and row.get(key) == value]
    if len(matches) != 1:
        raise PreparationError(f"{context}: expected exactly one {key}={value!r}, found {len(matches)}")
    return matches[0]


def _read_outline(entry: dict) -> tuple[dict, re.Match]:
    content = entry.get("content")
    matches = list(_FENCE.finditer(content)) if isinstance(content, str) else []
    if len(matches) != 1:
        raise PreparationError("outline must contain exactly one json story-outline fence")
    try:
        outline = json.loads(matches[0].group("payload"))
    except ValueError as exc:
        raise PreparationError(f"invalid outline JSON: {exc}") from exc
    if not isinstance(outline, dict) or outline.get("plot_id") != "beyond_twin":
        raise PreparationError("outline plot_id must be beyond_twin")
    return outline, matches[0]


def _beats(outline: dict) -> dict[str, dict]:
    chapters = outline.get("chapters")
    if not isinstance(chapters, list):
        raise PreparationError("outline chapters must be a list")
    result = {}
    for chapter in chapters:
        if not isinstance(chapter, dict) or not isinstance(chapter.get("beats"), list):
            raise PreparationError("each chapter must have a beats list")
        for beat in chapter["beats"]:
            if not isinstance(beat, dict) or not isinstance(beat.get("id"), str) or not beat["id"]:
                raise PreparationError("each beat must have a nonempty string id")
            if beat["id"] in result:
                raise PreparationError(f"duplicate beat id: {beat['id']}")
            if not isinstance(beat.get("branches"), list):
                raise PreparationError(f"{beat['id']}: branches must be a list")
            result[beat["id"]] = beat
    return result


def _baseline(beat: dict, label: str, target: str, effects: list | None = None) -> dict:
    branch = _unique(beat["branches"], "label", label, beat["id"])
    if branch.get("target_beat_id") != target:
        raise PreparationError(f"{beat['id']}/{label}: unexpected target_beat_id")
    # Never erase a user's condition/effect to manufacture a free route. A conflict
    # needs deliberate author review, not an automatic overwrite or unsafe merge.
    expected = effects or []
    for key, wanted in (("conditions", []), ("effects", expected)):
        present = branch.get(key, [])
        if not isinstance(present, list) or (present and not _same_json(present, wanted)):
            raise PreparationError(f"{beat['id']}/{label}: conflicting {key}")
    if expected:
        branch["effects"] = copy.deepcopy(expected)
    return branch


def _append_choice(beat: dict, branch: dict) -> None:
    matches = [b for b in beat["branches"] if isinstance(b, dict) and b.get("label") == branch["label"]]
    if not matches:
        beat["branches"].append(copy.deepcopy(branch))
        return
    if len(matches) != 1 or any(not _same_json(matches[0].get(k), v) for k, v in branch.items()):
        raise PreparationError(f"{beat['id']}/{branch['label']}: conflicting existing special choice")
    # Extra user properties (including IDs/media) on an already prepared choice survive.


def _stat_field(book: dict) -> None:
    fields = book.setdefault("stat_fields", [])
    if not isinstance(fields, list) or not all(isinstance(f, dict) for f in fields):
        raise PreparationError("stat_fields must be a list of objects")
    if len(fields) > 64:
        raise PreparationError("stat_fields exceeds the engine limit of 64 fields")
    matches = [f for f in fields if str(f.get("key", "")).strip() == LOG_KEY]
    if len(matches) > 1:
        raise PreparationError(f"duplicate stat_fields key: {LOG_KEY}")
    if matches:
        field = matches[0]
        if (str(field.get("type", "")).strip().lower() != "bool"
                or ("default" in field and not isinstance(field["default"], bool))):
            raise PreparationError(f"incompatible stat_fields definition: {LOG_KEY} requires bool")
        return  # Preserve the user's label, default (including True), and extra metadata.
    if len(fields) >= 64:
        raise PreparationError("cannot append log field: stat_fields already has 64 fields")
    fields.append(copy.deepcopy(STAT_FIELD))


def _append_text(entry: dict, addition: str) -> None:
    text = entry.get("content")
    if not isinstance(text, str):
        raise PreparationError(f"{entry.get('uid')}: content must be text")
    heading = addition.splitlines()[0]
    if heading in text:
        if text.count(heading) != 1 or addition not in text:
            raise PreparationError(f"{entry.get('uid')}: conflicting mechanism note")
    else:
        entry["content"] = text + "\n\n" + addition


def _replace_text(beat: dict, key: str, old: str, new: str) -> None:
    text = beat.get(key)
    if not isinstance(text, str):
        raise PreparationError(f"{beat['id']}: missing {key} text")
    if new in text:
        if text.count(new) != 1 or old in text:
            raise PreparationError(f"{beat['id']}/{key}: conflicting old and prepared text")
        return
    if text.count(old) != 1:
        raise PreparationError(f"{beat['id']}/{key}: expected source text missing or ambiguous")
    beat[key] = text.replace(old, new, 1)


def prepare_book(book: dict) -> dict:
    """Return a detached candidate; fail closed on missing anchors or conflicts."""
    if not isinstance(book, dict) or book.get("id") != BOOK_ID:
        raise PreparationError("book id must be beyond-twin")
    prepared = copy.deepcopy(book)
    entries = prepared.get("entries")
    if not isinstance(entries, list):
        raise PreparationError("book entries must be a list")
    entry_ids = set()
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("uid"), str) or not entry["uid"]:
            raise PreparationError("each book entry must have a nonempty string uid")
        if entry["uid"] in entry_ids:
            raise PreparationError(f"duplicate book entry uid: {entry['uid']}")
        entry_ids.add(entry["uid"])
    outline_entry = _unique(entries, "uid", OUTLINE_UID, "book entries")
    outline, fence = _read_outline(outline_entry)
    before_outline = copy.deepcopy(outline)
    beats = _beats(outline)
    required = (*CRITICAL_BEATS, "beat_act2_weekend", "beat_act3_bill", "beat_act5_gap",
                "beat_branch_respond", "beat_branch_investigate", "beat_branch_linnai", "beat_branch_home")
    for bid in required:
        if bid not in beats:
            raise PreparationError(f"expected source/target beat missing: {bid}")

    _stat_field(prepared)
    for uid, note in ITEM_NOTES.items():
        _append_text(_unique(entries, "uid", uid, "book entries"), note)

    _baseline(beats["beat_act2_mall"], "把下午浪费掉", "beat_act3_bill",
              [{"kind": "item", "item_id": CAT_UID, "op": "add"}])
    _baseline(beats["beat_act5_fever"], "留下来照顾她", "beat_act5_gap")
    _baseline(beats["beat_act5_fever"], "保存设备日志", "beat_act5_gap",
              [{"kind": "stat", "actor": "player", "key": LOG_KEY, "op": "set", "value": True}])
    _baseline(beats["beat_act6_truth"], "保留黑猫玩偶", "beat_act7_echo",
              [{"kind": "item", "item_id": TERMINAL_UID, "op": "add"}])
    for label, target in (("谨慎回应终端", "beat_branch_respond"),
                          ("追查澜晶", "beat_branch_investigate"),
                          ("重新联系林奈", "beat_branch_linnai"),
                          ("为她寻找载体", "beat_branch_home")):
        _baseline(beats["beat_act7_echo"], label, target)

    has_cat = {"kind": "item", "item_id": CAT_UID, "present": True}
    has_terminal = {"kind": "item", "item_id": TERMINAL_UID, "present": True}
    _append_choice(beats["beat_act5_fever"], {
        "label": COMFORT_LABEL, "intent": "用熟悉的玩偶安抚，不消除病情",
        "target_beat_id": "beat_act5_gap", "conditions": [has_cat], "effects": [],
    })
    _append_choice(beats["beat_act7_echo"], {
        "label": LOG_LABEL, "intent": "核对来源与时间戳，不宣布真相",
        "target_beat_id": "beat_branch_investigate",
        "conditions": [has_terminal,
                       {"kind": "stat", "actor": "player", "key": LOG_KEY, "op": "eq", "value": True}],
        "effects": [],
    })
    _append_choice(beats["beat_act7_echo"], {
        "label": MEMORY_LABEL, "intent": "保存证据后以共同经历试探连续性",
        "target_beat_id": "beat_branch_respond", "conditions": [has_terminal, has_cat], "effects": [],
    })
    for bid in CRITICAL_BEATS:
        beats[bid]["choice_required"] = True

    _replace_text(beats["beat_act2_weekend"], "content", WEEKEND_OLD, WEEKEND_NEW)
    for key, (old, new) in ECHO_REPLACEMENTS.items():
        _replace_text(beats["beat_act7_echo"], key, old, new)
    echo = beats["beat_act7_echo"]
    guidance = echo.get("guidance", "")
    if not isinstance(guidance, str):
        raise PreparationError("beat_act7_echo: guidance must be text")
    if ECHO_GUIDANCE not in guidance:
        echo["guidance"] = guidance + "\n\n" + ECHO_GUIDANCE
    # That existing option remains free even after discarding the toy. Its label
    # is retained as an author anchor, but narration must not secretly re-grant it.
    truth = beats["beat_act6_truth"]
    truth_note = "‘保留黑猫玩偶’选项无持有门槛；若已经丢弃或遗失，保留的是共同生活的记忆，不重新获得玩偶。"
    guidance = truth.get("guidance", "")
    if not isinstance(guidance, str):
        raise PreparationError("beat_act6_truth: guidance must be text")
    if truth_note not in guidance:
        truth["guidance"] = guidance + "\n\n" + truth_note

    if outline != before_outline:
        text = outline_entry["content"]
        payload = json.dumps(outline, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        outline_entry["content"] = text[:fence.start("payload")] + payload + text[fence.end("payload"):]
    return prepared


def diff_summary(before: dict, after: dict) -> dict:
    """Small semantic diff: never dump cover images or the entire user's prose."""
    changed = [key for key in dict.fromkeys([*before, *after]) if before.get(key) != after.get(key)]
    old_entries = {e["uid"]: e for e in before["entries"]}
    changed_entries = [e["uid"] for e in after["entries"] if e != old_entries.get(e["uid"])]
    old_beats = _beats(_read_outline(old_entries[OUTLINE_UID])[0])
    new_beats = _beats(_read_outline(_unique(after["entries"], "uid", OUTLINE_UID, "book"))[0])
    return {
        "changed": before != after,
        "changed_top_level_keys": changed,
        "changed_entry_uids": changed_entries,
        "changed_beat_ids": [bid for bid, beat in new_beats.items() if beat != old_beats.get(bid)],
        "added_choices": sum(len(b["branches"]) - len(old_beats[bid]["branches"]) for bid, b in new_beats.items()),
        "stat_field_added": len(after.get("stat_fields", [])) > len(before.get("stat_fields", [])),
    }


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _assert_unchanged(path: Path, expected: str) -> None:
    if path.is_symlink() or _sha256(path.read_bytes()) != expected:
        raise PreparationError("book changed since read (SHA-256 mismatch); refusing to overwrite")


def _write_new(path: Path, raw: bytes) -> None:
    with path.open("xb") as stream:
        try:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            stream.close()
            path.unlink()  # Only our just-created partial file; never an existing file.
            raise


def apply_prepared(path: Path, original: bytes, prepared: bytes) -> Path:
    """Backup the exact read snapshot, recheck SHA-256, then replace in one operation."""
    expected = _sha256(original)
    _assert_unchanged(path, expected)
    # Both files are on the destination filesystem. Unique names do not overwrite
    # an older backup, and any pre-replace failure leaves the source untouched.
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=f"{path.name}.{expected[:12]}.",
                                     suffix=".bak", delete=False) as backup:
        backup_path = Path(backup.name)
        backup.write(original)
        backup.flush()
        os.fsync(backup.fileno())
    pending_path = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}.story-rules.",
                                         suffix=".tmp", delete=False) as pending:
            pending_path = Path(pending.name)
            pending.write(prepared)
            pending.flush()
            os.fsync(pending.fileno())
        shutil.copymode(path, pending_path)
        _assert_unchanged(path, expected)
        os.replace(pending_path, path)
    except (OSError, PreparationError) as exc:
        raise PreparationError(f"apply aborted; original snapshot backup: {backup_path}; {exc}") from exc
    finally:
        if pending_path is not None and pending_path.exists():
            pending_path.unlink()
    return backup_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("book", type=Path, help="explicit source book.json path")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true", help="back up and replace source after SHA-256 check")
    mode.add_argument("--output", type=Path, help="write a NEW candidate file only; refuse existing paths")
    args = parser.parse_args(argv)
    try:
        if args.book.is_symlink():
            raise PreparationError("source book must not be a symlink")
        path = args.book.resolve(strict=True)
        original = path.read_bytes()
        before = json.loads(original.decode("utf-8-sig"))
        after = prepare_book(before)
        summary = {"mode": "apply" if args.apply else "candidate" if args.output else "dry-run",
                   "source": str(path), "source_sha256": _sha256(original), **diff_summary(before, after)}
        serialized = (json.dumps(after, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
        if args.output:
            if args.output.is_symlink():
                raise PreparationError("candidate output must not be a symlink")
            output = args.output.resolve()
            if output == path:
                raise PreparationError("candidate output must not be the source book")
            _write_new(output, serialized)
            summary["candidate"] = str(output)
        elif args.apply and summary["changed"]:
            summary["backup"] = str(apply_prepared(path, original, serialized))
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, TypeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
