"""Install and manage combat mode packages without starting the application."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from combat_mode_packages import CombatModePackages, MAX_PACKAGE_BYTES
from data_paths import PROJECT_ROOT


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, default=PROJECT_ROOT)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list")
    install = commands.add_parser("install")
    install.add_argument("zip", type=Path)
    export = commands.add_parser("export")
    export.add_argument("id")
    export.add_argument("output", type=Path)
    for name in ("enable", "disable", "uninstall"):
        commands.add_parser(name).add_argument("id")
    args = parser.parse_args(argv)
    packages = CombatModePackages(args.project_root)
    try:
        if args.command == "list":
            result = packages.list()
        elif args.command == "install":
            with args.zip.open("rb") as stream:
                result = packages.install(stream.read(MAX_PACKAGE_BYTES + 1))
        elif args.command == "export":
            raw = packages.get(args.id, require_enabled=False).archive()
            # Never overwrite an existing user export.
            with args.output.open("xb") as stream:
                stream.write(raw)
            result = {"exported_to": str(args.output)}
        elif args.command == "uninstall":
            result = packages.uninstall(args.id)
        else:
            packages.set_enabled(args.id, args.command == "enable")
            result = {"id": args.id, "enabled": args.command == "enable"}
    except (ValueError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
