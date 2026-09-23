# -*- coding: utf-8 -*-
"""「彼岸双生」剧情下 LLM 自动生成剧情节点的完整流程验证（脚本化 LLM，确定性）。

彼岸双生的剧情文件没有 `## 章节 N` 节拍骨架（护栏式 `## 第N幕：`），旧链路下会话
既没有 beat_state 也没有可校验的 target_beat_id。本文件把真实 Flask 应用 +
narrate-continue 全链路串起来，验证四项要求：

  1. 参考条目：会话创建即从剧情文档 / 世界书得到参考大纲（这里是启发式切幕；
     书内 LLM 大纲的读取走同一入口），节拍骨架、Call 2 的 <current_node> 里都能看到
     参考节拍 id 与「必须保留」；
  2. 节点种类：根 = 剧情节点，章节内推进 = 节拍节点，章节切换 = 剧情节点；
     战术模式下叙述出现交手场面 → 现场生成战斗节点（校验 + 试跑 + 入库到临时目录），
     剧情树追加 kind=combat 节点，战斗之后的叙述在其下继续；
  3. 分支：LLM 分支的 target_beat_id 只接受大纲里真实存在的节拍 id，选择分支即在
     父节点下生成子节点，回档后可走另一分支（树分叉）；
  4. 偏离：多轮后 Call 3 判定剧情偏离 → 大纲追加 kind=branch 的新章节、节拍状态跳到
     它的首节拍、剧情树开出「偏离」子节点并由下一轮叙述填充；未偏离 / 降级不改结构。

只写临时会话目录与临时战斗节点目录，不触碰 data/。
"""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

import combat_nodes  # noqa: E402
import session_manager as sm_mod  # noqa: E402
import session_overlay as so  # noqa: E402

PLOT_ID = "beyond_twin"
BOOK_ID = "beyond-twin"


@pytest.fixture()
def flow(tmp_path, monkeypatch):
    sessions_root = tmp_path / "sessions"
    monkeypatch.setattr(so, "_SESSIONS_DIR", sessions_root)
    monkeypatch.setattr(sm_mod, "_SESSIONS_DIR", sessions_root)
    # 生成的战斗节点只落到临时目录（注册表 + 加载器都指过去）
    node_dir = tmp_path / "nodes"
    node_dir.mkdir()
    monkeypatch.setattr(combat_nodes, "NODE_DIR", node_dir)
    from combat_data_loader import CombatDataLoader
    orig_init = CombatDataLoader.__init__

    def patched_init(self, data_dir=""):
        orig_init(self, data_dir)
        self._node_dir = node_dir
    monkeypatch.setattr(CombatDataLoader, "__init__", patched_init)

    from app import create_app
    app = create_app()
    app.config.update(TESTING=True)
    client = app.test_client()

    cfg = {
        "auto_generate_choices": True, "choice_count": 2, "word_limit": 300,
        "dialogue_bubble_mode": False, "narration_reasoning_effort": "none",
        "max_output_tokens": 4096, "memory_interval": 999,
        "deviation_check_interval": 3, "deviation_confidence_threshold": 0.6,
    }
    app._managers["llm_backend"].get_config = lambda: dict(cfg)

    res = client.post("/api/sessions", json={
        "mode": "story", "plot_id": PLOT_ID, "name": "彼岸双生生成验证",
        "combat_mode": "tactical", "worldbook_id": BOOK_ID,
    })
    assert res.status_code == 201, res.get_json()
    sid = res.get_json()["id"]
    session = app._managers["session"].get_session(sid)
    session._llm = object()

    calls = {"extract": [], "deviation": []}

    def script_round(narrative, *, title, summary, branches, beat_complete=False,
                     combat_scene=None, deviation=None, env=None):
        sm = session.scene_manager
        sm.narrate = lambda *a, **k: (narrative, {}, None)

        def extract(narr, **kw):
            calls["extract"].append(kw)
            valid = set(sm._valid_beat_ids())
            return {
                "beat_complete": beat_complete, "combat": None, "combat_scene": combat_scene,
                "choices": [b["label"] for b in branches],
                "branches": [{**b, "target_beat_id": b.get("target_beat_id") if b.get("target_beat_id") in valid else None}
                             for b in branches],
                "node_title": title, "summary": summary, "environment": env,
                "usage": None, "error": None,
            }
        sm.extract_markers = extract

        def assess(reference, trajectory, node_chain=""):
            calls["deviation"].append({"reference": reference, "trajectory": trajectory})
            return deviation or {"deviated": False, "confidence": 0.1, "reason": "顺着走", "branch": None,
                                 "usage": None, "error": None, "degraded": False}
        sm.assess_deviation = assess

    def play(action="", branch_id=None):
        payload = {"action": action}
        if branch_id:
            payload["branch_id"] = branch_id
        r = client.post(f"/api/sessions/{sid}/narrate-continue", json=payload)
        assert r.status_code == 200, r.get_json()
        return r.get_json()

    yield {"client": client, "sid": sid, "session": session, "script_round": script_round,
           "play": play, "calls": calls, "node_dir": node_dir, "cfg": cfg}
    app._managers["session"].delete_session(sid)


def _tree(session):
    return session.overlay.get_story_tree()


def test_reference_outline_seeds_session(flow):
    """要求 1：无节拍骨架的剧情靠参考大纲得到节拍状态与候选节拍。"""
    session = flow["session"]
    ov = session.overlay
    outline = ov.get_story_outline()
    assert outline and outline["source"] == "heuristic" and outline["plot_id"] == PLOT_ID
    assert ov.get_beat_state()["chapter_idx"] == 0
    assert ov.get_current_beat_id() == "beat_act_1_1"
    assert ov.get_current_chapter_id() == "act_1"
    ctx = ov.build_branch_context()
    assert "当前参考节拍：beat_act_1_1" in ctx
    assert "必须保留：妮可知道程叙姓名" in ctx
    assert "beat_act_2_1" in ctx, "后续候选节拍应列出 id 供 target_beat_id 选用"
    valid = set(session.scene_manager._valid_beat_ids())
    assert {"beat_act_1_1", "beat_act_7_1", "beat_route_a_1"} <= valid
    plot_state = ov.read_session_doc("plot_state.md")
    assert plot_state and "beat_act_1_1" in plot_state and "[HERE]" in plot_state
    st = flow["client"].get(f"/api/sessions/{flow['sid']}/story-state").get_json()
    assert st["has_plot"] and st["outline"]["source"] == "heuristic"
    assert [r["kind"] for r in st["roads"]][:7] == ["main"] * 7 and st["roads"][7]["kind"] == "branch"


def test_plot_beat_combat_nodes_and_branches(flow):
    """要求 2 + 3：剧情/节拍/战斗节点种类正确，分支落点有根且可分叉。"""
    session, play, script_round = flow["session"], flow["play"], flow["script_round"]
    calls = flow["calls"]

    # R1 根节点（剧情节点）
    script_round("SENTINEL_R1 台风夜，程叙在二楼门口被一个软乎乎的东西绊倒。",
                 title="门口的女孩", summary="程叙遇见妮可",
                 branches=[{"label": "先报警", "intent": "谨慎", "target_beat_id": "beat_act_1_1"},
                           {"label": "让她进门", "intent": "接纳", "target_beat_id": "beat_act_2_1"},
                           {"label": "凭空编造", "intent": None, "target_beat_id": "beat_not_exists"}])
    r1 = play()
    root = _tree(session)["nodes"]["n_root"]
    assert root["kind"] == "plot" and root["ref_chapter_id"] == "act_1" and root["ref_beat_id"] == "beat_act_1_1"
    assert "SENTINEL_R1" in root["content"]
    targets = {b["label"]: b.get("target_beat_id") for b in r1["branches"]}
    assert targets["先报警"] == "beat_act_1_1" and targets["让她进门"] == "beat_act_2_1"
    assert targets["凭空编造"] is None, "不存在的节拍 id 必须被置空"
    assert "<current_node>" in calls["extract"][-1]["branch_context"]
    assert "beat_act_2_1" in calls["extract"][-1]["branch_context"]
    enter_id = next(b["id"] for b in r1["branches"] if b["label"] == "让她进门")

    # R2 选「让她进门」→ 落点 beat_act_2_1（章节切换）→ 子节点是剧情节点
    script_round("SENTINEL_R2 周末的商场里，妮可第一次认真吃了一份普通的食物。",
                 title="被浪费的下午", summary="妮可学会浪费一个下午",
                 branches=[{"label": "去买玩偶", "intent": "日常"}, {"label": "回家休息", "intent": "中立"}])
    play(branch_id=enter_id)
    t = _tree(session)
    child = t["nodes"][t["current_id"]]
    assert child["parent_id"] == "n_root" and child["kind"] == "plot"
    assert child["ref_chapter_id"] == "act_2" and child["ref_beat_id"] == "beat_act_2_1"
    assert session.overlay.get_current_beat_id() == "beat_act_2_1"
    plot_node_id = child["id"]

    # R3 同章节内选分支 → 节拍节点
    script_round("SENTINEL_R3 抓娃娃机恰到好处地松爪，黑猫玩偶落进取物口。",
                 title="黑猫玩偶", summary="妮可获得黑猫玩偶",
                 branches=[{"label": "追问好运", "intent": "情报"}, {"label": "装作没看见", "intent": "中立"}])
    r3 = play(branch_id=next(b["id"] for b in session.overlay.get_emitted_branches() if b["label"] == "去买玩偶"))
    t = _tree(session)
    beat_node = t["nodes"][t["current_id"]]
    assert beat_node["kind"] == "beat" and beat_node["parent_id"] == plot_node_id
    assert beat_node["ref_chapter_id"] == "act_2"

    # R4 叙述出现交手场面（战术模式）→ 现场生成战斗节点 + 剧情树追加战斗节点
    script_round("SENTINEL_R4 商场保安误以为妮可是走失儿童，两名澜晶便衣趁乱上前要把她带走。",
                 title="商场拦截", summary="澜晶便衣在商场拦截妮可",
                 branches=[{"label": "护着妮可跑", "intent": "行动"}, {"label": "报警求助", "intent": "社交"}],
                 combat_scene={"name": "商场拦截", "description": "两名澜晶安保在商场通道封堵，程叙要护着妮可冲出去",
                               "enemies": ["澜晶安保人员"], "band": "T1"})
    r4 = play()
    briefing = r4.get("combat_briefing")
    assert briefing and briefing.get("generated") is True, r4
    enc_id = briefing["encounter_id"]
    assert enc_id.startswith("enc_beyond_twin_") and (flow["node_dir"] / f"{enc_id}.json").is_file()
    saved = combat_nodes.load_node_file(enc_id)
    assert saved["bind"] == {"plot_id": PLOT_ID, "chapter_id": "act_2", "beat_id": "beat_act_2_1"}
    assert saved["worldbook_id"] == BOOK_ID
    assert saved["waves"][0]["enemies"][0]["enemy"] == "澜晶安保人员"
    assert saved["generated"]["simulation"]["win_rate"] >= 0.5
    t = _tree(session)
    combat_node = t["nodes"][t["current_id"]]
    assert combat_node["kind"] == "combat" and combat_node["combat_node_id"] == enc_id
    assert combat_node["parent_id"] == beat_node["id"]
    # 生成的节点绑定到当前参考节拍：骨架内容带 [COMBAT:id]
    assert session.overlay.get_current_beat_combat_id() == enc_id
    st = flow["client"].get(f"/api/sessions/{flow['sid']}/story-state").get_json()
    kinds = {n["id"]: n["kind"] for n in st["tree"]["nodes"]}
    assert kinds["n_root"] == "plot" and kinds[beat_node["id"]] == "beat" and kinds[combat_node["id"]] == "combat"

    # R5 战斗之后继续叙述 → 在战斗节点下开子节点（不覆盖战斗节点）
    script_round("SENTINEL_R5 冲出商场后，妮可在出租车里发起了低烧。",
                 title="退烧之前", summary="妮可开始发热",
                 branches=[{"label": "去医院", "intent": "谨慎"}, {"label": "回家观察", "intent": "中立"}])
    play()
    t = _tree(session)
    after = t["nodes"][t["current_id"]]
    assert after["parent_id"] == combat_node["id"] and after["kind"] == "beat"
    assert "SENTINEL_R5" in after["content"] and combat_node["combat_node_id"] == enc_id

    # 树分叉：回档到根节点，走另一条分支「先报警」→ 根下出现第二个子节点
    rb = flow["client"].post(f"/api/sessions/{flow['sid']}/rollback-node", json={"node_id": "n_root"})
    assert rb.status_code == 200, rb.get_json()
    assert session.overlay.get_current_beat_id() == "beat_act_1_1", "回档应恢复参考节拍"
    police_id = next(b["id"] for b in session.overlay.get_emitted_branches() if b["label"] == "先报警")
    script_round("SENTINEL_R6 程叙拨通报警电话的瞬间，母亲的来电插了进来。",
                 title="母亲的电话", summary="伪装电话替妮可造身份",
                 branches=[{"label": "相信母亲", "intent": "接纳"}])
    play(branch_id=police_id)
    t = _tree(session)
    assert len(t["nodes"]["n_root"]["children"]) == 2, "根节点下两个分支子节点共存"
    other = t["nodes"][t["current_id"]]
    assert other["kind"] == "beat" and other["ref_chapter_id"] == "act_1", "同章节内选分支 → 节拍节点"


def test_deviation_opens_new_branch_line(flow):
    """要求 4：多轮之后判定偏离 → 大纲追加分支章节、节拍跳转、剧情树开出偏离节点。"""
    session, play, script_round = flow["session"], flow["play"], flow["script_round"]
    calls = flow["calls"]

    script_round("R1 程叙把妮可让进门。", title="进门", summary="妮可进门",
                 branches=[{"label": "继续", "intent": None}])
    play()
    script_round("R2 第二天早上妮可不见了，只留下一张写着澜晶地址的纸条。", title="空房间",
                 summary="妮可失踪并留下澜晶地址",
                 branches=[{"label": "去澜晶", "intent": "追查"}])
    play()
    assert calls["deviation"] == [], "未到检测轮次不调用 Call 3"

    # 第 3 轮：到达检测间隔，Call 3 判定偏离并给出新分支线
    script_round("R3 程叙在澜晶大楼门口被拦下，妮可在楼上向他挥手。", title="澜晶门口",
                 summary="程叙追到澜晶", branches=[{"label": "硬闯", "intent": "行动"}],
                 deviation={"deviated": True, "confidence": 0.9,
                            "reason": "妮可提前主动去了澜晶，原定第二至第四幕的同居线无法发生",
                            "branch": {"title": "提前抵达澜晶",
                                       "summary": "程叙追到澜晶，与杜可提前正面接触",
                                       "beats": [{"title": "大堂对峙", "summary": "杜可出面接待", "content": "……"},
                                                 {"title": "楼上的妮可", "summary": "妮可解释她为何来这里", "content": "……",
                                                  "combat": {"required": True, "description": "安保拦截", "enemies": [], "band": "T1"}}]},
                            "usage": None, "error": None, "degraded": False})
    r3 = play()
    assert len(calls["deviation"]) == 1
    assert "beat_act_1_1" in calls["deviation"][0]["reference"]
    assert "妮可失踪" in calls["deviation"][0]["trajectory"]
    dev = r3["deviation"]
    assert dev["deviated"] and dev["applied"]["chapter_id"] == "dev_1"
    ov = session.overlay
    outline = ov.get_story_outline()
    branch_ch = outline["chapters"][-1]
    assert branch_ch["kind"] == "branch" and branch_ch["origin"]["type"] == "deviation"
    assert branch_ch["origin"]["parent_beat_id"] == "beat_act_1_1"
    assert ov.get_current_beat_id() == "beat_dev_1_1" and "beat_act_1_1" in ov.get_beat_state()["completed_beats"]
    t = _tree(session)
    dev_node = t["nodes"][t["current_id"]]
    assert dev_node["kind"] == "plot" and dev_node["deviation"]["chapter_id"] == "dev_1"
    assert dev_node["state"] is None and dev_node["branch_label"].startswith("偏离：")
    parent = t["nodes"][dev_node["parent_id"]]
    assert any(b.get("source") == "deviation" and b["child_id"] == dev_node["id"] for b in parent["branches"])
    st = flow["client"].get(f"/api/sessions/{flow['sid']}/story-state").get_json()
    assert st["deviation"]["history"][-1]["deviated"] is True
    assert st["outline"]["branch_chapters"][-1]["id"] == "dev_1"
    assert st["roads"][-1]["kind"] == "branch" and st["roads"][-1]["beats"][1]["has_combat"]

    # 第 4 轮：叙述填充偏离节点（不新建），参考节拍已是新分支线
    script_round("R4 杜可在大堂里迎上来，说他早就在等程叙。", title="大堂对峙", summary="杜可出面",
                 branches=[{"label": "质问杜可", "intent": "冲突", "target_beat_id": "beat_dev_1_2"}])
    r4 = play()
    t = _tree(session)
    assert t["current_id"] == dev_node["id"]
    filled = t["nodes"][dev_node["id"]]
    assert "R4" in filled["content"] and filled["state"]["round_end"] == 4
    assert filled["ref_beat_id"] == "beat_dev_1_1"
    assert r4["branches"][0]["target_beat_id"] == "beat_dev_1_2", "新分支线的节拍 id 成为合法落点"

    # 降级 / 未偏离：只记录，不改结构
    script_round("R5 ……", title="…", summary="……", branches=[{"label": "继续", "intent": None}])
    play()
    script_round("R6 ……", title="…", summary="……", branches=[{"label": "继续", "intent": None}],
                 deviation={"deviated": False, "confidence": 0.2, "reason": "在分支线上", "branch": None,
                            "usage": None, "error": None, "degraded": True})
    r6 = play()
    assert r6["deviation"]["deviated"] is False and r6["deviation"]["degraded"] is True
    assert len(session.overlay.get_story_outline()["chapters"]) == len(outline["chapters"])
    assert len(session.overlay.get_deviation_state()["history"]) == 2


def test_foreign_encounter_is_replaced_by_plot_bound_generated_node(flow):
    """Call 2 选中了别的世界观的通用遭遇 → 仍按本剧情场景生成绑定节点；生成节点属于本书。"""
    session, play, script_round = flow["session"], flow["play"], flow["script_round"]
    combat_nodes.create_node("enc_foreign", "外来遭遇", worldbook_id="arknights")
    script_round("R1 楼道里两名安保抽出警棍。", title="楼道对峙", summary="安保逼近",
                 branches=[{"label": "挥斧", "intent": "战斗"}],
                 combat_scene={"name": "楼道对峙", "description": "两名澜晶安保持警棍逼近程叙",
                               "enemies": ["澜晶安保人员"], "band": "T0"})
    sm = session.scene_manager
    base_extract = sm.extract_markers
    sm.extract_markers = lambda *a, **k: {**base_extract(*a, **k), "combat": {"encounter_id": "enc_foreign", "params": None}}
    r = play()
    briefing = r["combat_briefing"]
    assert briefing["generated"] is True and briefing["encounter_id"] != "enc_foreign"
    saved = combat_nodes.load_node_file(briefing["encounter_id"])
    assert saved["worldbook_id"] == BOOK_ID and saved["bind"]["plot_id"] == PLOT_ID

    # 本剧情自己的节点被选中时直接复用，不再生成
    own_id = briefing["encounter_id"]
    before = sorted(p.name for p in flow["node_dir"].glob("*.json"))
    sm.extract_markers = lambda *a, **k: {**base_extract(*a, **k), "combat": {"encounter_id": own_id, "params": None}}
    r2 = play()
    assert r2["combat_briefing"]["encounter_id"] == own_id and not r2["combat_briefing"].get("generated")
    assert sorted(p.name for p in flow["node_dir"].glob("*.json")) == before
