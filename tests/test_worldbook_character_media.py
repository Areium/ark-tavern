"""Character copies created by worldbook excerpts stay independent and portable."""

import sys
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest
from flask import Flask
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import avatar_color
import data_paths
import worldbook_media
from world_book import WorldBookEntry, WorldBookManager


@pytest.fixture
def setup(tmp_path, monkeypatch):
    content = tmp_path / "content"
    chars = content / "characters"
    chars.mkdir(parents=True)
    monkeypatch.setattr(data_paths, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(avatar_color, "_CHARS_ROOT", chars)
    source = chars / "amiya"
    (source / "avatar").mkdir(parents=True)
    (source / "skin").mkdir()
    (source / "index.md").write_text("---\nname: 阿米娅\n---\n角色设定。\n", encoding="utf-8")
    Image.new("RGBA", (2, 2), (20, 40, 80, 255)).save(source / "avatar" / "a.png")
    Image.new("RGBA", (2, 2), (80, 40, 20, 255)).save(source / "skin" / "s.png")
    manager = WorldBookManager(tmp_path / "data" / "worldbooks")
    reference = manager.create_book("资料", book_type="reference")
    story = manager.create_book("剧情")
    shutil.copytree(source, manager._path(reference.id).parent / "characters" / "amiya")
    reference.entries.append(WorldBookEntry(
        "amiya-entry", content="阿米娅的资料", name="阿米娅",
        category_id="characters", character_id="amiya", always_active=True))
    manager.save(reference)
    return manager, reference, story, chars


def excerpt(manager, reference, story):
    return manager.excerpt_entries(story.id, [{
        "source_book_id": reference.id, "source_entry_uid": "amiya-entry"}])


def test_excerpt_copies_character_profile_and_images_into_book(setup):
    manager, reference, story, chars = setup
    result = excerpt(manager, reference, story)
    copied_id = result["entries"][0]["character_id"]
    assert copied_id == f"amiya__wb_{story.id}"
    copied = manager._path(story.id).parent / "characters" / copied_id
    assert "角色设定" in (copied / "index.md").read_text(encoding="utf-8")
    assert (copied / "avatar" / "default.png").exists()
    assert (copied / "skin" / "default.png").exists()
    book = manager.load(story.id)
    assert copied_id in book.character_profiles
    assert set(book.character_media[copied_id]) == {"avatar", "skin"}
    assert result["warnings"] == []

    # The book and its role copy keep the original image after the source changes.
    Image.new("RGBA", (2, 2), (255, 0, 0, 255)).save(chars / "amiya" / "skin" / "s.png")
    assert (copied / "skin" / "default.png").read_bytes() != (chars / "amiya" / "skin" / "s.png").read_bytes()
    assert worldbook_media.decode_media_url(book.character_media[copied_id]["skin"])[0] == (copied / "skin" / "default.png").read_bytes()


def test_export_import_recreates_private_character_copy(setup):
    manager, reference, story, chars = setup
    excerpt(manager, reference, story)
    exported = manager.load(story.id).export_st()
    imported, _ = manager.import_book("另一本剧情", exported)
    copied_id = imported.entries[0].character_id
    assert copied_id == f"amiya__wb_{imported.id}"
    assert copied_id in imported.character_profiles
    assert (manager._path(imported.id).parent / "characters" / copied_id / "skin" / "default.png").exists()


def test_duplicate_book_recreates_private_character_copy(setup):
    manager, reference, story, chars = setup
    excerpt(manager, reference, story)
    duplicate = manager.duplicate_book(story.id)
    copied_id = duplicate.entries[0].character_id
    assert copied_id == f"amiya__wb_{duplicate.id}"
    assert copied_id in duplicate.character_profiles
    assert (manager._path(duplicate.id).parent / "characters" / copied_id / "index.md").exists()


def test_uninstall_removes_only_owned_character_copy(setup):
    manager, reference, story, chars = setup
    excerpt(manager, reference, story)
    copied_id = manager.load(story.id).entries[0].character_id
    copied = manager._path(story.id).parent / "characters" / copied_id
    assert (copied / "index.md").exists()

    assert manager.delete_book(story.id)
    assert manager.load(story.id) is None
    assert not copied.exists()
    assert (chars / "amiya" / "index.md").exists()
    assert manager.load(reference.id) is not None


def test_uninstall_keeps_other_book_when_character_id_is_referenced(setup):
    manager, reference, story, chars = setup
    excerpt(manager, reference, story)
    copied_id = manager.load(story.id).entries[0].character_id
    other = manager.create_book("共享角色副本")
    other.entries.append(WorldBookEntry("shared", content="共享", character_id=copied_id))
    manager.save(other)

    assert manager.delete_book(story.id)
    assert manager.load(story.id) is None
    assert manager.load(other.id).entries[0].character_id == copied_id


def test_uninstall_api_rejects_copy_used_by_unbound_session(setup):
    from blueprints.worldbook import register as register_worldbook

    manager, reference, story, chars = setup
    excerpt(manager, reference, story)
    copied_id = manager.load(story.id).entries[0].character_id

    class Sessions:
        def list_sessions(self):
            return [{"id": "session-1", "worldbook_ids": [],
                     "roster": [copied_id], "characters": [],
                     "player_identity": copied_id}]

    app = Flask(__name__)
    register_worldbook(app, {"worldbook": manager, "session": Sessions()})
    response = app.test_client().delete(f"/api/worldbook/{story.id}")
    assert response.status_code == 409
    assert manager.load(story.id) is not None
    assert (manager._path(story.id).parent / "characters" / copied_id / "index.md").exists()


def test_excerpt_save_failure_removes_new_character_copy(setup, monkeypatch):
    manager, reference, story, chars = setup
    before = manager.load(story.id).to_dict()
    monkeypatch.setattr(manager, "save", lambda _book: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError):
        excerpt(manager, reference, story)
    assert manager.load(story.id).to_dict() == before
    assert not (manager._path(story.id).parent / "characters" / f"amiya__wb_{story.id}").exists()


def test_bound_book_media_uses_binding_order(setup):
    manager, reference, story, chars = setup
    excerpt(manager, reference, story)
    copied_id = manager.load(story.id).entries[0].character_id
    second = manager.create_book("第二本")
    Image.new("RGBA", (2, 2), (0, 255, 0, 255)).save(
        manager._path(reference.id).parent / "characters" / "amiya" / "skin" / "s.png")
    second.character_media[copied_id] = worldbook_media.snapshot_character_media("amiya", reference.id)
    manager.save(second)

    class Overlay:
        def get_worldbook_ids(self):
            return [second.id, story.id]

    expected = second.character_media[copied_id]["skin"]
    assert expected != manager.load(story.id).character_media[copied_id]["skin"]
    assert manager.character_media_for_session(Overlay(), copied_id, "skin") == expected

    class ReverseOverlay:
        def get_worldbook_ids(self):
            return [story.id, second.id]

    assert manager.character_media_for_session(ReverseOverlay(), copied_id, "skin") == manager.load(story.id).character_media[copied_id]["skin"]


def test_excerpt_uses_the_source_book_when_character_names_collide(setup):
    manager, reference, story, _chars = setup
    second = manager.create_book("第二份资料", book_type="reference")
    source = manager._path(second.id).parent / "characters" / "amiya"
    shutil.copytree(manager._path(reference.id).parent / "characters" / "amiya", source)
    (source / "index.md").write_text("---\nname: 第二本阿米娅\n---\n第二本资料。\n", encoding="utf-8")
    Image.new("RGBA", (2, 2), (0, 255, 0, 255)).save(source / "skin" / "s.png")
    second.entries.append(WorldBookEntry(
        "second-amiya", content="角色资料", name="阿米娅",
        category_id="characters", character_id="amiya", always_active=True))
    manager.save(second)

    manager.excerpt_entries(story.id, [{
        "source_book_id": second.id, "source_entry_uid": "second-amiya"}])
    copied_id = manager.load(story.id).entries[0].character_id
    copied = manager._path(story.id).parent / "characters" / copied_id
    assert "第二本资料" in (copied / "index.md").read_text(encoding="utf-8")
    assert Image.open(copied / "skin" / "default.png").convert("RGBA").getpixel((0, 0)) == (0, 255, 0, 255)


def test_stage_and_image_route_use_copied_book_media(setup, tmp_path):
    from blueprints.scene import register as register_scene
    from blueprints.stage import register as register_stage

    manager, reference, story, chars = setup
    excerpt(manager, reference, story)
    copied_id = manager.load(story.id).entries[0].character_id
    copied_skin = manager._path(story.id).parent / "characters" / copied_id / "skin" / "default.png"
    original_skin = copied_skin.read_bytes()
    # Prove the HTTP image comes from the book snapshot, even if its global
    # materialized copy later changes.
    Image.new("RGBA", (2, 2), (255, 0, 0, 255)).save(copied_skin)

    class Overlay:
        def get_worldbook_ids(self):
            return [story.id]

    scene_manager = SimpleNamespace(
        active=copied_id, get_scene_characters=lambda: [copied_id])
    session = SimpleNamespace(
        overlay=Overlay(), data_dir=str(tmp_path / "session"),
        scene_manager=scene_manager, player_identity="博士",
        environment=SimpleNamespace(location="", weather="晴", time_of_day="day", atmosphere=[]))
    session_manager = SimpleNamespace(get_session=lambda _session_id: session)
    app = Flask(__name__)
    app.config["TESTING"] = True
    managers = {"worldbook": manager, "session": session_manager, "document": object()}
    register_scene(app, managers)
    register_stage(app, managers)
    client = app.test_client()
    stage = client.get("/api/sessions/s1/stage")
    assert stage.status_code == 200
    url = stage.json["characters"][0]["skin_url"]
    assert url
    image = client.get(url)
    assert image.status_code == 200
    assert image.mimetype == "image/png"
    assert image.data == original_skin
