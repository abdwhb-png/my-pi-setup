"""Run in the pinned builder: python3 -m unittest build_test.py."""
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("runtime_build", Path(__file__).with_name("build.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

native_spec = importlib.util.spec_from_file_location("native_ci", Path(__file__).with_name("native-ci.py"))
native_ci = importlib.util.module_from_spec(native_spec)
native_spec.loader.exec_module(native_ci)


class RuntimeRelocationTests(unittest.TestCase):
    def test_native_builder_uses_transport_certificates_without_upgrading_the_pinned_image(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tools = root / "tools"
            (tools / "inputs").mkdir(parents=True)
            (tools / "input-lock.json").write_text(json.dumps({
                "snapshot": "20260912T120000Z", "image": "ubuntu@sha256:fixture",
            }))
            for name in ["packages", "assets"]:
                (tools / f"inputs/{name}.json").write_text("[]")
            engine = root / "engine-source"
            binary = engine / "target/x86_64-unknown-linux-gnu/release/zerobox"
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b"engine")
            (engine / "UPSTREAM_VERSION").write_text("fixture")
            inputs = root / "inputs"
            commands = []

            def run(*args, **kwargs):
                commands.append(args)
                if "assemble" in args:
                    target = inputs / "candidate/bin/zerobox"
                    target.parent.mkdir(parents=True)
                    target.write_bytes(b"engine")

            def output(*args, **kwargs):
                if args[:3] == ("git", "status", "--porcelain"):
                    return ""
                return "fixture"

            with (
                patch.object(native_ci, "__file__", str(tools / "native-ci.py")),
                patch.object(native_ci, "require_native_linux"),
                patch.object(native_ci, "run", side_effect=run),
                patch.object(native_ci, "output", side_effect=output),
                patch("sys.argv", [
                    "native-ci.py", "--engine-root", str(engine),
                    "--agent-root", str(root / "agent"),
                    "--input-root", str(inputs), "--version", "fixture",
                ]),
                patch.dict("os.environ", {"GITHUB_ENV": str(root / "env")}),
            ):
                native_ci.main()
            create = next(command for command in commands if command[:2] == ("docker", "create"))
            self.assertIn("/etc/ssl/certs/ca-certificates.crt:/etc/ssl/certs/ca-certificates.crt:ro", create)
            self.assertFalse(any("ca-certificates" in command for command in commands))
            self.assertTrue(any("--snapshot" in command and "update" in command for command in commands))

    def test_native_package_download_uses_the_locked_archive_snapshot(self):
        command = native_ci.package_download_command(
            {"snapshot": "20260912T120000Z"},
            [{"package": "libexpat1", "version": "2.6.1-2ubuntu0.4"}],
        )
        self.assertEqual(
            command,
            [
                "apt-get",
                "--snapshot",
                "20260912T120000Z",
                "download",
                "libexpat1=2.6.1-2ubuntu0.4",
            ],
        )

    def test_analysis_closure_does_not_depend_on_installer_dependency_layout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            results = []
            for layout in ["hoisted", "nested"]:
                agent = root / layout
                modules = agent / "extensions/sandbox/node_modules"
                for name in ["@bsull/eryx", "@jitl/quickjs-ng-wasmfile-release-sync", "@sebastianwessel/quickjs", "typescript"]:
                    package = modules / name
                    package.mkdir(parents=True)
                    dependencies = {"shared-dependency": "1.0.0"} if name == "@bsull/eryx" else {}
                    (package / "package.json").write_text(json.dumps({"name": name, "version": "1.0.0", "dependencies": dependencies}))
                dependency = (modules if layout == "hoisted" else modules / "@bsull/eryx/node_modules") / "shared-dependency"
                dependency.mkdir(parents=True)
                (dependency / "package.json").write_text(json.dumps({"name": "shared-dependency", "version": "1.0.0"}))
                (dependency / "index.js").write_text("export default 42;\n")
                output = root / f"{layout}-output"
                results.append(builder.copy_analysis_closure(agent, output))
                self.assertEqual((output / "node_modules/shared-dependency/index.js").read_text(), "export default 42;\n")
                self.assertFalse((output / "node_modules/@bsull/eryx/node_modules").exists())
            self.assertEqual(len(results[0]), 5)
            self.assertEqual(results[0], results[1])

    def test_distribution_modes_do_not_inherit_writable_package_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / "tool"
            executable.write_text("#!/bin/sh\n")
            executable.chmod(0o777)
            resource = root / "resource"
            resource.write_text("data")
            resource.chmod(0o666)
            builder.seal_tree(root)
            self.assertEqual(executable.stat().st_mode & 0o777, 0o555)
            self.assertEqual(resource.stat().st_mode & 0o777, 0o444)

    def test_relocated_bash_resolves_every_needed_library_by_its_soname(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "bin").mkdir()
            shutil.copy2("/usr/bin/bash", root / "bin/bash")
            builder.relocate(root, "/__zerobox/runtime")
            for binary in [root / "bin/bash", *root.joinpath("lib").iterdir()]:
                dynamic = subprocess.check_output(["readelf", "-d", str(binary)], text=True)
                for name in re.findall(r"\(NEEDED\).*?\[(.*?)\]", dynamic):
                    self.assertTrue((root / "lib" / name).is_file(), f"{binary.name} requires {name}")


if __name__ == "__main__":
    unittest.main()
