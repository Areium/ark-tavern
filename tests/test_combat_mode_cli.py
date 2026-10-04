import importlib.util
from pathlib import Path

from test_combat_mode_packages import archive, package_files

spec = importlib.util.spec_from_file_location(
    "combat_mode_cli", Path(__file__).resolve().parents[1] / "tools" / "combat_mode.py")
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


def test_cli_lifecycle_and_no_export_overwrite(tmp_path, capsys):
    source = tmp_path / "input.zip"
    source.write_bytes(archive(package_files()))
    prefix = ["--project-root", str(tmp_path / "project")]
    assert cli.main(prefix + ["install", str(source)]) == 0
    assert cli.main(prefix + ["list"]) == 0
    assert cli.main(prefix + ["disable", "test-mode"]) == 0
    output = tmp_path / "output.zip"
    assert cli.main(prefix + ["export", "test-mode", str(output)]) == 0
    original = output.read_bytes()
    assert cli.main(prefix + ["export", "test-mode", str(output)]) == 1
    assert output.read_bytes() == original
    assert cli.main(prefix + ["enable", "test-mode"]) == 0
    assert cli.main(prefix + ["uninstall", "test-mode"]) == 0
    assert cli.main(prefix + ["export", "test-mode", str(tmp_path / "missing.zip")]) == 1
