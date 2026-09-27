"""剧情参考大纲（Story Outline）—— LLM 生成剧情节点的「参考条目」。

动态剧情树（`session_overlay.commit_tree_step`）的每个节点都是 LLM 现场生成的，
但生成需要**参考**：当前处在哪一幕、这一幕必须保留哪些节拍、下一步有哪些候选
走向、哪一幕应当出现战斗。老的剧情文件用 `## 章节 N：` + `#### beat_id` 骨架提供
这些参考；而像「彼岸双生」这类以「## 第一幕：…」+ `**必须保留的节拍**` 写成的
护栏式剧情没有节拍骨架，会话里既没有 beat_state，也没有可校验的
target_beat_id，分支只能凭空生成。

本模块把两种来源统一成同一份**参考大纲**（outline）：

- **启发式解析**（`heuristic_outline`）：不依赖 LLM，从 `## 第N幕：` / `## 章节 N：` /
  `## 路线 X：` 标题与 `**必须保留的节拍**` 等粗体键确定性地切出章节 → 节拍；
  单测与无 LLM 环境下的兜底。
- **LLM 生成**（`generate_outline_with_llm`）：把指定世界书里的参考条目
  （剧情条目 + 世界/角色/地点/阵营/物品）交给模型，产出章节/节拍/战斗需求/
  分支方向的结构化 JSON；解析失败回落启发式结果，绝不把错误伪装成大纲。

大纲以**世界书系统层条目**（uid = `story_outline_<plot_id>`，围栏 ```json story-outline）
持久化：与节点图 / 节点绑定条目同构——永不注入叙事上下文，随书导入导出。
会话创建时拷贝一份进 overlay（`story_outline`），偏离检测生成的新分支章节只
改会话副本，不回写书。

大纲结构（schema_version=1）::

    {
      "schema_version": 1, "plot_id": "beyond_twin", "title": "彼岸双生",
      "worldbook_id": "beyond-twin", "source": "llm" | "heuristic",
      "generated_at": 1790000000.0, "reference_uids": ["plots_beyond_twin_index", ...],
      "chapters": [{
        "id": "act_1", "title": "门前的猫", "summary": "...",
        "kind": "main" | "branch",
        "origin": {"type": "authored" | "llm" | "deviation", "round": 0, "from_node_id": ""},
        "beats": [{
          "id": "beat_act1_1", "title": "...", "summary": "...", "content": "...",
          "must_keep": "...", "guidance": "...",
          "combat": null | {"required": true, "description": "...", "enemies": [...],
                            "band": "T1", "node_id": "enc_xxx"},
          "branches": [{"label": "...", "intent": "...", "target_beat_id": "beat_x" | null}]
        }]
      }]
    }

`outline_to_beats` 把大纲折算成 `session_overlay._parse_narrative_beats` 同构的
章节/节拍列表（含 `[COMBAT:node_id]` 标记），因此节拍推进 / 路线图 / 分支落点 /
战斗目标等既有机制对大纲会话原样成立。
"""

from __future__ import annotations

import json
import logging
import re
import time

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1
ENTRY_UID_PREFIX = "story_outline_"
WORLD_BOOK_FENCE = "story-outline"
ENTRY_TYPE = "story_outline"
_EXT_NAMESPACE = "arknights_tavern"
_FENCE_RE = re.compile(r"```json\s+story-outline\s*\n(.*?)\n```", re.DOTALL)

MAX_CHAPTERS = 40
MAX_BEATS_PER_CHAPTER = 12
MAX_BRANCHES_PER_BEAT = 6
#: 一个参考节拍至少叙述几轮才允许 beat_complete 推进（LLM 几乎每轮都判定「场景结束」）
DEFAULT_MIN_ROUNDS = 2
#: 启发式切幕时一幕只有一个节拍，一幕的内容远多于一个场景，给更多轮数
HEURISTIC_ACT_MIN_ROUNDS = 3

# 章节标题：## 第一幕：门前的猫 / ## 第1章：… / ## 章节 1：… / ## Act 1: …
_ACT_HEADING_RE = re.compile(
    r"^##\s+(?:第\s*([一二三四五六七八九十百\d]+)\s*[幕章节部回]|章节\s*(\d+)|Act\s*(\d+))\s*[：:]\s*(.+?)\s*$",
    re.IGNORECASE,
)
# 续写方向：## 路线 A：回应
_ROUTE_HEADING_RE = re.compile(r"^##\s+路线\s*([A-Za-z0-9一二三四五六七八九十]+)\s*[：:]\s*(.+?)\s*$")
_BOLD_KEY_RE = re.compile(r"^\*\*([^*]+?)\*\*\s*[：:]\s*(.*)$")
_COMBAT_HINT_RE = re.compile(
    r"袭击|交火|战斗|打斗|突袭|埋伏|开火|武装|暴动|暴走|失控|自主行动事故|追击|围攻|冲突升级|动手")

_CN_NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}


class OutlineError(ValueError):
    """大纲结构非法。"""


def _cn_to_int(text: str) -> int:
    text = str(text or "").strip()
    if text.isdigit():
        return int(text)
    total = 0
    if text.startswith("十"):
        total = 10
        text = text[1:]
    for ch in text:
        if ch == "十":
            total = max(total, 1) * 10
        elif ch in _CN_NUM:
            total += _CN_NUM[ch]
    return total or 1


def _slug(text: str, fallback: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_]+", "_", str(text or "")).strip("_").lower()
    return slug or fallback


def _first_sentence(text: str, limit: int = 80) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    if not text:
        return ""
    m = re.search(r"[。！？!?]", text)
    head = text[: m.end()] if m and m.end() <= limit + 20 else text
    return head[:limit]


# ── 启发式解析（无 LLM 兜底） ──

def _split_sections(body: str) -> list[tuple[str, list[str]]]:
    """按 `## ` 标题切分正文，返回 [(heading_line, lines)]（首段无标题时 heading 为空）。"""
    sections: list[tuple[str, list[str]]] = []
    heading = ""
    buf: list[str] = []
    for line in str(body or "").split("\n"):
        if line.startswith("## "):
            sections.append((heading, buf))
            heading, buf = line.rstrip(), []
            continue
        buf.append(line)
    sections.append((heading, buf))
    return sections


def _parse_act_body(lines: list[str]) -> dict:
    """从一幕的正文里抽 content / must_keep / guidance。"""
    paragraphs: list[str] = []
    must_keep: list[str] = []
    guidance: list[str] = []
    para: list[str] = []

    def flush_para():
        if para:
            paragraphs.append(" ".join(s.strip() for s in para if s.strip()))
            para.clear()

    for line in lines:
        stripped = line.strip()
        if not stripped:
            flush_para()
            continue
        if stripped.startswith("#"):
            flush_para()
            continue
        m = _BOLD_KEY_RE.match(stripped)
        if m:
            flush_para()
            key, val = m.group(1).strip(), m.group(2).strip()
            if "必须保留" in key or "必留" in key:
                must_keep.append(val)
            else:
                guidance.append(f"{key}：{val}")
            continue
        para.append(stripped)
    flush_para()
    return {
        "content": "\n".join(p for p in paragraphs if p),
        "must_keep": "；".join(m for m in must_keep if m),
        "guidance": "\n".join(g for g in guidance if g),
    }


def heuristic_outline(meta: dict, body: str, *, worldbook_id: str = "") -> dict:
    """确定性地从剧情文档切出参考大纲（每幕一个节拍；续写路线成为分支章节）。

    适用于「## 第N幕：」护栏式剧情；老式 `## 章节 N：` 文档也能切出章节级大纲，
    但那类文档本就有节拍骨架，正常不会走到这里。
    """
    meta = dict(meta or {})
    plot_id = str(meta.get("id") or "")
    chapters: list[dict] = []
    routes: list[dict] = []
    for heading, lines in _split_sections(body):
        if not heading:
            continue
        act = _ACT_HEADING_RE.match(heading)
        if act:
            num = _cn_to_int(act.group(1) or act.group(2) or act.group(3) or str(len(chapters) + 1))
            title = act.group(4).strip()
            parsed = _parse_act_body(lines)
            cid = f"act_{num}"
            content = parsed["content"]
            combat = None
            if _COMBAT_HINT_RE.search(content + parsed["must_keep"]):
                combat = {"required": False, "description": _first_sentence(content, 60),
                          "enemies": [], "band": "T1", "node_id": "", "suggested": True}
            chapters.append({
                "id": cid, "title": title, "summary": _first_sentence(content),
                "kind": "main", "origin": {"type": "authored", "round": 0, "from_node_id": ""},
                "beats": [{
                    "id": f"beat_{cid}_1", "title": title,
                    "summary": _first_sentence(content),
                    "content": content, "must_keep": parsed["must_keep"],
                    "guidance": parsed["guidance"], "combat": combat, "branches": [],
                    "min_rounds": HEURISTIC_ACT_MIN_ROUNDS,
                }],
            })
            continue
        route = _ROUTE_HEADING_RE.match(heading)
        if route:
            parsed = _parse_act_body(lines)
            rid = f"route_{_slug(route.group(1), str(len(routes) + 1))}"
            routes.append({
                "id": rid, "title": route.group(2).strip(),
                "summary": _first_sentence(parsed["content"]),
                "kind": "branch", "origin": {"type": "authored", "round": 0, "from_node_id": ""},
                "beats": [{
                    "id": f"beat_{rid}_1", "title": route.group(2).strip(),
                    "summary": _first_sentence(parsed["content"]),
                    "content": parsed["content"], "must_keep": "",
                    "guidance": parsed["guidance"], "combat": None, "branches": [],
                }],
            })

    # 续写路线挂到最后一幕：作为该幕的作者分支（target 指向路线首节拍）
    if chapters and routes:
        last_beat = chapters[-1]["beats"][-1]
        last_beat["branches"] = [
            {"label": r["title"][:30], "intent": "续写路线", "target_beat_id": r["beats"][0]["id"]}
            for r in routes
        ][:MAX_BRANCHES_PER_BEAT]
    chapters.extend(routes)

    outline = {
        "schema_version": SCHEMA_VERSION,
        "plot_id": plot_id,
        "title": str(meta.get("name") or plot_id),
        "worldbook_id": str(worldbook_id or meta.get("worldbook_id") or ""),
        "source": "heuristic",
        "generated_at": time.time(),
        "reference_uids": [],
        "chapters": chapters,
    }
    return normalize_outline(outline, plot_id=plot_id)


# ── 规范化与校验 ──

def normalize_outline(doc: dict, *, plot_id: str = "", worldbook_id: str = "") -> dict:
    """结构校验 + 默认值回填 + id 去重；非法结构抛 OutlineError。

    不删除未知字段（前端 / 后续扩展可透传）。
    """
    if not isinstance(doc, dict):
        raise OutlineError("大纲应为 JSON 对象")
    out = dict(doc)
    out["schema_version"] = int(out.get("schema_version") or SCHEMA_VERSION)
    out["plot_id"] = str(out.get("plot_id") or plot_id or "")
    if not out["plot_id"]:
        raise OutlineError("大纲缺少 plot_id")
    out["title"] = str(out.get("title") or out["plot_id"])
    out["worldbook_id"] = str(worldbook_id or out.get("worldbook_id") or "")
    out["source"] = str(out.get("source") or "llm")
    out["generated_at"] = float(out.get("generated_at") or time.time())
    refs = out.get("reference_uids") or []
    out["reference_uids"] = [str(u) for u in refs if isinstance(u, str) and u]

    chapters = out.get("chapters")
    if not isinstance(chapters, list) or not chapters:
        raise OutlineError("大纲至少需要 1 个章节")
    if len(chapters) > MAX_CHAPTERS:
        raise OutlineError(f"章节数 {len(chapters)} 超过上限 {MAX_CHAPTERS}")

    seen_ch: set[str] = set()
    seen_beat: set[str] = set()
    norm_chapters: list[dict] = []
    for ci, ch in enumerate(chapters):
        if not isinstance(ch, dict):
            raise OutlineError(f"chapters[{ci}] 不是对象")
        cid = _slug(ch.get("id") or "", f"ch_{ci + 1}")
        base = cid
        n = 2
        while cid in seen_ch:
            cid = f"{base}_{n}"
            n += 1
        seen_ch.add(cid)
        kind = str(ch.get("kind") or "main")
        if kind not in ("main", "branch"):
            kind = "main"
        origin = ch.get("origin") if isinstance(ch.get("origin"), dict) else {}
        beats_in = ch.get("beats")
        if not isinstance(beats_in, list) or not beats_in:
            raise OutlineError(f"章节 {cid} 至少需要 1 个节拍")
        if len(beats_in) > MAX_BEATS_PER_CHAPTER:
            raise OutlineError(f"章节 {cid} 节拍数 {len(beats_in)} 超过上限 {MAX_BEATS_PER_CHAPTER}")
        beats: list[dict] = []
        for bi, b in enumerate(beats_in):
            if not isinstance(b, dict):
                raise OutlineError(f"章节 {cid} 的 beats[{bi}] 不是对象")
            bid = _slug(b.get("id") or "", f"beat_{cid}_{bi + 1}")
            if not bid.startswith("beat_"):
                bid = "beat_" + bid
            base = bid
            n = 2
            while bid in seen_beat:
                bid = f"{base}_{n}"
                n += 1
            seen_beat.add(bid)
            combat = b.get("combat")
            if combat is not None:
                if not isinstance(combat, dict):
                    combat = {"required": bool(combat)}
                combat = {
                    "required": bool(combat.get("required", True)),
                    "description": str(combat.get("description") or "")[:200],
                    "enemies": [str(e) for e in (combat.get("enemies") or []) if str(e).strip()][:8],
                    "band": str(combat.get("band") or "T1").upper(),
                    "node_id": str(combat.get("node_id") or ""),
                    **({"suggested": True} if combat.get("suggested") else {}),
                }
                if combat["band"] not in ("T0", "T1", "T2", "T3", "T4"):
                    combat["band"] = "T1"
            branches_in = b.get("branches") if isinstance(b.get("branches"), list) else []
            branches: list[dict] = []
            for br in branches_in[:MAX_BRANCHES_PER_BEAT]:
                if not isinstance(br, dict):
                    continue
                label = str(br.get("label") or "").strip()
                if not label:
                    continue
                target = br.get("target_beat_id")
                branches.append({
                    "label": label[:30],
                    "intent": (str(br.get("intent")).strip()[:20] or None) if br.get("intent") else None,
                    "target_beat_id": str(target) if target else None,
                })
            content = str(b.get("content") or "")
            try:
                min_rounds = max(1, min(8, int(b.get("min_rounds") or DEFAULT_MIN_ROUNDS)))
            except (TypeError, ValueError):
                min_rounds = DEFAULT_MIN_ROUNDS
            beats.append({
                **{k: v for k, v in b.items() if k not in ("id", "combat", "branches", "min_rounds")},
                "id": bid,
                "min_rounds": min_rounds,
                "title": str(b.get("title") or b.get("summary") or bid)[:40],
                "summary": str(b.get("summary") or _first_sentence(content))[:120],
                "content": content,
                "must_keep": str(b.get("must_keep") or ""),
                "guidance": str(b.get("guidance") or ""),
                "combat": combat,
                "branches": branches,
            })
        norm_chapters.append({
            **{k: v for k, v in ch.items() if k not in ("id", "beats", "kind", "origin")},
            "id": cid,
            "title": str(ch.get("title") or cid)[:60],
            "summary": str(ch.get("summary") or beats[0]["summary"])[:200],
            "kind": kind,
            "origin": {
                **{k: v for k, v in origin.items() if k not in ("type", "round", "from_node_id")},
                "type": str(origin.get("type") or ("llm" if out["source"] == "llm" else "authored")),
                "round": int(origin.get("round") or 0),
                "from_node_id": str(origin.get("from_node_id") or ""),
            },
            "beats": beats,
        })

    # 分支落点只能指向大纲里真实存在的节拍；无效目标置空（不编造）
    for ch in norm_chapters:
        for b in ch["beats"]:
            for br in b["branches"]:
                if br["target_beat_id"] and br["target_beat_id"] not in seen_beat:
                    br["target_beat_id"] = None
            if b.get("choice_required"):
                if not any(br.get("target_beat_id") and br["target_beat_id"] != b["id"]
                           for br in b["branches"]):
                    raise OutlineError("choice_required 节拍必须有可离开的有效分支落点")
    out["chapters"] = norm_chapters
    return out


def beat_ids(outline: dict) -> list[str]:
    return [b["id"] for ch in (outline or {}).get("chapters", []) for b in ch.get("beats", [])]


def find_beat(outline: dict, beat_id: str) -> tuple[dict | None, dict | None]:
    for ch in (outline or {}).get("chapters", []):
        for b in ch.get("beats", []):
            if b.get("id") == beat_id:
                return ch, b
    return None, None


# ── 折算成会话节拍骨架 ──

def outline_to_beats(outline: dict) -> list[dict]:
    """大纲 → `_parse_narrative_beats` 同构结构（供节拍推进 / 路线图 / 分支落点复用）。

    `combat.node_id` 非空时把 `[COMBAT:node_id]` 追加进 content，让
    `get_current_beat_combat_id` 与节点绑定 / 进度统计原样生效。
    """
    chapters: list[dict] = []
    for ch in (outline or {}).get("chapters", []):
        beats: list[dict] = []
        for b in ch.get("beats", []):
            content = str(b.get("content") or "")
            combat = b.get("combat") or None
            node_id = str((combat or {}).get("node_id") or "")
            if node_id and f"[COMBAT:{node_id}]" not in content:
                content = (content + f"\n[COMBAT:{node_id}]").strip()
            authored = [
                {"label": br["label"], "intent": br.get("intent"),
                 "target_beat_id": br.get("target_beat_id"), "source": "author"}
                for br in b.get("branches", []) if br.get("label")
            ]
            beats.append({
                "id": b["id"],
                "title": b.get("title") or "",
                "summary": b.get("summary") or "",
                "content": content,
                "dialogue": "",
                "reveals": b.get("guidance") or "",
                "must_keep": b.get("must_keep") or "",
                "keep_on_deviate": bool(b.get("must_keep")),
                "stat_check": None,
                "option_directions": [br["label"] for br in b.get("branches", [])],
                "authored_branches": authored,
                "choice_required": b.get("choice_required") is True,
                "discovery_paths": [],
                "combat": combat,
                "min_rounds": int(b.get("min_rounds") or DEFAULT_MIN_ROUNDS),
                "kind": ch.get("kind") or "main",
            })
        chapters.append({
            "title": ch.get("title") or ch.get("id") or "",
            "id": ch.get("id") or "",
            "summary": ch.get("summary") or "",
            "kind": ch.get("kind") or "main",
            "origin": ch.get("origin") or {},
            "beats": beats,
        })
    return chapters


# ── 参考条目收集 ──

_REFERENCE_PREFIXES = (
    ("plots_", "剧情"), ("world_", "世界"), ("characters_", "角色"), ("Location_", "地点"),
    ("locations_", "地点"), ("factions_", "阵营"), ("items_", "物品"), ("enemies_", "敌人"),
    ("rules_", "规则"), ("environment_", "环境"),
)


def _entry_field(entry, name: str, default=None):
    if isinstance(entry, dict):
        return entry.get(name, default)
    return getattr(entry, name, default)


def collect_reference_entries(book, plot_id: str, *, per_entry_chars: int = 1200,
                              total_chars: int = 12000) -> list[dict]:
    """从世界书挑出可作为大纲参考的条目（剧情条目优先，系统层条目排除）。"""
    from world_book import is_system_entry

    rows: list[dict] = []
    plot_key = str(plot_id or "")
    for entry in (getattr(book, "entries", None) or []):
        if not _entry_field(entry, "enabled", True):
            continue
        if is_system_entry(entry):
            continue
        uid = str(_entry_field(entry, "uid", "") or "")
        content = str(_entry_field(entry, "content", "") or "").strip()
        if not content:
            continue
        kind = ""
        for prefix, label in _REFERENCE_PREFIXES:
            if uid.startswith(prefix):
                kind = label
                break
        if not kind:
            kind = str(_entry_field(entry, "group", "") or "其他")
        is_plot = uid.startswith("plots_") and (not plot_key or plot_key in uid)
        rows.append({
            "uid": uid, "name": str(_entry_field(entry, "name", "") or uid),
            "kind": kind, "content": content[:per_entry_chars],
            "priority": 0 if is_plot else (1 if kind in ("世界", "角色") else 2),
        })
    rows.sort(key=lambda r: (r["priority"], r["uid"]))
    picked: list[dict] = []
    used = 0
    for r in rows:
        if used + len(r["content"]) > total_chars and picked:
            continue
        picked.append(r)
        used += len(r["content"])
    return picked


def format_reference_block(refs: list[dict]) -> str:
    parts = []
    for r in refs:
        parts.append(f"### [{r['kind']}] {r['name']}（uid={r['uid']}）\n{r['content']}")
    return "\n\n".join(parts)


# ── LLM 生成 ──

_OUTLINE_SYSTEM = """\
<role>
你是文字冒险游戏的剧情结构设计师。你的任务是把世界书里的剧情条目与设定条目
整理成一份**参考大纲**：章节 → 节拍，标出每个节拍必须保留的事实、是否需要战斗、
以及玩家可以走向的分支。大纲是叙事护栏与参考，不是逐字剧本。
</role>

<core_rules>
- MUST：只输出一个 JSON 对象，不要输出其他任何文字
- MUST：章节顺序与原作时间线一致；每章 1-3 个节拍，节拍粒度是「一个场景/一次转折」
- MUST：must_keep 只写原文明确要求保留的事实；没有就留空字符串
- MUST：只有原文明确出现敌对冲突、袭击、失控事故等需要交手的场面时，才把 combat.required 设为 true，
  并在 description 里写清交手对象与处境；enemies 只能从<available_enemies>列表选，没有合适的就留空数组
- MUST：branches 的 target_beat_id 只能引用本大纲里其它节拍的 id，或 null（表示开启全新方向）
- MUST：严禁在 JSON 字符串里使用英文双引号
- SHOULD：id 用英文小写下划线；章节 id 形如 act_1，节拍 id 形如 beat_act1_meet
- SHOULD：原文的「续写方向 / 路线」整理为 kind 为 branch 的章节，并从最后一幕的节拍用 branches 指向它们
</core_rules>

<output_format>
{
  "title": "剧情名",
  "chapters": [
    {
      "id": "act_1", "title": "章节标题", "summary": "一句话概要", "kind": "main",
      "beats": [
        {
          "id": "beat_act1_1", "title": "节拍标题", "summary": "≤50字概要",
          "content": "这个节拍里发生什么（100-200字，给叙述者参考）",
          "must_keep": "必须保留的事实；没有则空字符串",
          "guidance": "情感目标 / 悬疑原则 / 调查线索等护栏；没有则空字符串",
          "combat": null,
          "branches": [{"label": "≤15字行动", "intent": "方向标签", "target_beat_id": "beat_act1_2"}]
        }
      ]
    }
  ]
}
combat 非 null 时格式：{"required": true, "description": "交手处境", "enemies": ["敌人名"], "band": "T0-T4 之一"}
</output_format>"""


def build_outline_messages(meta: dict, body: str, refs: list[dict],
                           available_enemies: list[str] | None = None) -> list[dict]:
    meta = dict(meta or {})
    head = [
        f"剧情 id：{meta.get('id', '')}",
        f"剧情名：{meta.get('name', '')}",
        f"摘要：{meta.get('summary', '')}",
    ]
    if meta.get("opening_scene"):
        head.append(f"开场：{meta['opening_scene']}")
    clock = meta.get("tension_clock") or {}
    if isinstance(clock, dict) and clock.get("stages"):
        stages = "；".join(f"{s[0]}：{s[1]}" for s in clock["stages"] if isinstance(s, (list, tuple)) and len(s) >= 2)
        head.append(f"定时炸弹阶段：{stages}")
    parts = [
        "<plot_meta>\n" + "\n".join(head) + "\n</plot_meta>",
        "<plot_document>\n" + str(body or "").strip()[:9000] + "\n</plot_document>",
    ]
    if refs:
        parts.append("<reference_entries>\n" + format_reference_block(refs) + "\n</reference_entries>")
    enemies = [e for e in (available_enemies or []) if e]
    parts.append("<available_enemies>\n" + ("、".join(enemies) if enemies else "（无）") + "\n</available_enemies>")
    parts.append("请按 <output_format> 输出这部剧情的参考大纲 JSON。")
    return [
        {"role": "system", "content": _OUTLINE_SYSTEM},
        {"role": "user", "content": "\n\n".join(parts)},
    ]


def extract_json_object(text: str) -> dict | None:
    """从模型输出里取出第一个顶层 JSON 对象（容忍 ``` 围栏与前后杂讯）。"""
    text = str(text or "").strip()
    if not text:
        return None
    fence = re.search(r"```(?:json)?\s*\n(.*?)\n```", text, re.DOTALL)
    candidates = [fence.group(1)] if fence else []
    candidates.append(text)
    start = text.find("{")
    if start >= 0:
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    candidates.append(text[start:i + 1])
                    break
    for cand in candidates:
        try:
            data = json.loads(cand)
        except ValueError:
            continue
        if isinstance(data, dict):
            return data
    return None


def generate_outline_with_llm(llm, meta: dict, body: str, *, book=None,
                              worldbook_id: str = "",
                              available_enemies: list[str] | None = None,
                              max_tokens: int = 8192) -> dict:
    """真实 LLM 生成参考大纲；解析失败回落启发式大纲并在 `source` 标明。

    返回值附带 `generation`：{"ok": bool, "error": str | None, "usage": dict | None}。
    """
    meta = dict(meta or {})
    plot_id = str(meta.get("id") or "")
    refs = collect_reference_entries(book, plot_id) if book is not None else []
    messages = build_outline_messages(meta, body, refs, available_enemies)
    fallback = heuristic_outline(meta, body, worldbook_id=worldbook_id)
    fallback["reference_uids"] = [r["uid"] for r in refs]
    if llm is None:
        fallback["generation"] = {"ok": False, "error": "无可用 LLM", "usage": None}
        return fallback
    text, usage, data, finish = "", None, None, None
    for attempt in range(2):
        try:
            result = llm.chat(messages, stream=False, max_tokens=max_tokens, thinking="none")
        except Exception as exc:  # LLMError 系列：结构化上抛，不伪装
            logger.warning("参考大纲生成失败（%s），回落启发式大纲", exc)
            fallback["generation"] = {"ok": False, "error": str(exc), "usage": None}
            return fallback
        text = result.get("content", "") if isinstance(result, dict) else str(result)
        usage = result.get("usage") if isinstance(result, dict) else None
        finish = result.get("finish_reason") if isinstance(result, dict) else None
        data = extract_json_object(text)
        if data is not None:
            break
        # 空响应 / 截断 / 非 JSON：推理型模型的输出预算抖动明显，重试一次可吸收随机性
        logger.warning("参考大纲输出不是 JSON（len=%d, finish=%s），%s",
                       len(text or ""), finish, "重试一次" if attempt == 0 else "回落启发式大纲")
    if data is None:
        fallback["generation"] = {
            "ok": False, "usage": usage, "finish_reason": finish,
            "error": "模型输出不是 JSON 对象" + ("（输出被截断）" if finish == "length" else ""),
            "raw_head": (text or "")[:200],
            "raw_tail": (text or "")[-200:],
            "raw": text or "",
        }
        return fallback
    data.setdefault("plot_id", plot_id)
    data.setdefault("title", meta.get("name") or plot_id)
    data["worldbook_id"] = worldbook_id or str(meta.get("worldbook_id") or "")
    data["source"] = "llm"
    data["generated_at"] = time.time()
    data["reference_uids"] = [r["uid"] for r in refs]
    try:
        outline = normalize_outline(data, plot_id=plot_id, worldbook_id=data["worldbook_id"])
    except OutlineError as exc:
        logger.warning("参考大纲结构非法（%s），回落启发式大纲", exc)
        fallback["generation"] = {"ok": False, "error": f"结构非法：{exc}", "usage": usage}
        return fallback
    # 模型没识别出战斗但启发式命中关键词的幕：保留 suggested 提示，供后续人工/生成器决定
    _merge_suggested_combat(outline, fallback)
    outline["generation"] = {"ok": True, "error": None, "usage": usage}
    return outline


def _merge_suggested_combat(outline: dict, heuristic: dict) -> None:
    by_title = {ch["title"]: ch for ch in heuristic.get("chapters", [])}
    for ch in outline.get("chapters", []):
        src = by_title.get(ch.get("title"))
        if not src:
            continue
        hint = (src["beats"][0].get("combat") or None) if src.get("beats") else None
        if not hint or any(b.get("combat") for b in ch.get("beats", [])):
            continue
        ch["beats"][-1]["combat"] = dict(hint)


# ── 世界书条目编解码与存取 ──

def entry_uid(plot_id: str) -> str:
    return f"{ENTRY_UID_PREFIX}{plot_id}"


def encode_outline_for_worldbook(outline: dict) -> dict:
    payload = {k: v for k, v in (outline or {}).items() if k not in ("generation",)}
    plot_id = str(payload.get("plot_id") or "")
    compact = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return {
        "uid": entry_uid(plot_id),
        "name": f"参考大纲：{payload.get('title') or plot_id}",
        "content": "\n".join([f"```json {WORLD_BOOK_FENCE}", compact, "```"]),
        "trigger_keys": [],
        "always_active": False,
        "position": 1,
        "raw": {"extensions": {_EXT_NAMESPACE: {"entry_type": ENTRY_TYPE, "plot_id": plot_id}}},
    }


def is_outline_entry(entry) -> bool:
    raw = _entry_field(entry, "raw", None) or {}
    ext = ((raw.get("extensions") if isinstance(raw, dict) else None) or {}).get(_EXT_NAMESPACE) or {}
    if ext.get("entry_type") == ENTRY_TYPE:
        return True
    return bool(_FENCE_RE.search(str(_entry_field(entry, "content", "") or "")))


def decode_outline_entry(entry) -> dict | None:
    if not is_outline_entry(entry):
        return None
    match = _FENCE_RE.search(str(_entry_field(entry, "content", "") or ""))
    if not match:
        raise OutlineError("参考大纲条目缺少 ```json story-outline 代码块")
    try:
        data = json.loads(match.group(1))
    except ValueError as exc:
        raise OutlineError(f"参考大纲条目 JSON 解析失败: {exc}") from exc
    if not isinstance(data, dict):
        raise OutlineError("参考大纲条目内容应为 JSON 对象")
    return data


def load_outline(book_mgr, book_id: str, plot_id: str) -> dict | None:
    """从世界书读参考大纲；不存在或书不存在返回 None。"""
    if book_mgr is None or not book_id:
        return None
    book = book_mgr.load(book_id)
    if book is None:
        return None
    uid = entry_uid(plot_id)
    for entry in book.entries:
        if entry.uid == uid or (is_outline_entry(entry) and _outline_plot_id(entry) == plot_id):
            try:
                data = decode_outline_entry(entry)
                return normalize_outline(data, plot_id=plot_id, worldbook_id=book_id) if data else None
            except OutlineError:
                logger.warning("世界书 %s 的参考大纲条目损坏，忽略", book_id, exc_info=True)
                return None
    return None


def _outline_plot_id(entry) -> str:
    raw = _entry_field(entry, "raw", None) or {}
    ext = ((raw.get("extensions") if isinstance(raw, dict) else None) or {}).get(_EXT_NAMESPACE) or {}
    return str(ext.get("plot_id") or "")


def save_outline(book_mgr, book_id: str, outline: dict) -> dict:
    """把参考大纲写成书内系统层条目（upsert，同书加锁）。返回落盘后的大纲。"""
    from world_book import WorldBookEntry

    outline = normalize_outline(outline, worldbook_id=book_id)
    payload = encode_outline_for_worldbook(outline)
    with book_mgr.book_lock(book_id):
        book = book_mgr.load(book_id)
        if book is None:
            raise OutlineError(f"世界书不存在: {book_id}")
        new_entry = WorldBookEntry.from_dict(payload)
        replaced = False
        for i, entry in enumerate(book.entries):
            if entry.uid == payload["uid"] or (is_outline_entry(entry) and _outline_plot_id(entry) == outline["plot_id"]):
                book.entries[i] = new_entry
                replaced = True
                break
        if not replaced:
            book.entries.append(new_entry)
        if hasattr(book, "bump_edit_revision"):
            book.bump_edit_revision()
        book_mgr.save(book)
    return outline


def delete_outline(book_mgr, book_id: str, plot_id: str) -> bool:
    with book_mgr.book_lock(book_id):
        book = book_mgr.load(book_id)
        if book is None:
            return False
        before = len(book.entries)
        removed_uids = {e.uid for e in book.entries
                        if e.uid == entry_uid(plot_id) or (is_outline_entry(e) and _outline_plot_id(e) == plot_id)}
        book.entries = [e for e in book.entries if e.uid not in removed_uids]
        if len(book.entries) == before:
            return False
        for uid in removed_uids:
            book.entry_group_map.pop(uid, None)
        if hasattr(book, "bump_edit_revision"):
            book.bump_edit_revision()
        book_mgr.save(book)
    return True


# ── 偏离分支：把新的走向追加成分支章节 ──

def append_branch_chapter(outline: dict, branch: dict, *, round_num: int = 0,
                          from_node_id: str = "", parent_beat_id: str = "") -> dict:
    """偏离检测产出的新走向 → 追加为 kind=branch 的章节，返回新章节（已规范化）。

    branch: {"title", "summary", "beats": [{title, summary, content, must_keep?, combat?}]}
    节拍 id 形如 `beat_dev<n>_<i>`，保证与既有节拍不冲突。
    """
    existing = set(beat_ids(outline))
    n = 1
    while f"dev_{n}" in {ch.get("id") for ch in outline.get("chapters", [])}:
        n += 1
    cid = f"dev_{n}"
    beats_in = branch.get("beats") if isinstance(branch.get("beats"), list) else []
    if not beats_in:
        beats_in = [{"title": branch.get("title") or "新的走向",
                     "summary": branch.get("summary") or "", "content": branch.get("summary") or ""}]
    beats = []
    for i, b in enumerate(beats_in[:MAX_BEATS_PER_CHAPTER]):
        if not isinstance(b, dict):
            continue
        bid = f"beat_{cid}_{i + 1}"
        while bid in existing:
            bid += "x"
        existing.add(bid)
        beats.append({**b, "id": bid, "branches": b.get("branches") or []})
    chapter = {
        "id": cid, "title": str(branch.get("title") or "新的走向")[:60],
        "summary": str(branch.get("summary") or "")[:200], "kind": "branch",
        "origin": {"type": "deviation", "round": int(round_num), "from_node_id": from_node_id,
                   "parent_beat_id": parent_beat_id},
        "beats": beats,
    }
    doc = dict(outline)
    doc["chapters"] = list(outline.get("chapters", [])) + [chapter]
    normalized = normalize_outline(doc, plot_id=outline.get("plot_id", ""),
                                   worldbook_id=outline.get("worldbook_id", ""))
    outline.clear()
    outline.update(normalized)
    return outline["chapters"][-1]
