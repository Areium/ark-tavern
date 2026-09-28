"""会话角色形象候选：上传先落候选列表，点击候选才成为会话覆盖。

契约（`blueprints/sessions.py` + `session_resources.py`）：

1. 上传**不直接覆盖**当前形象：文件落到
   `<session_dir>/resources/characters/<name>/candidates/<media_type>/cand-*.<ext>`，
   总览接口的 `character_media`（已生效覆盖）保持为空，候选出现在 `character_candidates`。
2. 候选目录**不算会话覆盖**：`list_session_media()` 只认 `<name>/<media_type>.<ext>`，
   候选子目录不会把角色误报成已覆盖。
3. 应用候选 = 复制为 `<name>/<media_type>.<ext>`；旧覆盖**归档回候选**（`replaced-*`），
   内容与已有候选完全相同时直接删除，避免重复堆积。
4. 删除候选不影响当前生效的形象；扩展名与媒体类型在入口处校验。
"""
import io
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest
from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

CHAR = "阿米娅"
SID = "sess_1"
IMG_A = b"\x89PNG\r\n\x1a\n" + b"candidate-a" * 4
IMG_B = b"\x89PNG\r\n\x1a\n" + b"candidate-b" * 8


class FakeSceneManager:
    def __init__(self, names):
        self._names = list(names)

    def get_scene_characters(self):
        return list(self._names)


class FakeSession:
    def __init__(self, sid, data_dir, characters):
        self.id = sid
        self.name = "候选测试会话"
        self.data_dir = Path(data_dir)
        self.combat_mode = "narrative"
        self.scene_manager = FakeSceneManager(characters)
        self.overlay = SimpleNamespace(get_worldbook_ids=lambda: [])


@pytest.fixture
def session_api(tmp_path):
    import session_manager as module
    from blueprints.sessions import register

    data_dir = tmp_path / SID
    data_dir.mkdir(parents=True, exist_ok=True)
    session = FakeSession(SID, data_dir, [CHAR])

    manager = object.__new__(module.SessionManager)
    manager._lock = threading.Lock()
    manager._sessions = {SID: session}

    app = Flask(__name__)
    app.config["TESTING"] = True
    register(app, {"session": manager, "worldbook": None})
    return app.test_client(), session


def upload(client, payload=IMG_A, filename="x.png", media_type="avatar", name=CHAR):
    return client.post(
        f"/api/sessions/{SID}/resources/characters/{name}/{media_type}/candidates",
        data={"file": (io.BytesIO(payload), filename)},
        content_type="multipart/form-data",
    )


def overview(client):
    response = client.get(f"/api/sessions/{SID}/resources")
    assert response.status_code == 200, response.json
    return response.json


def candidate_files(session, media_type="avatar", name=CHAR):
    d = session.data_dir / "resources" / "characters" / name / "candidates" / media_type
    return sorted(p.name for p in d.iterdir()) if d.is_dir() else []


def override_file(session, media_type="avatar", name=CHAR):
    d = session.data_dir / "resources" / "characters" / name
    found = [p for p in d.glob(f"{media_type}.*") if p.is_file()]
    return found[0] if found else None


# ── 1. 上传只进候选，不覆盖 ─────────────────────────────────────────────────

def test_upload_adds_candidate_without_touching_current_media(session_api):
    client, session = session_api
    response = upload(client)
    assert response.status_code == 201, response.json
    assert response.json["name"].startswith("cand-")

    body = overview(client)
    assert body["character_media"] == [], "上传不得直接产生会话覆盖"
    assert [c["media_type"] for c in body["character_candidates"]] == ["avatar"]
    assert body["character_candidates"][0]["key"] == CHAR

    assert override_file(session) is None
    assert len(candidate_files(session)) == 1


def test_candidates_are_not_reported_as_session_media(session_api):
    """候选目录存在时，list_session_media 仍不得把该角色算成已覆盖。"""
    client, _ = session_api
    assert upload(client).status_code == 201
    assert overview(client)["character_media"] == []


def test_candidate_url_serves_the_uploaded_bytes(session_api):
    client, _ = session_api
    upload(client)
    url = overview(client)["character_candidates"][0]["url"]
    response = client.get(url)
    assert response.status_code == 200
    assert response.data == IMG_A


def test_upload_rejects_unsupported_extension_and_media_type(session_api):
    client, _ = session_api
    assert upload(client, filename="x.gif").status_code == 400
    assert upload(client, media_type="portrait").status_code == 400
    assert upload(client, filename="x.txt").status_code == 400


# ── 2. 应用候选 = 成为会话覆盖 ───────────────────────────────────────────────

def test_apply_promotes_candidate_to_session_media(session_api):
    client, session = session_api
    upload(client, IMG_A)
    upload(client, IMG_B)
    first = overview(client)["character_candidates"][0]["name"]

    response = client.post(
        f"/api/sessions/{SID}/resources/characters/{CHAR}/avatar/candidates/{first}/apply")
    assert response.status_code == 200, response.json

    override = override_file(session)
    assert override is not None and override.read_bytes() == IMG_A
    body = overview(client)
    assert [m["media_type"] for m in body["character_media"]] == ["avatar"]
    # 候选不因应用而消失：玩家可以随时切回
    assert len(body["character_candidates"]) == 2


def test_switching_between_candidates_keeps_every_image_recoverable(session_api):
    """候选之间来回切换：旧覆盖已存在于候选列表 → 只去重，不重复归档。"""
    client, session = session_api
    upload(client, IMG_A)
    upload(client, IMG_B)
    names = [c["name"] for c in overview(client)["character_candidates"]]
    apply_url = f"/api/sessions/{SID}/resources/characters/{CHAR}/avatar/candidates"

    assert client.post(f"{apply_url}/{names[0]}/apply").status_code == 200
    assert client.post(f"{apply_url}/{names[1]}/apply").status_code == 200

    assert override_file(session).read_bytes() == IMG_B
    # 两张原图都还在候选里，可以随时切回
    assert candidate_files(session) == names


def test_direct_override_is_archived_when_a_candidate_is_applied(session_api):
    """换形象不丢图：不走候选产生的旧覆盖（如从图片库「选取」直接设的）归档回候选列表。"""
    client, session = session_api
    response = client.post(
        f"/api/sessions/{SID}/resources/characters/{CHAR}/avatar",
        data={"file": (io.BytesIO(IMG_A), "legacy.png")},
        content_type="multipart/form-data",
    )
    assert response.status_code == 201, response.json
    upload(client, IMG_B)
    name = overview(client)["character_candidates"][0]["name"]

    assert client.post(
        f"/api/sessions/{SID}/resources/characters/{CHAR}/avatar/candidates/{name}/apply"
    ).status_code == 200

    assert override_file(session).read_bytes() == IMG_B
    files = candidate_files(session)
    archived = [f for f in files if f.startswith("replaced-")]
    assert len(archived) == 1, files
    d = session.data_dir / "resources" / "characters" / CHAR / "candidates" / "avatar"
    assert (d / archived[0]).read_bytes() == IMG_A


def test_reapplying_the_same_candidate_does_not_duplicate_it(session_api):
    client, session = session_api
    upload(client, IMG_A)
    name = overview(client)["character_candidates"][0]["name"]
    apply_url = f"/api/sessions/{SID}/resources/characters/{CHAR}/avatar/candidates/{name}"

    assert client.post(f"{apply_url}/apply").status_code == 200
    assert client.post(f"{apply_url}/apply").status_code == 200

    files = candidate_files(session)
    assert files == [name], f"重复应用不应把同一张图归档成第二个候选：{files}"


def test_apply_unknown_candidate_is_404(session_api):
    client, _ = session_api
    response = client.post(
        f"/api/sessions/{SID}/resources/characters/{CHAR}/avatar/candidates/nope.png/apply")
    assert response.status_code == 404


# ── 3. 删除候选与安全校验 ───────────────────────────────────────────────────

def test_delete_candidate_keeps_the_applied_override(session_api):
    client, session = session_api
    upload(client, IMG_A)
    name = overview(client)["character_candidates"][0]["name"]
    base = f"/api/sessions/{SID}/resources/characters/{CHAR}/avatar/candidates/{name}"
    assert client.post(f"{base}/apply").status_code == 200

    assert client.delete(base).status_code == 200
    assert overview(client)["character_candidates"] == []
    assert override_file(session).read_bytes() == IMG_A


def test_traversal_filename_never_escapes_the_candidate_dir(session_api):
    client, session = session_api
    upload(client, IMG_A)
    apply_url = f"/api/sessions/{SID}/resources/characters/{CHAR}/avatar/candidates"
    name = overview(client)["character_candidates"][0]["name"]
    assert client.post(f"{apply_url}/{name}/apply").status_code == 200

    for evil in ("..%2Favatar.png", "..%2F..%2Favatar.png"):
        response = client.delete(
            f"/api/sessions/{SID}/resources/characters/{CHAR}/avatar/candidates/{evil}")
        assert response.status_code != 200, evil
    # 覆盖与候选都还在，没有被穿越删除
    assert override_file(session) is not None
    assert candidate_files(session) == [name]
