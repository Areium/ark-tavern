"""Synthetic content and file-safety tests; never read/write an installed user book."""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "src"))

import prepare_beyond_twin_story_rules as rules
from story_rules import validate_rules
from story_outline import normalize_outline, outline_to_beats


def _branch(label, target):
    return {"label": label, "intent": "原有意图", "target_beat_id": target,
            "id": f"author-{label}", "media": {"user": "retained"}}


@pytest.fixture
def book():
    routing = {
        "beat_act2_weekend": [("带她出门逛逛", "beat_act2_mall")],
        "beat_act2_mall": [("把下午浪费掉", "beat_act3_bill")],
        "beat_act3_bill": [("继续", "beat_act5_fever")],
        "beat_act5_fever": [("留下来照顾她", "beat_act5_gap"), ("保存设备日志", "beat_act5_gap")],
        "beat_act5_gap": [("继续", "beat_act6_truth")],
        "beat_act6_truth": [("保留黑猫玩偶", "beat_act7_echo")],
        "beat_act7_echo": [("谨慎回应终端", "beat_branch_respond"),
                           ("追查澜晶", "beat_branch_investigate"),
                           ("重新联系林奈", "beat_branch_linnai"),
                           ("为她寻找载体", "beat_branch_home")],
        "beat_branch_respond": [], "beat_branch_investigate": [],
        "beat_branch_linnai": [], "beat_branch_home": [],
    }
    beats = [{"id": bid, "title": bid, "content": "用户正文", "must_keep": "原有护栏",
              "guidance": "原有指引", "min_rounds": 2,
              "scene_media": {"background": "user-bg", "cg": "user-cg"},
              "branches": [_branch(label, target) for label, target in routes]}
             for bid, routes in routing.items()]
    by_id = {b["id"]: b for b in beats}
    by_id["beat_act2_weekend"]["content"] = "她垫上毯子，当作自己和黑猫玩偶的窝。"
    by_id["beat_act7_echo"]["content"] = "三周后，妮可留下的黑猫玩偶放在显示器旁，终端主动问好。"
    by_id["beat_act7_echo"]["must_keep"] = "空办公室；黑猫玩偶放在显示器旁；终端无人输入时问好。"
    outline = {"plot_id": "beyond_twin", "worldbook_id": "beyond-twin", "schema_version": 1,
               "title": "彼岸双生", "source": "llm", "custom": {"keep": True},
               "chapters": [{"id": "original-chapter", "title": "保留章节", "beats": beats,
                             "scene_media": {"background": "chapter-bg"}}]}
    return {"id": "beyond-twin", "name": "用户书名", "edit_revision": 19,
            "cover_image": "data:image/png;base64,DO_NOT_DUMP", "character_stats": {"妮可": {"custom": 7}},
            "stat_fields": [{"key": "user_field", "label": "用户字段", "type": "text", "default": "不改"}],
            "entries": [
                {"uid": rules.TERMINAL_UID, "content": "终端原始正文\n含企业账号和权限边界。\n", "enabled": True},
                {"uid": rules.CAT_UID, "content": "玩偶原始正文\n默认没有芯片或超自然能力。\n", "enabled": True},
                {"uid": rules.OUTLINE_UID, "content": "用户前言\n```json story-outline\n"
                 + json.dumps(outline, ensure_ascii=False) + "\n```\n用户后记", "raw": {"keep": "yes"}},
                {"uid": "plot_graph_beyond_twin", "content": "旧身份图不得修复", "user_layout": [1, 2]},
                {"uid": "characters_妮可_index", "content": "角色原文"},
            ]}


def _entry(book, uid):
    return next(e for e in book["entries"] if e["uid"] == uid)


def _outline(book):
    return rules._read_outline(_entry(book, rules.OUTLINE_UID))[0]


def _beats(book):
    return rules._beats(_outline(book))


def _choice(book, bid, label):
    return next(b for b in _beats(book)[bid]["branches"] if b["label"] == label)


def _alter_outline(book, transform):
    outline = _outline(book)
    transform(outline)
    _entry(book, rules.OUTLINE_UID)["content"] = "```json story-outline\n" + json.dumps(outline, ensure_ascii=False) + "\n```"


def test_pure_idempotent_preserves_ids_branches_media_and_user_content(book):
    before = copy.deepcopy(book)
    prepared = rules.prepare_book(book)
    assert book == before
    assert rules.prepare_book(prepared) == prepared
    assert prepared is not book and prepared["entries"] is not book["entries"]
    assert prepared["stat_fields"][:-1] == book["stat_fields"]
    assert prepared["stat_fields"][-1] == rules.STAT_FIELD
    assert prepared["character_stats"] == book["character_stats"]
    assert prepared["edit_revision"] == 19
    assert _entry(prepared, "plot_graph_beyond_twin") == _entry(book, "plot_graph_beyond_twin")
    assert _entry(prepared, "characters_妮可_index") == _entry(book, "characters_妮可_index")
    assert _outline(prepared)["chapters"][0]["id"] == "original-chapter"
    assert _outline(prepared)["chapters"][0]["scene_media"] == {"background": "chapter-bg"}
    assert list(_beats(prepared)) == list(_beats(book))
    for bid, old in _beats(book).items():
        new = _beats(prepared)[bid]
        assert new["scene_media"] == old["scene_media"]
        assert new["min_rounds"] == old["min_rounds"]
        for index, branch in enumerate(old["branches"]):
            assert all(new["branches"][index][k] == v for k, v in branch.items())
    for uid, note in rules.ITEM_NOTES.items():
        assert _entry(prepared, uid)["content"] == _entry(book, uid)["content"] + "\n\n" + note
    encoded = _entry(prepared, rules.OUTLINE_UID)["content"]
    assert encoded.startswith("用户前言\n") and encoded.endswith("\n用户后记")
    prepared["stat_fields"][0]["default"] = "changed"
    assert book == before


def test_mechanics_and_engine_schema_survive_outline_normalization(book):
    prepared = rules.prepare_book(book)
    beats = _beats(prepared)
    assert len(beats["beat_act5_fever"]["branches"]) == 3
    assert len(beats["beat_act7_echo"]["branches"]) == 6
    assert _choice(prepared, "beat_act2_mall", "把下午浪费掉")["effects"] == [
        {"kind": "item", "item_id": rules.CAT_UID, "op": "add"}]
    assert _choice(prepared, "beat_act5_fever", "保存设备日志")["effects"] == [
        {"kind": "stat", "actor": "player", "key": rules.LOG_KEY, "op": "set", "value": True}]
    assert _choice(prepared, "beat_act6_truth", "保留黑猫玩偶")["effects"] == [
        {"kind": "item", "item_id": rules.TERMINAL_UID, "op": "add"}]
    for bid, beat in beats.items():
        assert (beat.get("choice_required") is True) == (bid in rules.CRITICAL_BEATS)
        for branch in beat["branches"]:
            checked = validate_rules(branch)
            assert checked == {k: branch.get(k, []) for k in ("conditions", "effects")}
            for rule in checked["conditions"] + checked["effects"]:
                assert "quantity" not in rule
                if rule["kind"] == "stat":
                    assert rule["actor"] == "player" and rule["value"] is True
    normalized = normalize_outline(_outline(prepared))
    runtime_beats = {b["id"]: b for ch in outline_to_beats(normalized) for b in ch["beats"]}
    for bid in rules.CRITICAL_BEATS:
        assert runtime_beats[bid]["choice_required"] is True
        assert len(runtime_beats[bid]["authored_branches"]) == len(beats[bid]["branches"])
        for got, expected in zip(runtime_beats[bid]["authored_branches"], beats[bid]["branches"]):
            assert got["label"] == expected["label"]  # No truncation changes identity.
            assert got["conditions"] == expected.get("conditions", [])
            assert got["effects"] == expected.get("effects", [])


@pytest.mark.parametrize("items", [set(), {rules.CAT_UID}, {rules.TERMINAL_UID}, {rules.CAT_UID, rules.TERMINAL_UID}])
@pytest.mark.parametrize("saved", [False, True])
def test_all_and_conditions_and_free_fallbacks(book, items, saved):
    prepared = rules.prepare_book(book)

    def available(branch):
        return all((r["item_id"] in items) == r["present"] if r["kind"] == "item"
                   else saved is r["value"] for r in branch.get("conditions", []))

    assert available(_choice(prepared, "beat_act5_fever", rules.COMFORT_LABEL)) == (rules.CAT_UID in items)
    assert available(_choice(prepared, "beat_act7_echo", rules.LOG_LABEL)) == (rules.TERMINAL_UID in items and saved)
    assert available(_choice(prepared, "beat_act7_echo", rules.MEMORY_LABEL)) == (
        rules.CAT_UID in items and rules.TERMINAL_UID in items)
    for bid in rules.CRITICAL_BEATS:
        assert any(available(branch) for branch in _beats(prepared)[bid]["branches"])
    for branch in _beats(prepared)["beat_act7_echo"]["branches"][:4]:
        assert not branch.get("conditions") and not branch.get("effects")


def test_no_early_toy_or_forced_return_and_no_invented_character_identity(book):
    prepared = rules.prepare_book(book)
    beats = _beats(prepared)
    assert "黑猫玩偶" not in beats["beat_act2_weekend"]["content"]
    assert "若已丢弃或遗失" in beats["beat_act7_echo"]["content"]
    assert "未持有时" in beats["beat_act7_echo"]["must_keep"]
    assert "不重新获得玩偶" in beats["beat_act6_truth"]["guidance"]
    assert "不补发" in beats["beat_act7_echo"]["guidance"]
    assert set(prepared) == set(book)  # Only root schema changed, not roster/identity metadata.
    assert "initial_scene_items" not in prepared
    cat_grants = [(bid, r) for bid, b in beats.items() for choice in b["branches"]
                  for r in choice.get("effects", []) if r.get("item_id") == rules.CAT_UID]
    assert [bid for bid, _ in cat_grants] == ["beat_act2_mall"]


@pytest.mark.parametrize("field", [
    {"key": rules.LOG_KEY, "type": "bool", "default": True, "label": "用户标签", "custom": "keep"},
    {"key": rules.LOG_KEY, "type": "bool"},
    {"key": rules.LOG_KEY, "type": "BOOL", "default": False},
])
def test_compatible_field_is_preserved_verbatim(book, field):
    book["stat_fields"].append(field)
    prepared = rules.prepare_book(book)
    assert prepared["stat_fields"] == book["stat_fields"]
    assert rules.prepare_book(prepared) == prepared


@pytest.mark.parametrize("field", [
    {"key": rules.LOG_KEY, "type": "number", "default": 0},
    {"key": rules.LOG_KEY, "type": "text", "default": "false"},
    {"key": rules.LOG_KEY, "type": "bool", "default": "false"},
    {"key": rules.LOG_KEY, "type": "bool", "default": 0},
    {"key": rules.LOG_KEY, "type": "bool", "default": None},
    {"key": rules.LOG_KEY},
])
def test_incompatible_field_fails_without_mutation(book, field):
    book["stat_fields"].append(field)
    before = copy.deepcopy(book)
    with pytest.raises(rules.PreparationError, match="incompatible stat_fields"):
        rules.prepare_book(book)
    assert book == before


def test_missing_stat_fields_added_and_duplicate_or_full_schema_rejected(book):
    del book["stat_fields"]
    assert rules.prepare_book(book)["stat_fields"] == [rules.STAT_FIELD]
    book["stat_fields"] = [dict(rules.STAT_FIELD), dict(rules.STAT_FIELD)]
    with pytest.raises(rules.PreparationError, match="duplicate"):
        rules.prepare_book(book)
    book["stat_fields"] = [{"key": f"custom_{n}", "type": "bool"} for n in range(64)]
    with pytest.raises(rules.PreparationError, match="64"):
        rules.prepare_book(book)
    book["stat_fields"].append(dict(rules.STAT_FIELD))
    with pytest.raises(rules.PreparationError, match="64"):
        rules.prepare_book(book)


@pytest.mark.parametrize("entry", [None, {"content": "no uid"}, {"uid": rules.CAT_UID, "content": "duplicate"}])
def test_malformed_or_duplicate_entries_fail_closed(book, entry):
    book["entries"].append(entry)
    with pytest.raises(rules.PreparationError):
        rules.prepare_book(book)


def test_mixed_old_and_prepared_text_is_not_silently_accepted(book):
    prepared = rules.prepare_book(book)
    _alter_outline(prepared, lambda o: rules._beats(o)["beat_act2_weekend"].update(
        content=rules.WEEKEND_NEW + "。" + rules.WEEKEND_OLD))
    with pytest.raises(rules.PreparationError, match="conflicting old and prepared text"):
        rules.prepare_book(prepared)


@pytest.mark.parametrize("bid", [*rules.CRITICAL_BEATS, "beat_act2_weekend", "beat_branch_home"])
def test_missing_expected_source_or_target_rejected(book, bid):
    _alter_outline(book, lambda o: o["chapters"][0].update(
        beats=[b for b in o["chapters"][0]["beats"] if b["id"] != bid]))
    with pytest.raises(rules.PreparationError, match="missing"):
        rules.prepare_book(book)


@pytest.mark.parametrize("bid,label", [
    ("beat_act2_mall", "把下午浪费掉"), ("beat_act5_fever", "保存设备日志"),
    ("beat_act5_fever", "留下来照顾她"), ("beat_act6_truth", "保留黑猫玩偶"),
    ("beat_act7_echo", "谨慎回应终端"), ("beat_act7_echo", "追查澜晶"),
    ("beat_act7_echo", "重新联系林奈"), ("beat_act7_echo", "为她寻找载体"),
])
def test_missing_expected_label_rejected(book, bid, label):
    def change(outline):
        beat = rules._beats(outline)[bid]
        beat["branches"] = [b for b in beat["branches"] if b["label"] != label]
    _alter_outline(book, change)
    with pytest.raises(rules.PreparationError, match="expected exactly one"):
        rules.prepare_book(book)


def test_wrong_targets_duplicate_labels_and_user_rules_fail_closed(book):
    for change in (
        lambda b: b["branches"][0].update(target_beat_id="beat_branch_home"),
        lambda b: b["branches"].append(copy.deepcopy(b["branches"][0])),
        lambda b: b["branches"][0].update(conditions=[{"kind": "item", "item_id": "user-item", "present": True}]),
        lambda b: b["branches"][0].update(effects=[{"kind": "item", "item_id": "user-item", "op": "remove"}]),
    ):
        candidate = copy.deepcopy(book)
        _alter_outline(candidate, lambda o: change(rules._beats(o)["beat_act2_mall"]))
        original = copy.deepcopy(candidate)
        with pytest.raises(rules.PreparationError):
            rules.prepare_book(candidate)
        assert candidate == original


def test_existing_special_choice_preserves_extras_but_rejects_numeric_boolean(book):
    prepared = rules.prepare_book(book)
    def extra(outline):
        choice = rules._beats(outline)["beat_act5_fever"]["branches"][-1]
        choice["id"] = "user-added-id"
        choice["media"] = {"cg": "retained"}
    _alter_outline(prepared, extra)
    assert rules.prepare_book(prepared) == prepared
    def incompatible(outline):
        rules._beats(outline)["beat_act5_fever"]["branches"][-1]["conditions"][0]["present"] = 1
    _alter_outline(prepared, incompatible)
    with pytest.raises(rules.PreparationError, match="conflicting existing"):
        rules.prepare_book(prepared)


@pytest.mark.parametrize("damage", ["book-id", "outline-entry", "item-entry", "fence", "text", "mechanism-note"])
def test_missing_or_ambiguous_content_is_not_guessed(book, damage):
    if damage == "book-id":
        book["id"] = "another-book"
    elif damage in ("outline-entry", "item-entry"):
        uid = rules.OUTLINE_UID if damage == "outline-entry" else rules.CAT_UID
        book["entries"] = [e for e in book["entries"] if e["uid"] != uid]
    elif damage == "fence":
        _entry(book, rules.OUTLINE_UID)["content"] *= 2
    elif damage == "text":
        _alter_outline(book, lambda o: rules._beats(o)["beat_act2_weekend"].update(content="用户完全改写"))
    else:
        _entry(book, rules.CAT_UID)["content"] += "\n# 剧情机制：黑猫玩偶\n用户机制"
    with pytest.raises(rules.PreparationError):
        rules.prepare_book(book)


def _write_fixture(path, book):
    raw = b"\xef\xbb\xbf" + json.dumps(book, ensure_ascii=False, indent=2).replace("\n", "\r\n").encode("utf-8")
    path.write_bytes(raw)
    return raw


def test_cli_default_dry_run_is_read_only_and_outputs_small_diff(book, tmp_path, capsys):
    source = tmp_path / "book.json"
    original = _write_fixture(source, book)
    assert rules.main([str(source)]) == 0
    summary = json.loads(capsys.readouterr().out)
    assert summary["mode"] == "dry-run"
    assert summary["source_sha256"] == hashlib.sha256(original).hexdigest()
    assert summary["added_choices"] == 3
    assert summary["changed_entry_uids"] == [rules.TERMINAL_UID, rules.CAT_UID, rules.OUTLINE_UID]
    assert summary["stat_field_added"] is True
    assert source.read_bytes() == original
    assert list(tmp_path.iterdir()) == [source]
    assert "DO_NOT_DUMP" not in json.dumps(summary)


def test_cli_candidate_is_exclusive_and_does_not_modify_source(book, tmp_path, capsys):
    source, output = tmp_path / "book.json", tmp_path / "candidate.json"
    original = _write_fixture(source, book)
    assert rules.main([str(source), "--output", str(output)]) == 0
    assert json.loads(output.read_text(encoding="utf-8")) == rules.prepare_book(book)
    candidate = output.read_bytes()
    assert rules.main([str(source), "--output", str(output)]) == 1
    assert output.read_bytes() == candidate
    assert rules.main([str(source), "--output", str(source)]) == 1
    assert source.read_bytes() == original
    assert not list(tmp_path.glob("*.bak"))


def test_apply_backs_up_exact_bytes_before_replace_and_second_apply_is_noop(book, tmp_path, monkeypatch, capsys):
    source = tmp_path / "book.json"
    original = _write_fixture(source, book)
    replace = rules.os.replace
    calls = []
    def checked_replace(pending, destination):
        backups = list(tmp_path.glob("*.bak"))
        assert len(backups) == 1 and backups[0].read_bytes() == original
        assert source.read_bytes() == original
        assert Path(pending).parent == source.parent
        calls.append((pending, destination))
        replace(pending, destination)
    monkeypatch.setattr(rules.os, "replace", checked_replace)
    assert rules.main([str(source), "--apply"]) == 0
    summary = json.loads(capsys.readouterr().out)
    assert Path(summary["backup"]).read_bytes() == original
    assert len(calls) == 1
    assert json.loads(source.read_text(encoding="utf-8")) == rules.prepare_book(book)
    applied = source.read_bytes()
    assert rules.main([str(source), "--apply"]) == 0
    assert json.loads(capsys.readouterr().out)["changed"] is False
    assert len(calls) == 1 and len(list(tmp_path.glob("*.bak"))) == 1
    assert source.read_bytes() == applied
    assert not list(tmp_path.glob("*.tmp"))


def test_concurrent_change_before_apply_is_not_overwritten(book, tmp_path):
    source = tmp_path / "book.json"
    original = _write_fixture(source, book)
    source.write_bytes(b"external edit")
    with pytest.raises(rules.PreparationError, match="SHA-256 mismatch"):
        rules.apply_prepared(source, original, b"candidate")
    assert source.read_bytes() == b"external edit"
    assert list(tmp_path.iterdir()) == [source]


def test_concurrent_change_after_backup_is_not_overwritten(book, tmp_path, monkeypatch):
    source = tmp_path / "book.json"
    original = _write_fixture(source, book)
    check = rules._assert_unchanged
    checks = []
    def concurrent_check(path, expected):
        checks.append(expected)
        if len(checks) == 2:
            assert len(list(tmp_path.glob("*.bak"))) == 1
            source.write_bytes(b"external edit after backup")
        check(path, expected)
    monkeypatch.setattr(rules, "_assert_unchanged", concurrent_check)
    with pytest.raises(rules.PreparationError, match="SHA-256 mismatch"):
        rules.apply_prepared(source, original, b"candidate")
    assert len(checks) == 2
    assert source.read_bytes() == b"external edit after backup"
    assert list(tmp_path.glob("*.bak"))[0].read_bytes() == original
    assert not list(tmp_path.glob("*.tmp"))


def test_replace_failure_leaves_original_and_recoverable_backup(book, tmp_path, monkeypatch, capsys):
    source = tmp_path / "book.json"
    original = _write_fixture(source, book)
    def fail(*args):
        raise OSError("simulated replace failure")
    monkeypatch.setattr(rules.os, "replace", fail)
    assert rules.main([str(source), "--apply"]) == 1
    assert "backup:" in capsys.readouterr().err
    assert source.read_bytes() == original
    assert list(tmp_path.glob("*.bak"))[0].read_bytes() == original
    assert not list(tmp_path.glob("*.tmp"))


def test_backup_creation_failure_never_changes_source(book, tmp_path, monkeypatch):
    source = tmp_path / "book.json"
    original = _write_fixture(source, book)
    def fail(**kwargs):
        raise PermissionError("backup denied")
    monkeypatch.setattr(rules.tempfile, "NamedTemporaryFile", fail)
    assert rules.main([str(source), "--apply"]) == 1
    assert source.read_bytes() == original
    assert list(tmp_path.iterdir()) == [source]


def test_cli_entry_point_and_mutually_exclusive_modes(book, tmp_path):
    source = tmp_path / "book.json"
    original = _write_fixture(source, book)
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"}
    command = [sys.executable, str(ROOT / "scripts" / "prepare_beyond_twin_story_rules.py"), str(source)]
    completed = subprocess.run(command, capture_output=True, encoding="utf-8", env=env, timeout=30)
    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout)["mode"] == "dry-run"
    rejected = subprocess.run(command + ["--apply", "--output", str(tmp_path / "candidate.json")],
                              capture_output=True, encoding="utf-8", env=env, timeout=30)
    assert rejected.returncode == 2
    assert source.read_bytes() == original
    assert list(tmp_path.iterdir()) == [source]
