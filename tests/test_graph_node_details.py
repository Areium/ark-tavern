"""Graph details expose the real authoring source, without truncated beat bodies."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import combat_nodes
import data_paths
import story_outline


def test_outline_details_and_choices_survive_flow_projection(monkeypatch):
    content = "内容必须完整。" * 100
    outline = {"chapters": [{"id": "act", "title": "入口", "summary": "章节目标", "beats": [{
        "id": "choose", "title": "抉择", "summary": "摘要", "content": content,
        "must_keep": "保留证据", "guidance": "不替玩家做决定", "min_rounds": 2,
        "choice_required": True, "branches": [{"label": "出示钥匙", "intent": "打开门", "target_beat_id": "door"}],
    }]}]}
    monkeypatch.setattr(story_outline, "load_outline", lambda *args: outline)
    monkeypatch.setattr(combat_nodes, "list_node_files", lambda **kwargs: [])
    chapter = combat_nodes._outline_flow_chapters("p", {}, "", "book", object())[0]
    beat = chapter["beats"][0]
    assert chapter["summary"] == "章节目标"
    assert beat["content"] == content
    assert beat["must_keep"] == "保留证据"
    assert beat["guidance"] == "不替玩家做决定"
    assert beat["min_rounds"] == 2 and beat["choice_required"] is True
    assert beat["branches"][0]["target_beat_id"] == "door"


def test_narrative_details_include_all_body_lines(tmp_path, monkeypatch):
    monkeypatch.setattr(data_paths, "PROJECT_ROOT", tmp_path)
    folder = tmp_path / "data/worldbooks/books/book"
    folder.mkdir(parents=True)
    (folder / "book.json").write_text('{"id":"book","enabled":true}', encoding="utf-8")
    plot = folder / "plots/p/index.md"
    plot.parent.mkdir(parents=True)
    plot.write_text("---\nid: p\nname: 故事\n---\n## 章节 1：门口\n#### beat_arrival\n第一段\n\n##### 环境线索\n第二段：隐藏的证据\n## 附录\n不应混入\n", encoding="utf-8")
    beat = combat_nodes.plot_flows(book_id="book")[0]["chapters"][0]["beats"][0]
    assert "第一段" in beat["content"] and "第二段：隐藏的证据" in beat["content"]
    assert "第一段\n\n##### 环境线索" in beat["content"]
    assert "不应混入" not in beat["content"]
