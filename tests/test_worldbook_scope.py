"""世界书 v3 文件写入失败时不破坏磁盘内容或缓存。"""
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from world_book import WorldBook, WorldBookEntry, WorldBookManager


def test_failed_disk_save_keeps_original_file_and_cache(tmp_path, monkeypatch):
    manager = WorldBookManager(tmp_path)
    original = WorldBook("book", "原书", [WorldBookEntry("a", content="原正文")])
    manager.save(original)
    before = manager._path(original.id).read_bytes()

    edited = WorldBook.from_dict(original.to_dict())
    edited.name = "未写入的新标题"

    def fail_replace(*_args, **_kwargs):
        raise OSError("disk unavailable")

    monkeypatch.setattr(Path, "replace", fail_replace)
    with pytest.raises(OSError, match="disk unavailable"):
        manager.save(edited)

    assert manager.load(original.id).name == "原书"
    assert manager._path(original.id).read_bytes() == before
    assert not list(tmp_path.glob(".worldbook-*.tmp"))
