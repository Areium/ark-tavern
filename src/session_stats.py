"""Read-only character stat resolution shared by panels, prompts and story rules."""

from __future__ import annotations

import logging
from pathlib import Path

from character_stats import merge_character_stats, read_global_stats_from_meta, sanitize_values
from data_paths import installed_books_root
from document_manager import DocumentManager, DocumentNotFoundError

logger = logging.getLogger(__name__)


def read_character_stats_metadata(name: str, document_manager, *,
                                  book_id: str | None = None,
                                  book_ids: list[str] | None = None) -> dict | None:
    """Read frontmatter and derive ownership from the actual content folder."""
    try:
        doc = document_manager.read_document("characters", name, book_id=book_id,
                                             book_ids=book_ids)
    except DocumentNotFoundError:
        if book_ids is None:
            return None
        try:
            doc = document_manager.read_document("characters", name, book_id="")
        except (DocumentNotFoundError, ValueError):
            return None
    except ValueError:
        return None
    meta = dict(doc.get("metadata") or {})
    filepath = doc.get("filepath")
    root = getattr(document_manager, "_root", None)
    if filepath and root:
        try:
            relative = Path(filepath).relative_to(installed_books_root(root))
        except ValueError:
            relative = None
        meta["worldbook_id"] = relative.parts[0] if relative and len(relative.parts) > 1 else ""
    return meta


def resolve_book_stat_fields(worldbook_manager, book_id: str | None) -> tuple[list[dict], str]:
    """Return the selected book's schema, never another book's fallback schema."""
    if not book_id or worldbook_manager is None:
        return [], ""
    try:
        book = worldbook_manager.load(book_id)
    except Exception:
        logger.warning("数值字段读取失败: %s", book_id, exc_info=True)
        return [], ""
    if book is None:
        return [], ""
    return list(book.stat_fields or []), book.name


def resolve_session_character_stats(session, name: str, *, document_manager=None,
                                    worldbook_manager=None) -> dict:
    """Resolve defaults -> character frontmatter -> session character_stats.

    A bound session always uses its first book, even if that book has no fields
    or cannot be loaded. Only an unbound session may use the character's book.
    Custom scalar keys remain readable; story rules must authorize actors and
    restrict effects to declared fields themselves. This function never writes.

    The two-argument form uses the session's scene worldbook manager and the
    repository document manager; keyword dependencies support API/test callers.
    """
    overlay = session.overlay
    book_ids = overlay.get_worldbook_ids() if overlay is not None else []
    if document_manager is None:
        document_manager = DocumentManager()
    if worldbook_manager is None:
        scene = getattr(session, "scene_manager", None)
        worldbook_manager = getattr(scene, "_worldbook_manager", None)
    meta = read_character_stats_metadata(name, document_manager, book_ids=book_ids or None) or {}
    book_id = book_ids[0] if book_ids else str(meta.get("worldbook_id") or "")
    fields, book_name = resolve_book_stat_fields(worldbook_manager, book_id)
    session_values = overlay.get_character_stats(name) if overlay is not None else {}
    values, sources = merge_character_stats(fields, read_global_stats_from_meta(meta), session_values)
    return {
        "name": name,
        "worldbook_id": book_id,
        "worldbook_name": book_name,
        "fields": fields,
        "values": values,
        "sources": sources,
        "session_values": sanitize_values(fields, session_values),
    }
