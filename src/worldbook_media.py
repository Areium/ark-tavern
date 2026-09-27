"""Portable snapshots of the default character images owned by a worldbook."""

import base64
import binascii
import hashlib
from io import BytesIO
import re
import shutil
from pathlib import Path

import frontmatter
from PIL import Image, UnidentifiedImageError

from data_paths import CONTENT_ROOT


MEDIA_KINDS = ("avatar", "skin", "card_face")
_MIME_BY_SUFFIX = {".png": "image/png", ".jpg": "image/jpeg",
                   ".jpeg": "image/jpeg", ".webp": "image/webp"}
_DATA_URL = re.compile(r"^data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$")
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_BOOK_MEDIA_BYTES = 80 * 1024 * 1024
MAX_PROFILE_BYTES = 2 * 1024 * 1024
MAX_BOOK_PROFILE_BYTES = 16 * 1024 * 1024


def _character_root(character_id: str) -> Path | None:
    if (not character_id or character_id in (".", "..")
            or Path(character_id).name != character_id
            or "/" in character_id or "\\" in character_id
            or any(c in character_id for c in '<>:"|?*\x00')
            or character_id.endswith((".", " "))):
        return None
    base = (CONTENT_ROOT / "characters").resolve()
    path = base / character_id
    if path.is_symlink():
        return None
    resolved = path.resolve()
    return resolved if resolved.is_relative_to(base) else None


def snapshot_character_profile(character_id: str) -> str | None:
    root = _character_root(character_id)
    if root is None:
        return None
    path = root / "index.md"
    if not path.is_file() or path.is_symlink() or path.stat().st_size > MAX_PROFILE_BYTES:
        return None
    return path.read_text(encoding="utf-8")


def copied_character_id(character_id: str, book_id: str) -> str:
    root = _character_root(character_id)
    if root is None:
        raise ValueError("角色 ID 不能用于复制资源")
    base = re.sub(r"__wb_[a-f0-9]{12}$", "", character_id)
    if len(base) > 140:
        base = f"{base[:140]}_{hashlib.sha256(base.encode()).hexdigest()[:8]}"
    return f"{base}__wb_{book_id}"


def owned_materialized_character_root(character_id: str, book_id: str) -> Path | None:
    """Return only an imported character copy provably owned by this book."""
    if not re.fullmatch(r"[a-f0-9]{12}", book_id):
        return None
    if not character_id.endswith(f"__wb_{book_id}"):
        return None
    root = _character_root(character_id)
    if root is None or not root.is_dir() or root.is_symlink():
        return None
    profile = root / "index.md"
    if not profile.is_file() or profile.is_symlink():
        return None
    try:
        metadata = frontmatter.loads(profile.read_text(encoding="utf-8")).metadata
    except (OSError, ValueError):
        return None
    return root if metadata.get("worldbook_id") == book_id else None


def materialize_character(character_id: str, book_id: str, profile: str,
                          media: dict[str, str]) -> Path:
    """Create a private global character copy used by existing role systems.

    Returns its path only when newly created, so callers can roll it back if
    the worldbook save fails. An existing copy is never overwritten.
    """
    root = _character_root(character_id)
    if root is None or not isinstance(profile, str):
        raise ValueError("复制的角色资料无效")
    if len(profile.encode("utf-8")) > MAX_PROFILE_BYTES:
        raise ValueError("角色资料超过 2 MB")
    if root.exists():
        raise ValueError(f"角色副本已存在：{character_id}")
    post = frontmatter.loads(profile)
    post.metadata["worldbook_id"] = book_id
    post.metadata["source_character_id"] = re.sub(r"__wb_[a-f0-9]{12}$", "", character_id)
    for field in ("default_avatar", "default_skin", "card_face"):
        post.metadata.pop(field, None)
    root.mkdir(parents=True)
    try:
        for kind, url in media.items():
            payload, mime = decode_media_url(url)
            suffix = {"image/png": ".png", "image/jpeg": ".jpg",
                      "image/webp": ".webp"}[mime]
            filename = f"default{suffix}"
            folder = root / kind
            folder.mkdir()
            (folder / filename).write_bytes(payload)
            post.metadata[{"avatar": "default_avatar", "skin": "default_skin",
                           "card_face": "card_face"}[kind]] = filename
        (root / "index.md").write_text(frontmatter.dumps(post), encoding="utf-8")
    except Exception:
        shutil.rmtree(root)
        raise
    return root


def decode_media_url(value: str) -> tuple[bytes, str]:
    if not isinstance(value, str):
        raise ValueError("角色图片必须是内嵌图片数据")
    match = _DATA_URL.fullmatch(value)
    if not match or len(match[2]) > (MAX_IMAGE_BYTES * 4 // 3 + 8):
        raise ValueError("角色图片必须是受支持且不超过 20 MB 的内嵌图片")
    try:
        data = base64.b64decode(match[2], validate=True)
    except binascii.Error as exc:
        raise ValueError("角色图片的 Base64 数据无效") from exc
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise ValueError("角色图片大小无效或超过 20 MB")
    try:
        with Image.open(BytesIO(data)) as image:
            if image.format.lower() != match[1].split("/")[1]:
                raise ValueError("角色图片格式与声明不一致")
            image.verify()
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("角色图片内容无效") from exc
    return data, match[1]


def normalize_character_media(value) -> dict[str, dict[str, str]]:
    """Validate imported media before it can be persisted or served."""
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError("character_media 必须是对象")
    result = {}
    total = 0
    for character_id, media in value.items():
        if (not isinstance(character_id, str) or not character_id.strip()
                or len(character_id) > 200 or not isinstance(media, dict)):
            raise ValueError("角色资源的角色 ID 或内容无效")
        images = {}
        for kind, url in media.items():
            if kind not in MEDIA_KINDS:
                raise ValueError(f"不支持的角色资源类型：{kind}")
            payload, _ = decode_media_url(url)
            total += len(payload)
            if total > MAX_BOOK_MEDIA_BYTES:
                raise ValueError("世界书角色资源总量超过 80 MB")
            images[kind] = url
        if images:
            result[character_id] = images
    return result


def normalize_character_profiles(value) -> dict[str, str]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError("character_profiles 必须是对象")
    result = {}
    total = 0
    for character_id, profile in value.items():
        if (_character_root(character_id) is None or not isinstance(profile, str)
                or len(profile.encode("utf-8")) > MAX_PROFILE_BYTES):
            raise ValueError("角色资料无效或超过 2 MB")
        total += len(profile.encode("utf-8"))
        if total > MAX_BOOK_PROFILE_BYTES:
            raise ValueError("世界书角色资料总量超过 16 MB")
        result[character_id] = profile
    return result


def snapshot_character_media(character_id: str) -> dict[str, str]:
    """Copy the character's current default images into a self-contained book."""
    root = _character_root(character_id)
    if root is None:
        return {}
    from avatar_color import find_avatar_path, find_skin_path, find_card_face_path

    finders = {"avatar": find_avatar_path, "skin": find_skin_path,
               "card_face": find_card_face_path}
    result = {}
    captured_paths = set()
    for kind, finder in finders.items():
        found = finder(character_id)
        if not found:
            continue
        path = Path(found).resolve()
        if not path.is_relative_to(root):
            continue
        if kind == "card_face" and path in captured_paths:
            continue
        mime = _MIME_BY_SUFFIX.get(path.suffix.lower())
        if not mime:
            raise ValueError(f"角色「{character_id}」的 {kind} 图片格式不支持")
        if path.stat().st_size > MAX_IMAGE_BYTES:
            raise ValueError(f"角色「{character_id}」的 {kind} 图片超过 20 MB")
        data = path.read_bytes()
        if data:
            url = f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
            decode_media_url(url)
            result[kind] = url
            captured_paths.add(path)
    return result
