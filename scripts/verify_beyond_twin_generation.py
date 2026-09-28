#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""真实 LLM 端到端冒烟：「彼岸双生」世界书驱动的剧情节点自动生成。

验证四项要求（与 tests/test_story_generation_beyond_twin.py 的脚本化用例互补）：

  1. 参考条目：POST /api/worldbooks/beyond-twin/story-outline 从书内参考条目生成
     参考大纲（LLM），并把 combat.required 的节拍物化成战斗节点；
  2. 节点种类：真实叙述 + Call 2 下，根 = 剧情节点、章节内 = 节拍节点、
     交手场面 → 战斗节点（现成或现场生成）；
  3. 分支：Call 2 给出的 branches 的 target_beat_id 落在大纲节拍集合内，选分支
     生成子节点，回档后可分叉；
  4. 偏离：连续几轮把剧情带离原作后，自动偏离检测（Call 3）判定并开出新分支线。

用法（仓库根目录）：
    python scripts/verify_beyond_twin_generation.py [--out PATH] [--skip-outline]

前置：config/llm_config.json 含可用 API key。会话 / 世界书 / 战斗节点全部写入
临时目录，不触碰 data/。
"""

import argparse
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

import combat_nodes  # noqa: E402
import session_manager as sm_mod  # noqa: E402
import session_overlay as so  # noqa: E402
import world_book as wb_mod  # noqa: E402
from data_paths import worldbooks_root  # noqa: E402

PLOT_ID = "beyond_twin"
BOOK_ID = "beyond-twin"


def tree_ascii(session) -> str:
    tv = session.overlay.build_tree_state()
    lines = []
    for n in tv["nodes"]:
        mark = "*" if n["id"] == tv["current_id"] else " "
        lines.append(
            f"{mark} {'  ' * n['depth']}[{n['kind']}] {n['title']}"
            f"  ({n['branch_label'] or '入口'} → {n['ref_beat_id'] or '-'})"
            f"  轮{n['round_start']}-{n['round_end']}"
            + (f"  战斗={n['combat_node_id']}" if n.get("combat_node_id") else "")
            + ("  <偏离>" if n.get("deviation") else "")
        )
    return "\n".join(lines)


def main() -> int:
    import logging
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    for name in ("session_overlay", "blueprints.chat", "story_outline", "combat_generation"):
        logging.getLogger(name).setLevel(logging.INFO)
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=str(ROOT / ".tmp" / "beyond_twin_generation_report.json"))
    ap.add_argument("--skip-outline", action="store_true", help="不生成 LLM 大纲（用启发式）")
    ap.add_argument("--deviation-interval", type=int, default=3)
    args = ap.parse_args()
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # ── 隔离：会话 / 世界书 / 战斗节点都进临时目录 ──
    tmp = Path(tempfile.mkdtemp(prefix="beyond_twin_verify_"))
    so._SESSIONS_DIR = tmp / "sessions"
    sm_mod._SESSIONS_DIR = tmp / "sessions"
    wb_dir = tmp / "worldbooks"
    wb_dir.mkdir()
    real_wb = worldbooks_root(ROOT)
    for name in (f"{BOOK_ID}.json", "settings.json"):
        if (real_wb / name).is_file():
            shutil.copy(real_wb / name, wb_dir / name)
    wb_mod._WORLDBOOKS_DIR = wb_dir
    node_dir = tmp / "nodes"
    node_dir.mkdir()
    combat_nodes.NODE_DIR = node_dir
    from combat_data_loader import CombatDataLoader
    orig_init = CombatDataLoader.__init__

    def patched_init(self, data_dir=""):
        orig_init(self, data_dir)
        self._node_dir = node_dir
    CombatDataLoader.__init__ = patched_init

    from app import create_app
    app = create_app()
    app.config.update(TESTING=True)
    client = app.test_client()
    real_get_config = app._managers["llm_backend"].get_config

    def get_config():
        cfg = dict(real_get_config())
        cfg.update({
            "memory_interval": 999, "word_limit": 320, "dialogue_bubble_mode": False,
            "narration_reasoning_effort": "none", "max_output_tokens": 4096,
            "auto_generate_choices": True, "choice_count": 3,
            "deviation_check_interval": args.deviation_interval,
            "deviation_confidence_threshold": 0.6,
        })
        return cfg
    app._managers["llm_backend"].get_config = get_config

    checks: list[dict] = []
    report: dict = {"plot": PLOT_ID, "book": BOOK_ID, "tmp": str(tmp), "rounds": []}

    def check(name, ok, detail=""):
        checks.append({"name": name, "ok": bool(ok), "detail": detail})
        print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" —— {detail}" if detail else ""))
        return bool(ok)

    # ── 1. 参考大纲：从世界书参考条目生成 ──
    print("== 1. 参考大纲生成 ==")
    t0 = time.monotonic()
    if args.skip_outline:
        r = client.post(f"/api/worldbooks/{BOOK_ID}/story-outline",
                        json={"plot_id": PLOT_ID, "mode": "heuristic", "generate_combat": True})
    else:
        r = client.post(f"/api/worldbooks/{BOOK_ID}/story-outline",
                        json={"plot_id": PLOT_ID, "mode": "llm", "generate_combat": True})
    print(f"  耗时 {time.monotonic() - t0:.1f}s status={r.status_code}")
    if r.status_code != 200:
        print("[FATAL] 大纲生成接口失败", r.get_json())
        return 2
    body = r.get_json()
    outline = body["outline"]
    gen = body.get("generation") or {}
    if gen.get("raw"):
        raw_path = out_path.parent / "beyond_twin_outline_raw.txt"
        raw_path.write_text(gen["raw"], encoding="utf-8")
        print(f"  大纲原始输出（解析失败）→ {raw_path}")
        gen = {k: v for k, v in gen.items() if k != "raw"}
    report["outline"] = {"source": outline["source"], "generation": gen,
                         "combat_nodes": body.get("combat_nodes"),
                         "chapters": [{"id": c["id"], "title": c["title"], "kind": c["kind"],
                                       "beats": [{"id": b["id"], "title": b["title"],
                                                  "combat": b.get("combat")} for b in c["beats"]]}
                                      for c in outline["chapters"]]}
    for c in outline["chapters"]:
        print(f"  - {c['id']} [{c['kind']}] {c['title']}")
        for b in c["beats"]:
            combat = b.get("combat") or {}
            tag = f"  ⚔ {combat.get('node_id') or '(需生成)'}" if combat.get("required") else ""
            print(f"      · {b['id']} {b['title']}{tag}")
    check("大纲来源为 LLM（非回落）", args.skip_outline or outline["source"] == "llm",
          f"source={outline['source']} error={gen.get('error')}")
    check("大纲章节数 ≥ 5", len(outline["chapters"]) >= 5, f"{len(outline['chapters'])} 章")
    from story_outline import beat_ids
    all_beats = set(beat_ids(outline))
    bad_targets = [br["target_beat_id"] for c in outline["chapters"] for b in c["beats"]
                   for br in b["branches"] if br["target_beat_id"] and br["target_beat_id"] not in all_beats]
    check("大纲内分支落点全部合法", not bad_targets, str(bad_targets))
    required = [(c["id"], b["id"], b["combat"]) for c in outline["chapters"] for b in c["beats"]
                if (b.get("combat") or {}).get("required")]
    materialized = [x for x in required if x[2].get("node_id")]
    if required:
        check("含战斗的节拍已物化为战斗节点", len(materialized) == len(required),
              f"{len(materialized)}/{len(required)} 个（{[x[2].get('node_id') for x in materialized]}）")
        check("生成的战斗节点文件已入库（临时目录）",
              all((node_dir / f"{x[2]['node_id']}.json").is_file() for x in materialized))
    else:
        suggested = [b["id"] for c in outline["chapters"] for b in c["beats"]
                     if (b.get("combat") or {}).get("suggested")]
        check("大纲无必需战斗节拍（原作无正面交手；战斗由叙述场面现场生成）", True,
              f"启发式战斗建议：{suggested}")
    r2 = client.get(f"/api/worldbooks/{BOOK_ID}/story-outline", query_string={"plot_id": PLOT_ID})
    check("大纲已保存为书内条目并可读回", r2.status_code == 200 and r2.get_json().get("exists"))

    # ── 2. 会话：大纲作为参考骨架 ──
    print("== 2. 创建战术剧情会话 ==")
    res = client.post("/api/sessions", json={
        "mode": "story", "plot_id": PLOT_ID, "name": "彼岸双生 LLM 冒烟",
        "combat_mode": "tactical", "worldbook_ids": [BOOK_ID],
    })
    if res.status_code != 201:
        print("[FATAL] 会话创建失败", res.get_json())
        return 2
    sid = res.get_json()["id"]
    session = app._managers["session"].get_session(sid)
    ov = session.overlay
    check("会话采用书内大纲作为参考骨架",
          (ov.get_story_outline() or {}).get("source") == outline["source"] and bool(ov.get_beat_state()),
          f"current_beat={ov.get_current_beat_id()}")

    sm = session.scene_manager
    extracts: list[dict] = []
    deviations: list[dict] = []
    orig_extract, orig_assess = sm.extract_markers, sm.assess_deviation

    def rec_extract(*a, **k):
        r = orig_extract(*a, **k)
        extracts.append(r)
        return r

    def rec_assess(*a, **k):
        r = orig_assess(*a, **k)
        deviations.append(r)
        return r
    sm.extract_markers, sm.assess_deviation = rec_extract, rec_assess

    def play(step, action="", branch_id=None):
        payload = {"action": action}
        if branch_id:
            payload["branch_id"] = branch_id
        t0 = time.monotonic()
        r = client.post(f"/api/sessions/{sid}/narrate-continue", json=payload)
        dt = time.monotonic() - t0
        data = r.get_json() if r.status_code == 200 else None
        ex = extracts[-1] if extracts else {}
        cur = ov.get_current_tree_node() or {}
        row = {
            "step": step, "status": r.status_code, "seconds": round(dt, 1),
            "action": action, "branch_id": branch_id,
            "node_title": ex.get("node_title"), "degraded": ex.get("degraded"),
            "branches": [(b["label"], b.get("target_beat_id")) for b in (data or {}).get("branches", [])],
            "combat_scene": ex.get("combat_scene"),
            "combat_briefing": (data or {}).get("combat_briefing"),
            "deviation": (data or {}).get("deviation"),
            "current_node": {"id": cur.get("id"), "kind": cur.get("kind"), "ref_beat": cur.get("ref_beat_id")},
            "beat": ov.get_current_beat_id(),
            "narrative_head": ((data or {}).get("narrative") or "")[:120].replace("\n", " "),
        }
        report["rounds"].append(row)
        print(f"  [{step}] {dt:.1f}s → 节点 {cur.get('kind')}「{cur.get('title')}」 参考节拍 {row['beat']}")
        print(f"        叙述：{row['narrative_head']}…")
        print(f"        分支：{row['branches']}")
        if row["combat_briefing"]:
            print(f"        战斗：{row['combat_briefing'].get('encounter_id')} generated={row['combat_briefing'].get('generated')}")
        if row["deviation"]:
            print(f"        偏离：{json.dumps(row['deviation'], ensure_ascii=False)[:200]}")
        if r.status_code != 200:
            print("        错误：", r.get_json())
        return data

    print("== 3. 叙述与分支 ==")
    d1 = play("R1 开场")
    ok1 = bool(d1)
    check("首轮：根节点为剧情节点且引用参考节拍",
          ok1 and (ov.get_current_tree_node() or {}).get("kind") == "plot"
          and bool((ov.get_current_tree_node() or {}).get("ref_beat_id")))
    llm_br = [b for b in (d1 or {}).get("branches", []) if b.get("source") == "llm"]
    check("首轮：LLM 给出 ≥2 个分支", len(llm_br) >= 2, str([b["label"] for b in llm_br]))
    valid_targets = [b for b in llm_br if b.get("target_beat_id")]
    check("首轮：分支落点全部落在大纲节拍集合内",
          all(b["target_beat_id"] in all_beats for b in valid_targets),
          f"{[(b['label'], b['target_beat_id']) for b in llm_br]}")

    pick = next((b for b in llm_br if b.get("target_beat_id") and b["target_beat_id"] != ov.get_current_beat_id()), None) \
        or (llm_br[0] if llm_br else None)
    d2 = play("R2 选分支", branch_id=pick["id"] if pick else None, action=pick["label"] if pick else "")
    cur = ov.get_current_tree_node() or {}
    check("选分支：根节点下生成子节点", bool(d2) and cur.get("parent_id") == "n_root",
          f"kind={cur.get('kind')} ref_beat={cur.get('ref_beat_id')} depth={cur.get('depth')}")
    if pick and pick.get("target_beat_id"):
        check("选分支：参考节拍跳到分支落点", ov.get_current_beat_id() == pick["target_beat_id"],
              f"{ov.get_current_beat_id()} vs {pick['target_beat_id']}")

    print("== 4. 战斗场面 → 战斗节点 ==")
    d3 = play("R3 交手", action="楼梯口的两名澜晶安保人员不再废话：一个甩开伸缩警棍朝程叙头上砸来，另一个伸手去抓妮可的手臂。程叙用消防斧格开警棍，两人在楼道里扭打起来，警棍砸在扶手上火星四溅——这是一场真正的近身搏斗")
    ex3 = extracts[-1] if extracts else {}
    if not (ex3.get("combat_scene") or ex3.get("combat")):
        # 叙述者有时会把交手写成对峙（Call 2 据实报无战斗）：再推一轮明确的动手场面
        d3 = play("R3b 交手升级", action="程叙不再犹豫，抡起消防斧的斧背砸向扑上来的安保人员的肩膀，对方闷哼着摔在楼梯上；另一人抽出警棍反击，两人在楼道里正面交手，警棍与斧柄碰撞的声音在楼里回荡")
        ex3 = extracts[-1] if extracts else {}
    check("Call 2 识别出交手场面（combat_scene 或 combat_trigger）",
          bool(ex3.get("combat_scene") or ex3.get("combat")),
          f"scene={ex3.get('combat_scene')} trigger={ex3.get('combat')}")
    briefing = (d3 or {}).get("combat_briefing")
    check("下发战前简报（现成或现场生成的战斗节点）", bool(briefing),
          f"{briefing and briefing.get('encounter_id')} generated={briefing and briefing.get('generated')}")
    # 同一轮可能还触发了偏离检测（在战斗节点下再开偏离节点），因此按 combat_node_id 在树上找
    enc_id = (briefing or {}).get("encounter_id", "")
    combat_nodes_in_tree = [n for n in ov.get_story_tree().get("nodes", {}).values()
                            if n.get("kind") == "combat" and n.get("combat_node_id") == enc_id]
    check("剧情树追加战斗节点", bool(enc_id) and bool(combat_nodes_in_tree),
          f"{[n['id'] for n in combat_nodes_in_tree]} combat={enc_id}")

    print("== 5. 偏离检测 ==")
    d4 = play("R4 偏离1", action="程叙没有和安保纠缠，带着妮可连夜坐上了去北方的长途火车，决定彻底离开深湾市，再也不回200室")
    d5 = play("R5 偏离2", action="火车上妮可告诉程叙，她其实不想回澜晶，也不想回200室，她想去看雪。程叙答应带她去北方的雪山小镇定居")
    d6 = play("R6 偏离3", action="三天后他们在雪山小镇租下一间木屋，程叙注销了所有账号，两人开始过与澜晶、深湾市毫无关系的新生活")
    auto_dev = next((r.get("deviation") for r in (d4, d5, d6) if r and r.get("deviation")), None)
    check("多轮后自动触发了偏离检测", auto_dev is not None,
          json.dumps(auto_dev, ensure_ascii=False)[:200] if auto_dev else "未触发")
    if auto_dev and not auto_dev.get("applied"):
        # 自动检测判为未偏离/降级：再手动检一次，看模型对明显离线剧情的判断
        rm = client.post(f"/api/sessions/{sid}/deviation-check", json={"threshold": 0.6})
        manual = rm.get_json() if rm.status_code == 200 else {"error": rm.get_json()}
        report["manual_deviation"] = manual
        print(f"  手动偏离检测：{json.dumps({k: manual.get(k) for k in ('deviated', 'confidence', 'reason', 'applied', 'error')}, ensure_ascii=False)}")
        auto_dev = manual if manual.get("checked") else auto_dev
    applied = (auto_dev or {}).get("applied")
    check("判定偏离并开出新分支线（大纲追加分支章节 + 树上偏离节点）", bool(applied),
          json.dumps(applied, ensure_ascii=False) if applied else f"deviated={(auto_dev or {}).get('deviated')} conf={(auto_dev or {}).get('confidence')} reason={(auto_dev or {}).get('reason')}")
    if applied:
        d7 = play("R7 分支线首轮")
        cur = ov.get_current_tree_node() or {}
        check("偏离节点由下一轮叙述填充且引用新分支线节拍",
              bool(d7) and cur.get("id") == applied.get("node_id") and str(cur.get("ref_beat_id", "")).startswith("beat_dev_"),
              f"node={cur.get('id')} ref_beat={cur.get('ref_beat_id')}")

    print("== 6. 回档分叉 ==")
    rb = client.post(f"/api/sessions/{sid}/rollback-node", json={"node_id": "n_root"})
    check("回档到根节点", rb.status_code == 200, str(rb.get_json())[:120])
    other = next((b for b in ov.get_emitted_branches() if pick and b["id"] != pick["id"]), None)
    if other:
        d8 = play("R8 另一分支", branch_id=other["id"], action=other["label"])
        root = ov.get_tree_node("n_root") or {}
        check("根节点下两条分支共存（树分叉）", bool(d8) and len(root.get("children", [])) >= 2,
              f"children={len(root.get('children', []))}")

    print("\n== 剧情树 ==")
    print(tree_ascii(session))
    st = client.get(f"/api/sessions/{sid}/story-state").get_json()
    report["story_state"] = {"outline": st.get("outline"), "deviation": st.get("deviation"),
                             "roads": [(r["id"], r["kind"], r["state"]) for r in st.get("roads", [])]}
    report["checks"] = checks
    report["extracts"] = [{k: v for k, v in e.items() if k != "usage"} for e in extracts]
    report["deviations"] = deviations
    report["tree"] = tree_ascii(session)
    failed = [c for c in checks if not c["ok"]]
    report["verdict"] = "PASS" if not failed else f"FAIL({len(failed)})"
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n结论：{report['verdict']}  报告 → {out_path}")
    app._managers["session"].delete_session(sid)
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
