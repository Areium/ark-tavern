"""Stage streaming boundaries and the actual narrator prompt builders."""

import json
import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from SceneManager import SceneManager
from blueprints import chat


@pytest.fixture
def stream_app(monkeypatch):
    scene = SimpleNamespace(
        active=None,
        _combat_mode="narrative",
        _build_conversation_history=Mock(return_value=""),
        parse_structured=SceneManager.parse_structured,
        extract_markers=Mock(return_value={}),
        _branch_context=Mock(return_value=""),
        _recent_worldbook_text=Mock(return_value=""),
    )

    def narrate_stream(*args, **kwargs):
        yield "token", "草稿正文"
        yield "done", ("权威正文", {}, {"output_tokens": 5})

    scene.narrate_stream = narrate_stream
    overlay = SimpleNamespace(
        _narration_lock=threading.Lock(),
        get_current_beat_id=lambda: "",
        get_beat_state=lambda: {},
        get_node_history=lambda: [{}],
        get_authored_branches=lambda: [],
        append_plot_log=Mock(),
        update_beat_progress=Mock(),
    )
    session = SimpleNamespace(
        id="test",
        mode="story",
        combat_mode="narrative",
        combat=None,
        player_identity="玩家",
        narration_count=4,
        _narration_history=[],
        scene_manager=scene,
        overlay=overlay,
        environment=SimpleNamespace(build_context=lambda: "测试场景"),
        get_llm=lambda: object(),
        accumulate_usage=Mock(),
        apply_environment_updates=Mock(),
        should_generate_memory=lambda interval: False,
    )

    def add_narration(*args, **kwargs):
        session.narration_count += 1

    session.add_narration = Mock(side_effect=add_narration)
    for name in ("_apply_branch_landing", "_apply_beat_complete", "_record_node_snapshot", "_commit_tree_step"):
        monkeypatch.setattr(chat, name, Mock())
    for name in ("_resolve_branch", "_beat_combat_target", "_resolve_combat_scene", "_apply_combat_briefing", "_maybe_check_deviation"):
        monkeypatch.setattr(chat, name, Mock(return_value=None))
    monkeypatch.setattr(chat, "_build_lore_resolver", lambda *args: None)
    monkeypatch.setattr(chat, "inject_memory_context", lambda session, context: context)

    config = {"dialogue_bubble_mode": False}
    hook = SimpleNamespace(
        injection="",
        execute_before_narration=lambda ctx: [],
        execute_between_phases=lambda ctx: [],
    )
    hook.collect_prompt_injections = lambda ctx: hook.injection if ctx.narrative_text else ""
    app = Flask(__name__)
    chat.register(app, {
        "session": SimpleNamespace(get_session=lambda session_id: session),
        "llm_backend": SimpleNamespace(get_config=lambda: config),
        "hook_pipeline": hook,
    })
    return app, session, scene, config, hook


def _events(app):
    response = app.test_client().get("/api/sessions/test/narrate", buffered=True)
    assert response.status_code == 200
    return [json.loads(line[6:]) for line in response.get_data(as_text=True).splitlines()
            if line.startswith("data: ")]


@pytest.mark.parametrize("bubble_mode", [False, True])
def test_text_complete_precedes_phase2_and_done_uses_saved_round(stream_app, bubble_mode):
    app, session, scene, config, hook = stream_app
    config["dialogue_bubble_mode"] = bubble_mode
    response = app.test_client().get("/api/sessions/test/narrate", buffered=False)
    iterator = iter(response.response)
    received = []
    for chunk in iterator:
        event = json.loads(chunk.decode().strip()[6:])
        received.append(event)
        if event["type"] == "text_complete":
            assert not scene.extract_markers.called
            assert event["data"]["narrative"] == "权威正文"
            break
    received.extend(json.loads(chunk.decode().strip()[6:]) for chunk in iterator)
    response.close()
    types = [event["type"] for event in received]
    assert types.index("text") < types.index("text_complete") < types.index("choice") < types.index("done")
    assert types.count("text_complete") == types.count("done") == 1
    complete, done = received[types.index("text_complete")], received[-1]
    assert done["data"] == {"stream_id": complete["data"]["stream_id"], "round": 5, "phase2_status": "completed"}
    assert session.add_narration.call_args.args[0] == "权威正文"


def test_json_normalization_and_hook_are_authoritative_in_text_and_segments(stream_app):
    app, session, scene, config, hook = stream_app
    raw = json.dumps([{"type": "dialogue", "speaker": "阿米娅", "text": "准备出发。"}], ensure_ascii=False)
    scene.narrate_stream = lambda *args, **kwargs: iter([
        ("token", raw), ("done", (raw, {}, None)),
    ])
    hook.injection = "风吹开了门。"
    events = _events(app)
    complete = next(event for event in events if event["type"] == "text_complete")
    normalized = SceneManager.parse_structured(raw)[1]
    expected = hook.injection + "\n\n" + normalized
    assert complete["data"]["narrative"] == expected
    assert scene.extract_markers.call_args.args[0] == expected
    segments = next(event["data"]["segments"] for event in events if event["type"] == "dialogue_segments")
    assert segments[0] == {"type": "narration", "text": hook.injection}
    assert segments[1]["text"] == "准备出发。"
    assert session.add_narration.call_args.args[:3] == (expected, "", segments)


@pytest.mark.parametrize("markers", [{"error": "提取失败"}, {"degraded": True}])
def test_phase2_degradation_is_visible_without_rewriting_text(stream_app, markers):
    app, session, scene, config, hook = stream_app
    scene.extract_markers.return_value = markers
    events = _events(app)
    assert events[-1]["type"] == "done"
    assert events[-1]["data"]["phase2_status"] == "degraded"
    assert events[-1]["data"]["round"] == 5
    assert not any(event["type"] == "error" for event in events)
    assert session.add_narration.call_args.args[0] == "权威正文"


def test_phase2_skipped_is_visible(stream_app):
    app, session, scene, config, hook = stream_app
    session.mode = "free"
    events = _events(app)
    assert not scene.extract_markers.called
    assert events[-1]["data"]["phase2_status"] == "skipped"
    assert events[-1]["data"]["round"] == 4


@pytest.mark.parametrize("content", ["不是 JSON", '{"beat_complete":', "{}"])
def test_real_marker_extraction_invalid_json_reaches_done_status(stream_app, content):
    app, session, scene, config, hook = stream_app
    llm = SimpleNamespace(chat=Mock(return_value={"content": content}))
    real_scene = SceneManager(llm=llm, registry=None)
    scene.extract_markers = real_scene.extract_markers
    events = _events(app)
    assert events[-1]["data"]["phase2_status"] == ("completed" if content == "{}" else "degraded")
    assert session.add_narration.call_args.args[0] == "权威正文"
    assert llm.chat.call_count == 1


@pytest.mark.parametrize("failure", ["missing_done", "call1", "phase2", "save"])
def test_failed_stream_emits_error_and_never_done(stream_app, failure):
    app, session, scene, config, hook = stream_app
    if failure == "missing_done":
        scene.narrate_stream = lambda *args, **kwargs: iter([("token", "未完成正文")])
    elif failure == "call1":
        def fail(*args, **kwargs):
            yield "token", "未完成正文"
            raise RuntimeError("正文生成失败")
        scene.narrate_stream = fail
    elif failure == "phase2":
        scene.extract_markers.side_effect = RuntimeError("提取异常")
    else:
        session.add_narration.side_effect = RuntimeError("保存失败")
    events = _events(app)
    assert events[-1]["type"] == "error"
    assert not any(event["type"] == "done" for event in events)
    if failure == "missing_done":
        assert events[-1]["data"]["message"] == "叙述正文流未正常完成"
    if failure in ("missing_done", "call1"):
        assert not any(event["type"] == "text_complete" for event in events)
        assert not scene.extract_markers.called


@pytest.mark.parametrize("structured", [False, True])
def test_actual_narration_builder_reiterates_readability_player_and_word_limit(monkeypatch, structured):
    import player_profile
    monkeypatch.setattr(player_profile, "load_player_profile", lambda *args: "")
    scene = SceneManager(llm=None, registry=None)
    messages = scene._build_narration_messages(
        {"identity": "调查员"}, "测试场景", user_action="查看门外",
        word_limit=321, structured=structured,
    )
    system, user = (message["content"] for message in messages)
    assert "<stage_readability>" in system
    assert ("不按句号拆成多段短台词" in system) if structured else ("所有句子只放在一组「」内" in system)
    assert "不把每句描写切成独立片段" in system
    assert "不替玩家说话或做决定" in system
    assert "有意义的短回应、停顿与角色语气" in system
    assert "禁止为了合并或凑字数改变人设" in system
    assert "每次叙述约 321 字" in system
    assert "身份：调查员\n操作：查看门外" in user
    tail = user.rsplit("</player>", 1)[1]
    assert "完整连续发言" in tail
    assert "不改变人设、不替玩家说话或做决定" in tail
    assert "不输出分页标记或舞台指令" in tail
    assert tail.endswith("MUST：本轮所有正文内容（叙述 + 角色台词合计）控制在 321 字以内，宁短勿长，不要为了凑字数堆砌描写。")
    if structured:
        assert "text 只写台词，不添加「」" in system
        assert "MUST：只输出 JSON 数组" in tail
        assert "speaker 明确角色名，text 只写台词" in tail
    else:
        assert "角色名和引导动词必须紧邻「」之前" in system
        assert "每个发言段从明确角色名开始" in system
        assert "每个发言段以明确角色名说：「完整台词。」开头" in tail
    extractor = SceneManager._MARKER_EXTRACTOR_SYSTEM
    assert "<stage_readability>" not in extractor
    assert "不涉及创意写作" in extractor
