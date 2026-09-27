"""The bundled story's art catalog and location backgrounds remain complete."""

import json
import struct
from pathlib import Path

import frontmatter


ROOT = Path(__file__).resolve().parents[1]
CONTENT = ROOT / "data" / "worldbooks" / "content"
ART = CONTENT / "plots" / "beyond_twin" / "art"


def _png_size(path: Path) -> tuple[int, int]:
    header = path.read_bytes()[:24]
    assert header[:8] == b"\x89PNG\r\n\x1a\n"
    assert header[12:16] == b"IHDR"
    return struct.unpack(">II", header[16:24])


def test_beyond_twin_art_catalog_covers_all_seven_acts():
    entries = json.loads((ART / "index.json").read_text(encoding="utf-8"))
    assert {entry["act"] for entry in entries} == {f"第{i}幕" for i in "一二三四五六七"}
    assert len({entry["id"] for entry in entries}) == len(entries)
    for entry in entries:
        path = ART / entry["image"]
        assert path.parent == ART and path.is_file()
        width, height = _png_size(path)
        assert width > height >= 800


def test_beyond_twin_new_locations_and_backgrounds_are_bundled():
    book = json.loads((ROOT / "data" / "worldbooks" / "packs" / "beyond-twin.json").read_text(encoding="utf-8"))
    entries = {entry["uid"] for entry in book["entries"]}
    for location, bg_id in (
        ("深湾商场", "beyond_twin_mall"),
        ("海岸餐厅", "beyond_twin_cafe"),
        ("旧城200室·病中", "beyond_twin_sickroom"),
        ("澜晶机器人工厂", "beyond_twin_factory"),
    ):
        assert f"Location_{location}" in entries
        meta = frontmatter.load(CONTENT / "environment" / "Location" / f"{location}.md").metadata
        assert meta["combat_bg"] == bg_id
        bg_dir = CONTENT / "combat" / "backgrounds" / bg_id
        assert frontmatter.load(bg_dir / "index.md").metadata["image"] == "bg.png"
        width, height = _png_size(bg_dir / "bg.png")
        assert width > height >= 800
