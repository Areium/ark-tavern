"""Load the review-only story into temporary data roots, never a live registry.

Only filesystem/configuration locations are redirected. Production parsers,
Flask routes, session persistence, combat and settlement are not replaced.
Offline callers may explicitly script the LLM and must label that evidence.
This is a fixture for the audited routes, not a generic filesystem sandbox.
Audit additional content-upload/configuration routes before using them here.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from contextlib import ExitStack, contextmanager
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / "docs" / "scenarios" / "greybridge-echoes"
sys.path.insert(0, str(ROOT / "src"))


def manifest():
    return json.loads((PACK / "manifest.json").read_text(encoding="utf-8"))


@contextmanager
def candidate_app(*, config_path: Path | None = None, root: Path | None = None):
    """Use an owned temp root, or an explicitly supplied EMPTY audit directory.

    The real configuration is copied locally, never printed or modified. The
    caller owns a supplied root; it is retained as reproducible test evidence.
    """
    with ExitStack() as stack:
        if root is None:
            root = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="tavern_story_audit_")))
        else:
            root = Path(root).resolve()
            if root.exists() and any(root.iterdir()):
                raise ValueError("Audit root must be empty; refusing to overwrite data")
            root.mkdir(parents=True, exist_ok=True)
        data = root / "data"
        # No user sessions, assets, secrets, job caches or audio are copied.
        # Markdown, character cards, enemy templates and class cards are needed
        # by the real production loaders. All mutations target this copy.
        content = data / "worldbooks" / "content"
        shutil.copytree(
            ROOT / "data" / "worldbooks" / "content", content,
            ignore=shutil.ignore_patterns("audio", "spine", "__pycache__"),
        )
        shutil.copyfile(ROOT / "data" / "categories.yaml", data / "categories.yaml")
        shutil.copytree(ROOT / "data" / "worldbooks" / "packs", data / "worldbooks" / "packs")
        spec = manifest()
        plot_dir = content / "plots" / spec["plot_id"]
        plot_dir.mkdir()
        shutil.copyfile(PACK / "plot.md", plot_dir / "index.md")
        for node_id in spec["battles"]:
            target = content / "combat" / "nodes" / f"{node_id}.json"
            if target.exists():
                raise ValueError(f"Candidate node collides with shipped content: {node_id}")
            shutil.copyfile(PACK / "battles" / target.name, target)
        # Credentials must disappear even when the caller retains an audit root.
        config_dir = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="tavern_story_config_")))
        cfg = config_dir / "llm_config.json"
        if config_path is not None:
            shutil.copyfile(config_path, cfg)
        else:
            cfg.write_text(json.dumps({
                "api_key": "", "base_url": "", "provider": "cloud",
                "ollama_url": "http://127.0.0.1:1", "auto_generate_choices": True,
                "memory_interval": 999,
            }), encoding="utf-8")

        import CharacterAgent as ca
        import avatar_color as av
        import character_card as cc
        import combat_data_loader as cdl
        import combat_nodes as cn
        import combat_resume as cr
        import combat_rules as rules
        import combat_session as combat_session_module
        import environment_state as environment_state_module
        import llm_backend_manager as lb
        import memory as memory_module
        import player_profile as player_profile_module
        import session_export as se
        import session_manager as sm
        import session_overlay as so
        import world_book as wb
        from combat_engine import card_json_loader
        from load_llm import ApiModelConfig, ModelConfig
        from wiki_manager import WikiManager

        # Track every Chroma client created against this audit root. A story
        # reload may construct another SessionManager outside app._managers, so
        # walking only the app's current agents misses live SQLite handles.
        import chromadb
        audit_clients = []
        persistent_client = chromadb.PersistentClient
        root_resolved = root.resolve()

        def tracked_persistent_client(*args, **kwargs):
            client = persistent_client(*args, **kwargs)
            client_path = kwargs.get("path", args[0] if args else "./chroma")
            try:
                Path(client_path).resolve().relative_to(root_resolved)
            except (OSError, TypeError, ValueError):
                return client
            audit_clients.append(client)
            return client

        # LLMBackendManager updates process-local defaults; restore those too.
        stack.enter_context(patch.dict(os.environ, dict(os.environ)))
        stack.enter_context(patch.object(chromadb, "PersistentClient", tracked_persistent_client))
        for cls, fields in [(ApiModelConfig, ("api_key", "base_url", "model", "max_tokens")),
                            (ModelConfig, ("model", "max_tokens"))]:
            for key in fields:
                stack.enter_context(patch.object(cls, key, getattr(cls, key)))
        sessions = data / "memory" / "sessions"
        for module, key, value in [
            (so, "_PROJECT_ROOT", root), (so, "_SESSIONS_DIR", sessions),
            (sm, "_SESSIONS_DIR", sessions), (sm, "_registry", WikiManager(str(root))),
            (se, "_REPO_ROOT", root), (se, "_SESSIONS_DIR", sessions),
            (se, "_CHARS_DIR", content / "characters"),
            (se, "_BG_ROOT", content / "combat" / "backgrounds"),
            (ca, "CONTENT_ROOT", content),
            (av, "_CHARS_ROOT", content / "characters"),
            (cc, "_DEFAULT_CHARS_DIR", content / "characters"),
            (combat_session_module, "CONTENT_ROOT", content),
            (environment_state_module, "_DEFAULT_ENV_DIR", str(content / "environment")),
            (memory_module, "PROJECT_ROOT", root),
            (player_profile_module, "_CHARS_DIR", content / "characters"),
            (player_profile_module, "_profile_cache", {}),
            (card_json_loader, "_CLASS_DIR", content / "classes"),
            (card_json_loader, "_cache", {}),
            (rules, "RULES_DIR", content / "combat" / "rules"),
            (rules, "_cache", {}),
            (cdl, "_DATA_DIR", content / "combat"),
            (cn, "NODE_DIR", content / "combat" / "nodes"),
            (cn, "PLOT_DIR", content / "plots"), (cn, "TILES_DIR", content / "combat" / "tiles"),
            (cr, "TEST_RESUME_DIR", data / "memory" / "combat_resumes"),
            (wb, "_WORLDBOOKS_DIR", data / "worldbooks"),
            (wb, "_PACKS_DIR", data / "worldbooks" / "packs"), (lb, "_CONFIG_PATH", cfg),
        ]:
            stack.enter_context(patch.object(module, key, value))
        from blueprints import (
            assets as assets_bp,
            cards as cards_bp,
            environment as environment_bp,
            sessions as sessions_bp,
        )
        stack.enter_context(patch.object(sessions_bp, "_REPO_ROOT", root))
        stack.enter_context(patch.object(environment_bp, "_REPO_ROOT", root))
        stack.enter_context(patch.object(assets_bp, "CONTENT_ROOT", content))
        stack.enter_context(patch.object(cards_bp, "CHAR_DIR", content / "characters"))
        stack.enter_context(patch.object(cards_bp, "CLASS_DIR", content / "classes"))
        import app as app_module
        from document_manager import DocumentManager

        stack.enter_context(patch.object(app_module, "DocumentManager", lambda: DocumentManager(str(root))))
        stack.enter_context(patch.object(app_module, "WikiManager", lambda: WikiManager(str(root))))
        if config_path is None:
            stack.enter_context(patch.object(lb.LLMBackendManager, "get_llm", return_value=(None, None)))
        app = app_module.create_app()
        app.config.update(TESTING=True)
        try:
            yield {"app": app, "client": app.test_client(), "root": root, "manifest": spec}
        finally:
            # Chroma keeps SQLite open on Windows until each client is closed.
            # Only clients whose storage path resolved inside this owned audit
            # root were recorded; live project memory clients are never closed.
            for client in reversed(audit_clients):
                if hasattr(client, "close"):
                    client.close()


def create_story(ctx, *, combat_mode="narrative", roster=None, worldbook_id=""):
    response = ctx["client"].post("/api/sessions", json={
        "name": "灰桥回声·隔离验收", "mode": "story", "combat_mode": combat_mode,
        "plot_id": ctx["manifest"]["plot_id"], "worldbook_id": worldbook_id,
        "roster_character_ids": ctx["manifest"]["roster"] if roster is None else roster,
    })
    if response.status_code != 201:
        raise AssertionError((response.status_code, response.get_json()))
    sid = response.get_json()["id"]
    return ctx["app"]._managers["session"].get_session(sid)


def scripted_round(session, *, complete=True, branches=None, narrative=None, env=None):
    """Explicitly scripted LLM boundary; never use this in a real-LLM run."""
    beat = session.overlay.get_current_beat()
    title = beat["id"] if beat else "after_end"
    body = narrative or f"AUDIT_SENTINEL {title}：博士核对事实，干员完成本段行动。"
    session._llm = object()
    session.scene_manager.narrate = lambda *a, **k: (body, env or {}, None)
    session.scene_manager.extract_markers = lambda *a, **k: {
        "beat_complete": complete, "combat": None, "choices": None,
        "branches": branches, "node_title": title, "summary": body,
        "environment": env, "usage": None, "error": None,
    }
