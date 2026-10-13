"""Source-aware authoring uses temporary books only."""

import sys
from copy import deepcopy
from pathlib import Path

import frontmatter
from flask import Flask
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from blueprints.plot_graphs import register
from plot_graphs import load_graph, save_graph
from session_overlay import parse_narrative_beats
from story_outline import load_outline, save_outline
from world_book import WorldBook, WorldBookEntry, WorldBookManager


@pytest.fixture(params=["narrative", "outline", "empty"])
def env(request, tmp_path):
    mgr = WorldBookManager(tmp_path)
    mgr.save(WorldBook("book", name="测试书"))
    folder = mgr._path("book").parent / "plots" / "plot"
    folder.mkdir(parents=True)
    body = {"narrative": "## 章节 7：开场\n\n#### beat_old（keep_on_deviate: true）\n\n**内容**：旧标题\n旧正文\n\n## 设定\n保留尾部\n",
            "outline": "## 第一幕：开场\n故事正文\n", "empty": "# 空白剧情\n"}[request.param]
    path = folder / "index.md"
    path.write_text("---\nid: plot\nname: 剧情\n---\n\n" + body, encoding="utf-8")
    book = mgr.load("book")
    book.entries.append(WorldBookEntry(uid="plots_plot_index", name="剧情", content=body,
                                      group="剧情", trigger_keys=["剧情"], raw={"custom": "keep"}))
    mgr.save(book)
    app = Flask(__name__)
    register(app, {"worldbook": mgr})
    return mgr, path, app.test_client(), request.param


def state(env):
    response = env[2].get("/api/plot-graphs/plot/authoring?book_id=book")
    assert response.status_code == 200
    return response.json


def payload(env, graph=None):
    current = state(env)
    return {"book_id": "book", "source_revision": current["source_revision"],
            "chapter_idx": current["chapters"][0]["idx"] if current["chapters"] else None,
            "title": "新标题", "content": "新正文\n第二行",
            "position": {"x": 42, "y": 84},
            "graph": graph or {"plot_id": "plot", "nodes": [], "edges": []}}


def test_create_reload_and_patch(env, monkeypatch):
    mgr, path, client, kind = env
    graph = {"plot_id": "plot", "nodes": [{"id": "note", "type": "note", "custom": {"a": 1}},
                                             {"id": "note2", "type": "note"}],
             "edges": [{"id": "edge", "from": "note", "to": "note2", "custom": 2}],
             "unknown": {"draft": True}}
    calls = []
    real_save = mgr.save
    def save_once(book):
        calls.append(book)
        real_save(book)
    monkeypatch.setattr(mgr, "save", save_once)
    # The full unsaved draft is part of the same commit as the source beat.
    response = client.post("/api/plot-graphs/plot/beats", json=payload(env, graph))
    assert response.status_code == 200, response.json
    assert len(calls) == 1
    result = response.json
    beat_id = result["node"]["ref"]["beat_id"]
    assert result["graph"]["unknown"] == graph["unknown"]
    assert result["graph"]["edges"] == graph["edges"]
    assert result["graph"]["nodes"][0]["custom"] == {"a": 1}
    mgr._cache.clear()
    assert load_graph(mgr, "book", "plot") == result["graph"]
    if kind == "narrative":
        beats = parse_narrative_beats(frontmatter.load(path).content)
        assert beats[0]["beats"][-1]["id"] == beat_id
        assert "新正文" in beats[0]["beats"][-1]["content"]
        assert "保留尾部" in path.read_text(encoding="utf-8")
        entry = next(e for e in mgr.load("book").entries if e.uid == "plots_plot_index")
        assert beat_id in entry.content and entry.raw == {"custom": "keep"}
    else:
        assert load_outline(mgr, "book", "plot")["chapters"][0]["beats"][-1]["id"] == beat_id
    response = client.patch(f"/api/plot-graphs/plot/beats/{beat_id}", json={
        "book_id": "book", "source_revision": result["authoring"]["source_revision"],
        "title": "修改标题", "content": "修改正文"})
    assert response.status_code == 200, response.json
    assert len(calls) == 2
    mgr._cache.clear()
    beat = state(env)["chapters"][0]["beats"][-1]
    assert beat == {"id": beat_id, "title": "修改标题", "content": "修改正文"}
    assert "修改正文" in (frontmatter.load(path).content if kind == "narrative"
                         else load_outline(mgr, "book", "plot")["chapters"][0]["beats"][-1]["content"])


def test_conflicts_and_invalid_inputs_do_not_write(env):
    mgr, path, client, _ = env
    original = path.read_bytes(), mgr._path("book").read_bytes(), deepcopy(mgr.load("book").to_dict())
    data = payload(env)
    data["source_revision"] = "stale"
    assert client.post("/api/plot-graphs/plot/beats", json=data).status_code == 409
    for change in ({"chapter_idx": 99}, {"chapter_idx": True}, {"title": ""},
                   {"position": {"x": "nan", "y": 1}}, {"graph": []}, {"content": {}}):
        assert client.post("/api/plot-graphs/plot/beats", json={**payload(env), **change}).status_code == 400
    assert client.patch("/api/plot-graphs/plot/beats/beat_missing", json={
        "book_id": "book", "source_revision": state(env)["source_revision"],
        "title": "t", "content": "c"}).status_code == 404
    assert client.get("/api/plot-graphs/missing/authoring?book_id=book").status_code == 404
    assert client.get("/api/plot-graphs/../authoring?book_id=book").status_code == 400
    assert client.post("/api/plot-graphs/plot/beats", json=[]).status_code == 400
    assert original == (path.read_bytes(), mgr._path("book").read_bytes(), mgr.load("book").to_dict())
    data = payload(env)
    save_graph(mgr, "book", {"plot_id": "plot", "nodes": [], "edges": []})
    before = path.read_bytes(), mgr._path("book").read_bytes()
    assert client.post("/api/plot-graphs/plot/beats", json=data).status_code == 409
    assert before == (path.read_bytes(), mgr._path("book").read_bytes())


def test_save_failure_restores_source_and_cache(env, monkeypatch):
    mgr, path, client, _ = env
    data = payload(env)
    original = path.read_bytes(), mgr._path("book").read_bytes(), deepcopy(mgr.load("book").to_dict())
    def fail(book):
        book.entries.clear()
        raise OSError("disk failure")
    monkeypatch.setattr(mgr, "save", fail)
    assert client.post("/api/plot-graphs/plot/beats", json=data).status_code == 500
    assert original == (path.read_bytes(), mgr._path("book").read_bytes(), mgr.load("book").to_dict())


def test_source_revision_covers_related_outline_and_markdown(env):
    mgr, path, client, _ = env
    data = payload(env)
    save_outline(mgr, "book", {"plot_id": "plot", "chapters": [{"id": "ch", "title": "章",
        "beats": [{"id": "beat_outline", "title": "大纲", "content": "新源"}]}]})
    before = path.read_bytes(), mgr._path("book").read_bytes()
    assert client.post("/api/plot-graphs/plot/beats", json=data).status_code == 409
    assert before == (path.read_bytes(), mgr._path("book").read_bytes())
    data = payload(env)
    path.write_bytes(path.read_bytes() + b"\nchanged\n")
    before = path.read_bytes(), mgr._path("book").read_bytes()
    assert client.post("/api/plot-graphs/plot/beats", json=data).status_code == 409
    assert before == (path.read_bytes(), mgr._path("book").read_bytes())


def test_create_again_preserves_saved_media_and_new_draft(env):
    mgr, _, client, _ = env
    first = client.post("/api/plot-graphs/plot/beats", json=payload(env)).json
    graph = first["graph"]
    graph["nodes"][0]["scene_media"] = {
        "background": {"kind": "image", "asset": "plots/plot/art/room.png", "role": "background",
                       "fit": "cover", "position": [50, 50], "portraits": "show"}}
    graph["nodes"].append({"id": "draft", "type": "note", "content": "unsaved", "custom": True})
    response = client.post("/api/plot-graphs/plot/beats", json=payload(env, graph))
    assert response.status_code == 200, response.json
    assert response.json["node"]["ref"]["beat_id"] != first["node"]["ref"]["beat_id"]
    mgr._cache.clear()
    saved = load_graph(mgr, "book", "plot")
    assert saved["nodes"][0]["scene_media"] == graph["nodes"][0]["scene_media"]
    assert saved["nodes"][1]["content"] == "unsaved" and saved["nodes"][1]["custom"] is True


def test_patch_failure_restores_source_and_cache(env, monkeypatch):
    mgr, path, client, _ = env
    created = client.post("/api/plot-graphs/plot/beats", json=payload(env)).json
    original = path.read_bytes(), mgr._path("book").read_bytes(), deepcopy(mgr.load("book").to_dict())
    def fail(book):
        raise OSError("disk failure")
    monkeypatch.setattr(mgr, "save", fail)
    response = client.patch(f"/api/plot-graphs/plot/beats/{created['node']['ref']['beat_id']}", json={
        "book_id": "book", "source_revision": created["authoring"]["source_revision"],
        "title": "修改", "content": "修改"})
    assert response.status_code == 500
    assert original == (path.read_bytes(), mgr._path("book").read_bytes(), mgr.load("book").to_dict())


def test_outline_edit_preserves_author_fields(tmp_path):
    mgr = WorldBookManager(tmp_path)
    mgr.save(WorldBook("book", name="书"))
    path = mgr._path("book").parent / "plots" / "plot" / "index.md"
    path.parent.mkdir(parents=True)
    path.write_text("---\nid: plot\n---\n\n## 第一幕：开场\n正文", encoding="utf-8")
    save_outline(mgr, "book", {"plot_id": "plot", "chapters": [{"id": "ch", "title": "章",
        "beats": [{"id": "beat_a", "title": "标题", "content": "正文", "extra": {"keep": 1},
                   "branches": [{"label": "选择", "target_beat_id": "beat_a"}]}]}]})
    app = Flask(__name__)
    register(app, {"worldbook": mgr})
    env = mgr, path, app.test_client(), "outline"
    before = load_outline(mgr, "book", "plot")["chapters"][0]["beats"][0]
    response = env[2].patch("/api/plot-graphs/plot/beats/beat_a", json={
        "book_id": "book", "source_revision": state(env)["source_revision"], "title": "新", "content": "新"})
    assert response.status_code == 200
    after = load_outline(mgr, "book", "plot")["chapters"][0]["beats"][0]
    assert after["branches"] == before["branches"] and after["extra"] == before["extra"]


def test_source_entry_edit_conflicts_instead_of_overwriting(env):
    mgr, path, client, kind = env
    if kind != "narrative":
        return
    data = payload(env)
    book = mgr.load("book")
    book.entries[0].content += "\n独立编辑的正文"
    mgr.save(book)
    before = path.read_bytes(), mgr._path("book").read_bytes()
    assert client.post("/api/plot-graphs/plot/beats", json=data).status_code == 409
    # Even a fresh source revision cannot silently choose the stale file over an edited entry.
    data = payload(env)
    assert client.post("/api/plot-graphs/plot/beats", json=data).status_code == 409
    assert before == (path.read_bytes(), mgr._path("book").read_bytes())


@pytest.mark.parametrize("header", ["##章节 7：开场", "  ## 章节 7 ：开场  ", "## 章节7:开场"])
def test_chapter_syntax_matches_graph_overview(tmp_path, monkeypatch, header):
    import combat_nodes
    mgr = WorldBookManager(tmp_path)
    mgr.save(WorldBook("book", name="书"))
    path = mgr._path("book").parent / "plots/plot/index.md"
    path.parent.mkdir(parents=True)
    path.write_text("---\nid: plot\n---\n" + header + "\n#### beat_old\n**内容**：旧标题\n旧正文\n", encoding="utf-8")
    monkeypatch.setattr(combat_nodes, "_plot_files", lambda **kwargs: [("book", path)])
    app = Flask(__name__)
    register(app, {"worldbook": mgr})
    fixture = mgr, path, app.test_client(), "narrative"
    assert state(fixture)["source"] == "narrative"
    response = fixture[2].post("/api/plot-graphs/plot/beats", json=payload(fixture))
    assert response.status_code == 200
    flow = combat_nodes.plot_flows(mgr, book_id="book")[0]
    assert flow["source"] == "narrative"
    assert flow["chapters"][0]["beats"][-1]["id"] == response.json["node"]["ref"]["beat_id"]


@pytest.mark.parametrize("content", ["##章节 8：隐藏章节", "  #### beat_hidden", "## 附录"])
def test_nested_structure_cannot_change_created_beat_identity(env, content):
    mgr, path, client, kind = env
    if kind != "narrative":
        return
    before = path.read_bytes(), mgr._path("book").read_bytes()
    response = client.post("/api/plot-graphs/plot/beats", json={**payload(env), "content": content})
    assert response.status_code == 400
    assert before == (path.read_bytes(), mgr._path("book").read_bytes())


def test_plot_source_identity_uses_directory_not_metadata_alias(env):
    mgr, path, client, _ = env
    path.write_text(path.read_text(encoding="utf-8").replace("id: plot", "id: alias"), encoding="utf-8")
    assert client.get("/api/plot-graphs/alias/authoring?book_id=book").status_code == 404
    assert client.get("/api/plot-graphs/plot/authoring?book_id=book").status_code == 200
