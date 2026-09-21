"""Prompt 预览接口（A-2 / §3.2）：同一条执行路径、九类未插入原因、只读与确定性。

接口走真实代码：`PromptPreview` 路由 → `WorldBook.preview_prompt_injection` →
`eligible_uids_for` → `collect_matches` → `format_injection`，不 mock 任何一段。
"""
import copy
import hashlib
import json
import random
import re
import sys
from pathlib import Path

import pytest
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from world_book import DEFAULT_CATEGORIES, WorldBook, WorldBookEntry, WorldBookManager
from worldbook_scope import (
    ACTIVATION_ALWAYS, EXPANSION_NONE, EXPANSION_REQUIRES_CLOSURE,
)

#: R-2 的九类未插入原因
REASONS = ("not_in_scope", "node_binding_demoted", "disabled", "empty_content",
           "selective_reject", "keyword_miss", "secondary_miss",
           "probability_miss", "budget_exceeded")


def entry(uid, **kwargs):
    kwargs.setdefault("content", f"{uid} 的正文内容。")
    kwargs.setdefault("name", uid)
    kwargs.setdefault("category_id", "other")
    return WorldBookEntry(uid, **kwargs)


def book_fixture():
    """一本书同时覆盖九类未插入原因、稳定 / 动态两层与依赖带入。"""
    entries = [
        entry("world", content="泰拉世界：源石与天灾。", name="世界设定",
              always_active=True, position=0, depth=2, group_weight=100,
              category_id="worldview"),
        entry("lore", content="源石技艺的定义。", name="源石技艺",
              always_active=True, position=1, depth=4, group_weight=120),
        entry("dyn", content="动态常驻设定。", name="动态常驻",
              always_active=True, position=1, depth=4, group_weight=100),
        # 非 selective：主副键等价，命中「阿米娅」
        entry("kw", content="阿米娅的资料。", name="阿米娅条目",
              trigger_keys=["阿米娅"], secondary_keys=["罗德岛"], selective=False,
              position=1, depth=4, group_weight=300),
        # selective：主键命中但副键未命中
        entry("sec", content="阿米娅的罗德岛档案。", name="档案",
              trigger_keys=["阿米娅"], secondary_keys=["罗德岛"], selective=True,
              position=1, depth=4),
        # 主键全未命中；概率 1 保证不靠抽签蒙中
        entry("miss", content="银灰的资料。", name="银灰条目",
              trigger_keys=["银灰"], selective=False, probability=1,
              position=1, depth=4),
        # selective 且没有任何可编译的主键
        entry("selbad", content="没有主键的条目。", name="空主键",
              trigger_keys=[], secondary_keys=["罗德岛"], selective=True,
              position=1, depth=4),
        # 概率未中
        entry("prob", content="概率条目。", name="概率条目",
              trigger_keys=["阿米娅"], secondary_keys=["罗德岛"], selective=False,
              probability=50, position=1, depth=4),
        entry("off", content="停用条目。", name="停用条目", always_active=True,
              enabled=False, position=1, depth=4),
        # 正文空白：非常驻（常驻且空正文的条目**线上会被注入为空标题**，预览必须如实
        # 反映，因此那种构造不会出现 empty_content），关键词也不命中 → empty_content
        entry("blank", content="   ", name="空正文条目", trigger_keys=["银灰"],
              selective=False, position=1, depth=4),
        # 在书范围内，但会被 lore_scope.allowed 排除 → node_binding_demoted
        entry("nodeonly", content="只在某个节点注入。", name="节点限定",
              always_active=True, position=1, depth=4),
        # 既不是起点、也没有任何依赖指向它 → not_in_scope
        entry("outsider", content="游离条目。", name="游离条目", always_active=True,
              position=1, depth=4),
    ]
    roots = [{"entry_uid": "world", "activation": ACTIVATION_ALWAYS,
              "expansion": EXPANSION_REQUIRES_CLOSURE, "character_ids": []}]
    for item in entries:
        if item.uid in ("world", "outsider"):
            continue
        roots.append({"entry_uid": item.uid, "activation": ACTIVATION_ALWAYS,
                      "expansion": EXPANSION_NONE, "character_ids": []})
    return WorldBook(
        "book", "预览测试书", entries, categories=copy.deepcopy(DEFAULT_CATEGORIES),
        dependency_edges=[{"from_uid": "world", "to_uid": "lore"}],
        related_edges=[],
        dependency_rules={"roots": roots,
                          "root_rule": {"entry_uids": sorted(r["entry_uid"] for r in roots)},
                          "rejected": [], "edge_meta": {}},
        scope_mode="selective",
    )


@pytest.fixture
def api(tmp_path):
    from blueprints.worldbook import register
    manager = WorldBookManager(tmp_path)
    manager.save(book_fixture())
    app = Flask(__name__)
    app.config["TESTING"] = True
    register(app, {"worldbook": manager})
    return app.test_client(), manager, tmp_path


def preview(client, **body):
    body.setdefault("mode", "narrative")
    response = client.post("/api/worldbook/book/prompt-preview", json=body)
    assert response.status_code == 200, response.json
    return response.json


def dropped_map(payload):
    return {item["uid"]: item["reason"] for item in payload["dropped"]}


def order_uids(payload):
    return [item["uid"] for item in payload["order"]]


def lore_scope(book, **extra):
    """节点作用域快照：默认排除 `nodeonly`，形状同 overlay.get_active_lore_scope()。"""
    scope = {"book_id": book.id, "node_id": "node-1",
             "allowed": [e.uid for e in book.entries if e.uid != "nodeonly"],
             "pinned": [], "overrides": {}}
    scope.update(extra)
    return scope


def heading_names(text):
    """按出现顺序取出 `### 名称` 行的名称。"""
    return re.findall(r"^### (.+)$", text or "", flags=re.MULTILINE)


# ── 1. 确定性与响应形状 ──

def test_same_input_and_seed_returns_byte_identical_response(api):
    """同一输入 + 同一种子，连续两次请求逐字一致（§3.2 约束与验收）。"""
    client, _, _ = api
    body = {"mode": "narrative", "input_text": "阿米娅", "recent_text": "", "seed": 7}
    first = client.post("/api/worldbook/book/prompt-preview", json=body)
    second = client.post("/api/worldbook/book/prompt-preview", json=body)
    assert first.status_code == second.status_code == 200
    assert (json.dumps(first.json, sort_keys=True, ensure_ascii=False)
            == json.dumps(second.json, sort_keys=True, ensure_ascii=False))
    # 响应字段严格同构 WorldBookPromptPreviewDTO
    assert set(first.json) == {"mode", "order", "stable_text", "dynamic_text",
                               "sites", "skeleton", "dropped", "totals"}
    assert set(first.json["totals"]) == {"stable_tokens", "dynamic_tokens", "budget_tokens",
                                         "truncated", "candidate_count", "matched_count"}


def test_seed_decides_probability_entries_and_stays_reproducible(api):
    """概率条目按独立的 `random.Random(seed)` 抽签：换种子可改结果、同种子必同结果。

    构造 `probability=50` 的条目，扫描若干种子找出「抽中」与「未抽中」两个方向；
    若某个 Python 版本上两个方向都找不到（随机流不同），至少断言同种子必同结果。
    """
    client, _, _ = api
    included, excluded = set(), set()
    for seed in range(40):
        uids = order_uids(preview(client, input_text="阿米娅", seed=seed))
        assert uids == order_uids(preview(client, input_text="阿米娅", seed=seed)), \
            "同一种子必须给出同一结果"
        (included if "prob" in uids else excluded).add(seed)
    assert included and excluded, "probability=50 的条目应在不同种子下出现两种结果"


# ── 2. 九类未插入原因（R-2 / R-3）──

def test_dropped_reasons_cover_all_nine_kinds(api):
    """九类各有一条真实构造，且每条只报一个原因（R-3）。

    一次请求同时覆盖：预算设得很小，让「已通过触发」的条目落到 budget_exceeded，
    而关键词 / 概率阶段就出局的条目仍报它们各自的更靠前原因。
    """
    client, manager, _ = api
    payload = preview(client, input_text="阿米娅", seed=0, budget_tokens=1,
                      lore_scope=lore_scope(manager.load("book")))
    reasons = dropped_map(payload)
    # 1) 不在候选范围（不是起点、也没有依赖指向它）
    assert reasons["outsider"] == "not_in_scope"
    # 2) 在书范围内但被节点作用域排除
    assert reasons["nodeonly"] == "node_binding_demoted"
    # 3) 停用
    assert reasons["off"] == "disabled"
    # 4) 正文空白
    assert reasons["blank"] == "empty_content"
    # 5) selective 且主键为空 / 全部非法正则
    assert reasons["selbad"] == "selective_reject"
    # 6) 主键全未命中
    assert reasons["miss"] == "keyword_miss"
    # 7) selective 主键命中但副键全未命中
    assert reasons["sec"] == "secondary_miss"
    # 8) 关键词通过但抽签未中（seed=0 时该条目未中）
    assert reasons["prob"] == "probability_miss"
    # 9) 已通过触发但被预算跳过（只保留一条，其余进 budget_exceeded）
    assert reasons["kw"] == "budget_exceeded"
    assert payload["totals"]["truncated"] is True
    assert len(payload["order"]) == 1
    # 每条只报一个原因，且 reason 全在九类里
    assert set(reasons.values()) <= set(REASONS)
    assert len(reasons) == len(payload["dropped"])
    # dropped[] 覆盖全书条目：order[] 与 dropped[] 不相交、合起来就是全部条目
    assert set(order_uids(payload)).isdisjoint(reasons)
    assert len(reasons) + len(payload["order"]) == len(manager.load("book").entries)


def test_drop_reason_priority_follows_r2_order(api):
    """判定顺序不可调换：低编号原因优先于高编号原因。

    `outsider` 同时是「不在范围」与「常驻但正文正常」；`off` 同时停用且概率 1；
    `selbad` 同时是 selective 无主键与（若只按概率看）抽签未中。
    """
    client, _, _ = api
    reasons = dropped_map(preview(client, input_text="阿米娅", seed=0))
    assert reasons["outsider"] == "not_in_scope"        # 优先于 disabled/empty_content
    assert reasons["off"] == "disabled"                 # 优先于 keyword_miss
    assert reasons["blank"] == "empty_content"          # 优先于 keyword_miss
    assert reasons["selbad"] == "selective_reject"      # 优先于 probability_miss
    assert reasons["miss"] == "keyword_miss"            # 优先于 probability_miss
    assert reasons["sec"] == "secondary_miss"           # 优先于 probability_miss


def test_no_keyword_hit_means_keyword_miss_and_scope_entries_still_matched(api):
    """没有任何关键词命中时，触发型条目全部 keyword_miss；常驻条目照常进入 order[]。"""
    client, _, _ = api
    payload = preview(client, input_text="今天天气不错", seed=0)
    reasons = dropped_map(payload)
    for uid in ("kw", "sec", "miss", "prob"):
        assert reasons[uid] == "keyword_miss"
    assert {"world", "lore", "dyn"} <= set(order_uids(payload))
    # 依赖带入的条目带 requires 原因
    lore = next(item for item in payload["order"] if item["uid"] == "lore")
    assert "requires" in lore["reasons"]


# ── 3. 预算截断 ──

def test_budget_truncation_keeps_at_least_one_and_reports_skipped(api):
    """预算很小时：truncated 为真、被跳过者报 budget_exceeded、但至少保留一条。"""
    client, _, _ = api
    payload = preview(client, input_text="阿米娅", seed=0, budget_tokens=1)
    assert payload["totals"]["truncated"] is True
    assert payload["totals"]["budget_tokens"] == 1
    assert len(payload["order"]) >= 1, "format_injection 的「至少保留一条」语义必须保留"
    skipped = [item for item in payload["dropped"] if item["reason"] == "budget_exceeded"]
    assert skipped, "被预算跳过的条目必须可解释"
    # 只保留了一条（排序键最靠前的 world），其余已通过关键词/概率的条目都进 budget_exceeded
    assert len(payload["order"]) == 1
    assert payload["order"][0]["uid"] == "world"
    assert {item["uid"] for item in skipped} >= {"kw", "lore", "dyn"}
    # 预算不覆盖（默认 0 = 不限制）时不截断
    unlimited = preview(client, input_text="阿米娅", seed=0)
    assert unlimited["totals"]["truncated"] is False
    assert unlimited["totals"]["budget_tokens"] == 0
    assert {item["uid"] for item in unlimited["dropped"]}.isdisjoint(order_uids(unlimited))


# ── 4. 节点绑定（R-18）──

def test_node_scope_overrides_position_and_pinned_skips_keyword_and_probability(api):
    """节点绑定的覆盖值进 order[]，pinned 条目跳过关键词与概率。"""
    client, manager, _ = api
    book = manager.load("book")
    scope = lore_scope(book, pinned=["miss"],
                       overrides={"kw": {"position": 0, "group_weight": 320, "depth": 1}})
    payload = preview(client, input_text="阿米娅", seed=0, lore_scope=scope)
    order = {item["uid"]: item for item in payload["order"]}

    # 覆盖后的 position / group_weight / depth 出现在 order[]（并因此排到最前）
    assert order["kw"]["position"] == 0
    assert order["kw"]["group_weight"] == 320
    assert order["kw"]["depth"] == 1
    assert payload["order"][0]["uid"] == "kw"
    assert order["kw"]["override_from_node"] == {"node_id": "node-1", "position": 0,
                                                 "group_weight": 320, "depth": 1}
    # 未被覆盖的条目 override_from_node 为 null
    assert order["world"]["override_from_node"] is None
    # pinned 条目（主键「银灰」未命中、probability=1）仍被钉入，说明跳过了关键词与概率
    assert "miss" in order
    assert order["miss"]["matched_keys"] == []
    # 被 allowed 排除的条目报节点降级，且不出现在 order[]
    assert dropped_map(payload)["nodeonly"] == "node_binding_demoted"

    # 控制组：不传 lore_scope 时 pinned 不存在，miss 因关键词未命中而不出现
    plain = preview(client, input_text="阿米娅", seed=0)
    assert "miss" not in order_uids(plain)


def test_matched_keys_report_only_real_hits(api):
    """`matched_keys` 只报告真实命中的键名（只读辅助，不改变触发判定）。"""
    client, _, _ = api
    payload = preview(client, input_text="阿米娅", seed=1)
    order = {item["uid"]: item for item in payload["order"]}
    assert "kw" in order                      # 该条目 probability=100，命中即注入
    assert order["kw"]["matched_keys"] == ["阿米娅"]          # 副键「罗德岛」未命中
    assert order["world"]["matched_keys"] == []              # 常驻条目不靠关键词
    both = preview(client, input_text="阿米娅和罗德岛", seed=0)
    by_uid = {item["uid"]: item for item in both["order"]}
    assert by_uid["kw"]["matched_keys"] == ["阿米娅", "罗德岛"]
    assert dropped_map(both).get("sec") is None              # 主副键都命中 → 不再 secondary_miss


# ── 5. 零写盘 ──

def test_prompt_preview_writes_nothing(api):
    """请求前后书文件的 sha256 与 mtime 都不变（§3.2 验收）。"""
    client, _, tmp_path = api
    path = Path(tmp_path) / "book.json"
    before = (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns)
    assert preview(client, input_text="阿米娅", seed=3, budget_tokens=50)["order"] is not None
    assert client.get("/api/worldbook/book/dependency-tree?entry_uids=world").status_code == 200
    after = (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns)
    assert after == before


# ── 6. 顺序与分层 ──

def test_order_follows_sort_key_and_text_order_matches(api):
    """`order[]` 顺序 = (position, -group_weight, depth, uid)，且与两段文本的 `### 名称` 一致。"""
    client, _, _ = api
    payload = preview(client, input_text="阿米娅和罗德岛", seed=0,
                      lore_scope=lore_scope(api[1].load("book"),
                                            overrides={"kw": {"position": 1, "depth": 2}}))
    order = payload["order"]
    assert [item["seq"] for item in order] == list(range(len(order)))
    keys = [(item["position"], -item["group_weight"], item["depth"], item["uid"])
            for item in order]
    assert keys == sorted(keys), "顺序必须等于线上排序键"
    stable_names = [item["name"] for item in order if item["layer"] == "stable"]
    dynamic_names = [item["name"] for item in order if item["layer"] == "dynamic"]
    assert heading_names(payload["stable_text"]) == stable_names
    assert heading_names(payload["dynamic_text"]) == dynamic_names
    # 分层纪律：稳定层只含 position==0 且 always_active 的条目
    book = api[1].load("book")
    by_uid = {e.uid: e for e in book.entries}
    for item in order:
        if item["layer"] == "stable":
            assert item["position"] == 0 and by_uid[item["uid"]].always_active
    # 触发型条目即使 position=0 也进动态层
    assert all(item["layer"] == "dynamic" for item in order if item["uid"] == "kw")
    assert payload["skeleton"][0]["id"] == "system"
    assert [site["layer"] for site in payload["sites"]] == ["stable", "dynamic"]


def test_free_mode_reports_system_parts_hosts(api):
    """自由模式两个宿主都是 system_parts，块名取真实相邻块。"""
    client, _, _ = api
    payload = preview(client, mode="free", input_text="阿米娅", seed=0)
    assert payload["mode"] == "free"
    assert [site["host"] for site in payload["sites"]] == ["system_parts", "system_parts"]
    assert payload["sites"][0]["after_block"] == "character_card"
    assert payload["sites"][0]["before_block"] == "worldview"
    assert payload["sites"][1]["before_block"] == "memory_context"
    assert [block["id"] for block in payload["skeleton"]][:2] == ["character_card", "reference"]
    assert [block["id"] for block in payload["skeleton"]][-2:] == ["world_book", "memory"]
    assert [b["insert"] for b in payload["skeleton"] if b["is_worldbook"]] == ["before", "after"]


# ── 7. 全局 random 与参数校验 ──

def test_prompt_preview_does_not_touch_global_random(api):
    """预览用独立 `random.Random(seed)`：全局 random 状态前后一致。"""
    client, _, _ = api
    state = random.getstate()
    try:
        preview(client, input_text="阿米娅", seed=0)
        preview(client, input_text="阿米娅", seed=99, budget_tokens=1)
    finally:
        assert random.getstate() == state


def test_format_injection_trace_is_byte_invariant(api):
    """R-19：`format_injection` 传 `trace` 不得改变返回值与截断行为（字节不变）。

    线上调用点（`SceneManager` / `CharacterAgent`）不传 `trace`，因此这条对拍保证
    「预览用的那一遍」与「真正拼提示词的那一遍」是同一份输出。
    """
    _, manager, _ = api
    book = manager.load("book")
    matched = book.collect_matches("阿米娅", "阿米娅", rng=random.Random(0),
                                   eligible_uids={e.uid for e in book.entries})
    plain = book.format_injection(matched, "博士", "阿米娅")
    trace = []
    assert book.format_injection(matched, "博士", "阿米娅", trace=trace) == plain
    assert len(trace) == len(matched)
    assert all(item["included"] for item in trace)
    assert set(trace[0]) == {"uid", "included", "layer", "text", "tokens"}
    # 预算截断路径也必须字节一致（trace 只是读侧观察，不参与判定）
    tight = copy.deepcopy(book)
    tight.budget_tokens = 5
    assert tight.format_injection(matched, "博士", "阿米娅") == \
        tight.format_injection(matched, "博士", "阿米娅", trace=[])
    # 回归：预览里被预算跳过的条目确实带 included=False
    payload = preview(api[0], input_text="阿米娅", seed=0, budget_tokens=5)
    assert payload["totals"]["truncated"] is True
    assert payload["totals"]["matched_count"] > len(payload["order"])


def test_invalid_payload_is_rejected_without_writing(api):
    """非法 mode / 非对象请求体 / 非法 lore_scope 一律 400，且不写盘。"""
    client, _, tmp_path = api
    path = Path(tmp_path) / "book.json"
    before = (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns)
    assert client.post("/api/worldbook/book/prompt-preview",
                       json={"mode": "tactical"}).status_code == 400
    assert client.post("/api/worldbook/book/prompt-preview", json=[1, 2]).status_code == 400
    assert client.post("/api/worldbook/book/prompt-preview",
                       json={"mode": "narrative", "lore_scope": "not-an-object"}).status_code == 400
    assert client.post("/api/worldbook/book/prompt-preview",
                       json={"mode": "narrative", "seed": "abc"}).status_code == 200
    assert (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns) == before


# ─────────────────────────────────────────────────────────────
# 未插入原因的**真实性**（提案 §3.2）：v2 / v3 两套解析器的原因口径必须一致
# ─────────────────────────────────────────────────────────────

def _reason_book(book_id, v3):
    """同一形状的原因书：停用 / 空正文条目**已经是起点**（不是「没进范围」）。

    - `off`：停用；`blank`：正文空白且关键词不命中；两者都在起点里；
    - `kw`：触发型条目，输入「阿米娅」时命中；
    - `outsider`：既不是起点也没有依赖指向它 → 它才是真正的 `not_in_scope`。
    v2 用 `fixed_entry_uids` 当起点；v3 用等价的 `always + none` 起点。
    """
    entries = [
        entry("world", always_active=True, category_id="worldview"),
        entry("kw", trigger_keys=["阿米娅"], selective=False),
        entry("off", enabled=False),
        entry("blank", content="   ", trigger_keys=["银灰"], selective=False),
        entry("outsider", always_active=True),
    ]
    roots = [uid for uid in ("world", "kw", "off", "blank")]
    if not v3:
        return WorldBook(book_id, "v2 原因书", entries,
                         categories=copy.deepcopy(DEFAULT_CATEGORIES),
                         import_config={"fixed_entry_uids": roots,
                                        "dependency_sources": [], "revision": 1},
                         scope_mode="selective")
    return WorldBook(
        book_id, "v3 原因书", entries, categories=copy.deepcopy(DEFAULT_CATEGORIES),
        dependency_rules={"roots": [{"entry_uid": uid, "activation": ACTIVATION_ALWAYS,
                                     "expansion": EXPANSION_NONE, "character_ids": []}
                                    for uid in roots],
                          "root_rule": {"entry_uids": sorted(roots)},
                          "rejected": [], "edge_meta": {}},
        scope_mode="selective")


def test_drop_reasons_stay_truthful_for_scope_excluded_entries(tmp_path):
    """提案 §3.2「未插入原因」的真实性：停用 / 空正文条目不得被报成 `not_in_scope`。

    v2 的范围解析会在候选阶段就把停用 / 空正文条目过滤掉（这是既有且正确的行为，
    它们确实不该注入），于是 `resolved_entry_uids` 里没有它们；若照此报
    `not_in_scope`，界面给出的修复入口会是「去『分类与载入』把它设为起点」——
    而它在 v2 里**已经是固定导入起点**，这个引导是错的，也与「哪些条目因为本身就是
    停用的而没被插进去」的要求相矛盾。因此 `not_in_scope` 只对**从未进过候选范围**
    的条目成立，范围解析阶段被排除的条目必须报它们真正的原因。
    v3 的 `best` 本就保留这两类条目（只以 `issues` 形式报告），本用例同时对 v3 做
    对照固化，确保两套解析器的原因口径一致。
    """
    from blueprints.worldbook import register
    manager = WorldBookManager(tmp_path)
    for book in (_reason_book("v2book", v3=False), _reason_book("v3book", v3=True)):
        manager.save(book)
    app = Flask(__name__)
    app.config["TESTING"] = True
    register(app, {"worldbook": manager})
    client = app.test_client()

    # v2 的停用 / 空正文条目在范围解析阶段就被过滤（根因证据），但原因必须真实
    v2_scope = manager.load("v2book").resolve_import_scope([])
    assert {item["uid"] for item in v2_scope["excluded_entries"]} == {"off", "blank"}
    assert "off" not in v2_scope["resolved_entry_uids"]
    assert "blank" not in v2_scope["resolved_entry_uids"]

    expected = {"off": "disabled", "blank": "empty_content", "outsider": "not_in_scope"}
    # candidate_count 口径：v2 的 resolved 过滤掉停用 / 空正文（world + kw = 2）；
    # v3 的 best 保留它们（world + kw + off + blank = 4）。这是诚实的「候选」口径，
    # 本用例只修原因分类，不改这个计数。
    for book_id, candidate_count in (("v2book", 2), ("v3book", 4)):
        response = client.post(f"/api/worldbook/{book_id}/prompt-preview",
                               json={"mode": "narrative", "input_text": "阿米娅", "seed": 0})
        assert response.status_code == 200, (book_id, response.json)
        payload = response.json
        assert dropped_map(payload) == expected, book_id
        assert set(order_uids(payload)) == {"world", "kw"}, book_id
        assert payload["totals"]["candidate_count"] == candidate_count, book_id
        # 不变量：order[] 与 dropped[] 互斥且合起来覆盖全书条目
        assert len(payload["order"]) + len(payload["dropped"]) == \
            len(manager.load(book_id).entries), book_id
        assert len({item["uid"] for item in payload["dropped"]}) == len(payload["dropped"])


def test_disabled_book_reports_no_reason_that_contradicts_totals(tmp_path):
    """书级停用不得产生与 `totals` 自相矛盾的原因（`budget_exceeded` ↔ `truncated`）。

    整本书停用时候选范围为空（`candidate_count == 0`、`matched_count == 0`、`order == []`），
    因此：
    - **不得**出现 `budget_exceeded`：它的语义由 `trace` 里 `included=False` 精确定义
      （`truncated` 就是「trace 存在 included=False」），而这里 `truncated == False`；
      两者同时成立会在 UI 上表现为「既说被预算截断、又说没有截断」。
    - 条目本身没问题的起点（`world` / `kw`）报 `not_in_scope`：「整本书不在候选范围内」
      正是 `not_in_scope` 的准确含义（九类里没有「整本书已停用」这一档）。
    - 条目级原因优先于书级原因：`off` / `blank` 仍报 `disabled` / `empty_content`
      （「即使这本书被启用，这条也不会注入」是更可操作的事实）。
    对照：同一夹具启用后逐条不变（正常的起点条目照常注入）。
    """
    from blueprints.worldbook import register
    manager = WorldBookManager(tmp_path)
    disabled = _reason_book("disabledbook", v3=False)
    disabled.enabled = False
    enabled = _reason_book("enabledbook", v3=False)
    for book in (disabled, enabled):
        manager.save(book)
    app = Flask(__name__)
    app.config["TESTING"] = True
    register(app, {"worldbook": manager})
    client = app.test_client()

    def ask(book_id):
        response = client.post(f"/api/worldbook/{book_id}/prompt-preview",
                               json={"mode": "narrative", "input_text": "阿米娅", "seed": 0})
        assert response.status_code == 200, (book_id, response.json)
        return response.json

    payload = ask("disabledbook")
    reasons = dropped_map(payload)
    assert payload["order"] == []
    assert payload["totals"]["candidate_count"] == 0
    assert payload["totals"]["matched_count"] == 0
    assert payload["totals"]["truncated"] is False
    assert "budget_exceeded" not in reasons.values()
    # 不变量：truncated ⟺ dropped 里存在 budget_exceeded（本例两边都是「否」）
    assert payload["totals"]["truncated"] == ("budget_exceeded" in reasons.values())
    assert reasons == {"world": "not_in_scope", "kw": "not_in_scope",
                       "off": "disabled", "blank": "empty_content",
                       "outsider": "not_in_scope"}
    assert len(payload["order"]) + len(payload["dropped"]) == \
        len(manager.load("disabledbook").entries)

    # 对照：同一夹具启用后行为逐条不变（只有书级停用这一个变量）
    control = ask("enabledbook")
    assert dropped_map(control) == {"off": "disabled", "blank": "empty_content",
                                    "outsider": "not_in_scope"}
    assert set(order_uids(control)) == {"world", "kw"}
    assert control["totals"]["candidate_count"] == 2
    assert control["totals"]["truncated"] is False


# ─────────────────────────────────────────────────────────────
# `full_scope`（显式全量兼容）：v2 与 v3 语义一致，且与 `scope-preview` 同口径
# ─────────────────────────────────────────────────────────────

def _full_scope_book(book_id, v3):
    """起点范围**严格小于**全量的书：`extra_a` / `extra_b` 启用且有正文但不在起点里。

    `off`（停用）/ `blank`（正文空白）放进起点，用来确认「全量」只放宽到
    「启用且有正文」的条目为止。
    """
    entries = [
        entry("world", always_active=True, category_id="worldview"),
        entry("extra_a", always_active=True),
        entry("extra_b", always_active=True),
        entry("off", enabled=False),
        entry("blank", content="   "),
    ]
    if not v3:
        return WorldBook(book_id, "full_scope v2 书", entries,
                         categories=copy.deepcopy(DEFAULT_CATEGORIES),
                         import_config={"fixed_entry_uids": ["world", "off", "blank"],
                                        "dependency_sources": [], "revision": 1},
                         scope_mode="selective")
    return WorldBook(
        book_id, "full_scope v3 书", entries, categories=copy.deepcopy(DEFAULT_CATEGORIES),
        dependency_rules={"roots": [{"entry_uid": "world", "activation": ACTIVATION_ALWAYS,
                                     "expansion": EXPANSION_NONE, "character_ids": []}],
                          "root_rule": {"entry_uids": ["world"]},
                          "rejected": [], "edge_meta": {}},
        scope_mode="selective")


def test_full_scope_widens_v2_range_and_matches_scope_preview(tmp_path):
    """提案 §3.2 的 `full_scope` 在 v2 与 v3 上语义一致、且与 `scope-preview` 同口径。

    `full_scope=True` = 「本次会话显式全量兼容」：候选范围换成全部**启用且有正文**的
    条目。这条在 v2 书上曾经**静默无效**（`preview_prompt_injection` 的 v2 分支完全没
    处理这个开关，只有 v3 分支把它透传下去），于是同一个开关在两个接口上口径不一致：
    「Prompt 预览」的 `candidate_count` 与同书 `scope-preview` 的 `entry_count` 对不上，
    页签左栏的「全量兼容」开关点了没有任何反应（静默无效比报错更糟）。
    本用例固化：① v2 的 `candidate_count` == 同书 `scope-preview` 在
    `full_scope=True` 下的 `entry_count`；② `order[]` 里出现**起点范围之外**的条目
    （真的放宽了范围，而不是碰巧相等）；③ `full_scope=False` 的对照与 v3 书的行为
    逐条不变（v3 本来就正确，作为回归对照）。
    """
    from blueprints.worldbook import register
    manager = WorldBookManager(tmp_path)
    for book in (_full_scope_book("v2fullbook", v3=False),
                 _full_scope_book("v3fullbook", v3=True)):
        manager.save(book)
    app = Flask(__name__)
    app.config["TESTING"] = True
    register(app, {"worldbook": manager})
    client = app.test_client()

    def ask(book_id, full_scope=False):
        response = client.post(f"/api/worldbook/{book_id}/prompt-preview",
                               json={"mode": "narrative", "input_text": "阿米娅",
                                     "seed": 0, "full_scope": full_scope})
        assert response.status_code == 200, (book_id, response.json)
        return response.json

    for book_id in ("v2fullbook", "v3fullbook"):
        base = ask(book_id)
        widened = ask(book_id, full_scope=True)
        # 同书 scope-preview（路由侧另一条实现）在同一个开关下的口径
        scope_response = client.post(f"/api/worldbook/{book_id}/scope-preview",
                                     json={"full_scope": True})
        assert scope_response.status_code == 200, scope_response.json
        scope_payload = scope_response.json

        # ① 起点范围只有 world 一条 → 全量是 world + extra_a + extra_b
        assert base["totals"]["candidate_count"] == 1, book_id
        assert set(order_uids(base)) == {"world"}, book_id
        assert widened["totals"]["candidate_count"] == 3, book_id
        assert scope_payload["full_scope"] is True, book_id
        assert scope_payload["full_entry_count"] == 3, book_id
        assert scope_payload["entry_count"] == widened["totals"]["candidate_count"], book_id
        # ② 真的放宽了范围：起点范围之外的条目进了 order[]，且理由带 full_scope
        assert set(order_uids(widened)) == {"world", "extra_a", "extra_b"}, book_id
        assert {item["uid"] for item in widened["order"]
                if "full_scope" in item["reasons"]} == {"world", "extra_a", "extra_b"}, book_id
        # ③ 「全量」只到「启用且有正文」为止；order ∪ dropped 仍覆盖全书
        assert set(dropped_map(widened)) == {"off", "blank"}, book_id
        assert len(widened["order"]) + len(widened["dropped"]) == 5, book_id

    # v2 的对照：不开 full_scope 时回到起点范围，条目级原因照旧
    assert dropped_map(ask("v2fullbook")) == {
        "extra_a": "not_in_scope", "extra_b": "not_in_scope",
        "off": "disabled", "blank": "empty_content"}
    # v3 的回归对照：起点范围之外的两条在未开 full_scope 时报 not_in_scope
    assert dropped_map(ask("v3fullbook")) == {
        "extra_a": "not_in_scope", "extra_b": "not_in_scope",
        "off": "not_in_scope", "blank": "not_in_scope"}
