"""Bounded real-model acceptance of the Greybridge candidate (no scripted LLM).

python scripts/verify_story_acceptance.py --config config/llm_config.json \
  --out .tmp/story-audit/live.json --max-rounds 18

All sessions/content/config use owned temporary roots. Exit 0 requires all
expected beats, completed expected quests, and a story terminal state. This
script checks that conservative completion path, not every narrative ending.
Exit 1 includes completed beats with product gaps; 2 means no usable real model.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from story_audit_support import PACK, ROOT, candidate_app, create_story


ACTIONS = {
    "beat_gb_arrival": "我核对候车人、机械钟和广播时间，确认还有七人等待，安排队伍先安置他们。",
    "beat_gb_triage": "请闪灵稳定伤者，其余人在不耽误救治的前提下抄录广播。确认七个人都有照料后去桥头调查。",
    "beat_gb_witness": "我询问搬运工看到的时间和排期改动，承诺未经同意不公开他的姓名，然后去找排期单核对。",
    "beat_gb_manifest": "核对药品清单和行李牌，区分截药和广播事故，带着伤员名单去封锁线交涉。",
    "beat_gb_gate": "我明确提出交换伤员名单、统一救治，不用战胜奖励；请对方开放机房通道，我们继续寻找维修员。",
    "beat_gb_power": "先检测熔断位置和备用电池，不凭空增加电量；用机械记录核实停电时间，联系维修员一起检查录音。",
    "beat_gb_signal": "把原始录音、排期单、维修员证词逐一交叉核对，区分故障与隐瞒。确认至少两条吻合后立即讨论撤离供电。",
    "beat_gb_choice": "我选择分段供电：先稳定伤者，再短时广播准确的列车消息，同时由步行小组传信。两组逐一报平安。",
    "beat_gb_defense": "我出示核对过的伤员名单，说明医疗车没有抛下他们，邀请对方确认自己的同伴，争取不交战通过道路。",
    "beat_gb_evacuation": "我逐一点名，核对七名滞留者的去向、伤者交接和证据载体。无回应的人必须记入待救名单，不以全员无伤敷衍。",
    "beat_gb_hearing": "请各方根据已取得的证据说明责任，保护匿名证人，并把供电、取证和撤离的实际代价记录清楚，交罗德岛复核。",
    "beat_gb_epilogue": "请依据本次真实记录只给一个结局，清点已救者、待救者与证据去向，用简短告别收束本次行动，不再开启新事件。",
}


def write_report(path, report):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--max-rounds", type=int, default=18)
    args = ap.parse_args()
    if not 1 <= args.max_rounds <= 24:
        ap.error("max-rounds must be in 1..24")
    report = {
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "kind": "real_llm", "scripted_llm": False, "rounds": [],
        "plot_sha256": hashlib.sha256((PACK / "plot.md").read_bytes()).hexdigest(),
        "verdict": "running", "max_rounds": args.max_rounds,
    }
    write_report(args.out, report)
    if not args.config.is_file():
        report.update(verdict="blocked", error="LLM config missing; no real validation performed")
        write_report(args.out, report)
        return 2
    try:
        return run_model(args, report)
    except Exception as exc:
        # Keep failure evidence without serializing credentials/provider URLs.
        report.update(verdict="failed", error_type=type(exc).__name__,
                      error="Unexpected audit failure; inspect local console and environment")
        print(f"Audit failed: {type(exc).__name__}", flush=True)
        return 1
    finally:
        write_report(args.out, report)


def run_model(args, report):
    with candidate_app(config_path=args.config.resolve()) as ctx:
        managers = ctx["app"]._managers
        backend = managers["llm_backend"]
        real_get_config = backend.get_config

        def audit_config():
            config = dict(real_get_config())
            config.update(word_limit=240, max_output_tokens=2048, memory_interval=999,
                          auto_generate_choices=True, choice_count=2,
                          dialogue_bubble_mode=False, narration_reasoning_effort="none")
            return config

        backend.get_config = audit_config
        print("Checking project LLMBackendManager.get_llm() ...", flush=True)
        llm, _provider = backend.get_llm()
        if llm is None:
            report.update(verdict="blocked", error="Project LLMBackendManager returned no usable model")
            write_report(args.out, report)
            return 2
        report["model"] = getattr(llm, "model", None) or audit_config().get("cloud_model")
        # Fresh installation from this checkout's data/worldbooks/packs, not the user's
        # possibly edited data/worldbooks or existing sessions/dependency jobs.
        session = create_story(ctx, combat_mode="tactical", worldbook_id="arknights")
        report["worldbook_id"] = session.overlay.get_worldbook_id()
        report["expected_beats"] = ctx["manifest"]["beats"]
        report["expected_quests"] = ctx["manifest"]["quests"]
        report["roster"] = session.scene_manager.get_scene_characters()
        report["observed_markers"] = []
        original_extract = session.scene_manager.extract_markers

        def observed_extract(*a, **kw):
            result = original_extract(*a, **kw)
            report["observed_markers"].append({
                k: result.get(k) for k in ("beat_complete", "combat", "node_title", "degraded", "error", "usage")
            })
            return result

        session.scene_manager.extract_markers = observed_extract
        seen = []
        for index in range(args.max_rounds):
            beat = session.overlay.get_current_beat_id()
            seen.append(beat)
            print(f"Round {index + 1}/{args.max_rounds}: {beat}", flush=True)
            start = time.monotonic()
            response = ctx["client"].post(f"/api/sessions/{session.id}/narrate-continue", json={
                "action": ACTIONS.get(beat, "按已经确认的事实收束行动，不开启新任务。"),
            })
            body = response.get_json() or {}
            rec = {
                "index": index + 1, "beat_before": beat,
                "beat_after": session.overlay.get_current_beat_id(),
                "http_status": response.status_code,
                "latency_s": round(time.monotonic() - start, 3),
                "narrative": body.get("narrative", ""),
                "branches": body.get("branches", []), "env_updates": body.get("env_updates"),
                "combat_briefing": body.get("combat_briefing"),
                "error": body.get("error"),
            }
            if body.get("combat_briefing"):
                encounter = body["combat_briefing"]["encounter_id"]
                avoid = ctx["client"].post(f"/api/sessions/{session.id}/combat/start", json={
                    "encounter_id": encounter, "approach_id": "negotiate",
                })
                rec["approach_http_status"] = avoid.status_code
                rec["approach_result"] = avoid.get_json()
            report["rounds"].append(rec)
            report["completed_beats"] = session.overlay.get_beat_state().get("completed_beats", [])
            report["quest_states"] = session.overlay.get_quest_states()
            report["actual_usage"] = session.total_usage
            report["visited_beats"] = list(dict.fromkeys(seen))
            write_report(args.out, report)
            print(f"  HTTP {response.status_code}; {rec['latency_s']}s; next={rec['beat_after']}; chars={len(rec['narrative'])}", flush=True)
            if response.status_code != 200 or not rec["narrative"]:
                break
            if set(ctx["manifest"]["beats"]) <= set(report["completed_beats"]):
                break
        report["missing_beats"] = sorted(set(ctx["manifest"]["beats"]) - set(report.get("completed_beats", [])))
        report["terminal_state_present"] = session.overlay.get_current_beat() is None
        quest_states = session.overlay.get_quest_states()
        report["quest_automation_complete"] = all(
            quest_states.get(qid, {}).get("status") == "completed"
            for qid in report["expected_quests"]
        )
        latencies = [r["latency_s"] for r in report["rounds"]]
        report["median_round_s"] = statistics.median(latencies) if latencies else None
        all_http_ok = bool(report["rounds"]) and all(r["http_status"] == 200 and r["narrative"] for r in report["rounds"])
        report["verdict"] = "incomplete"
        if all_http_ok and not report["missing_beats"]:
            report["verdict"] = (
                "pass" if report["terminal_state_present"] and report["quest_automation_complete"]
                else "beats_complete_with_product_gaps"
            )
        write_report(args.out, report)
        print(json.dumps({k: report.get(k) for k in (
            "verdict", "model", "missing_beats", "terminal_state_present", "quest_automation_complete", "median_round_s",
        )}, ensure_ascii=False), flush=True)
        return 0 if report["verdict"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
