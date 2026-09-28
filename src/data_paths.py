"""Canonical paths for repository data.

Callers that operate on a test checkout can pass its repository root to the
helpers.  Runtime callers use the constants derived from this module's own
location.
"""

from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent


def data_root(project_root: str | Path | None = None) -> Path:
    return Path(project_root) / "data" if project_root is not None else PROJECT_ROOT / "data"


def worldbooks_root(project_root: str | Path | None = None) -> Path:
    return data_root(project_root) / "worldbooks"


def installed_books_root(project_root: str | Path | None = None) -> Path:
    return worldbooks_root(project_root) / "books"


def content_root(project_root: str | Path | None = None) -> Path:
    return worldbooks_root(project_root) / "content"


def packs_root(project_root: str | Path | None = None) -> Path:
    return worldbooks_root(project_root) / "packs"


def memory_root(project_root: str | Path | None = None) -> Path:
    return data_root(project_root) / "memory"


def categories_path(project_root: str | Path | None = None) -> Path:
    return data_root(project_root) / "categories.yaml"


DATA_ROOT = data_root()
WORLDBOOKS_ROOT = worldbooks_root()
INSTALLED_BOOKS_ROOT = installed_books_root()
CONTENT_ROOT = content_root()
PACKS_ROOT = packs_root()
MEMORY_ROOT = memory_root()
CATEGORIES_PATH = categories_path()
