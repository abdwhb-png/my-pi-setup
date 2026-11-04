"""Run in the pinned builder: python3 -m unittest build_test.py."""
import importlib.util
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location("runtime_build", Path(__file__).with_name("build.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

native_spec = importlib.util.spec_from_file_location("native_ci", Path(__file__).with_name("native-ci.py"))
native_ci = importlib.util.module_from_spec(native_spec)
native_spec.loader.exec_module(native_ci)


class RuntimeRelocationTests(unittest.TestCase):
    def test_native_download_retries_a_transient_failure_without_changing_the_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = b"locked input"
            item = {"file": "fixture.deb", "url": "https://archive.ubuntu.com/fixture.deb",
                    "sha256": hashlib.sha256(payload).hexdigest()}
            failure = HTTPError(item["url"], 503, "Service Unavailable", None, None)
            with patch.object(native_ci.urllib.request, "urlopen", side_effect=[failure, io.BytesIO(payload)]), patch("time.sleep"):
                native_ci.download_input(item, root)
            self.assertEqual((root / item["file"]).read_bytes(), payload)
            self.assertEqual(list(root.iterdir()), [root / item["file"]])

    def test_native_download_rejects_corruption_and_preserves_existing_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            item = {"file": "fixture.deb", "url": "https://archive.ubuntu.com/fixture.deb",
                    "sha256": hashlib.sha256(b"locked input").hexdigest()}
            with patch.object(native_ci.urllib.request, "urlopen", return_value=io.BytesIO(b"corrupted input")):
                with self.assertRaisesRegex(RuntimeError, "digest mismatch: fixture.deb"):
                    native_ci.download_input(item, root)
            self.assertEqual(list(root.iterdir()), [])
            existing = root / item["file"]
            existing.write_bytes(b"preserved")
            with patch.object(native_ci.urllib.request, "urlopen", return_value=io.BytesIO(b"locked input")):
                with self.assertRaises(FileExistsError):
                    native_ci.download_input(item, root)
            self.assertEqual(existing.read_bytes(), b"preserved")
            self.assertEqual(list(root.iterdir()), [existing])

    def test_native_download_failures_are_bounded_and_do_not_leave_partial_files(self):
        for status in [503, 404]:
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                item = {"file": "fixture.deb", "url": "https://archive.ubuntu.com/fixture.deb",
                        "sha256": hashlib.sha256(b"locked input").hexdigest()}
                failure = HTTPError(item["url"], status, "Fixture failure", None, None)
                with patch.object(native_ci.urllib.request, "urlopen", side_effect=failure) as request, patch("time.sleep"):
                    with self.assertRaises(HTTPError):
                        native_ci.download_input(item, root)
                self.assertEqual(request.call_count, 3 if status == 503 else 1)
                self.assertEqual(list(root.iterdir()), [])

    def test_native_downloads_remain_readable_by_the_offline_package_installer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            item = {"file": "fixture.deb", "url": "https://archive.ubuntu.com/fixture.deb",
                    "sha256": hashlib.sha256(b"locked input").hexdigest()}
            previous_umask = native_ci.os.umask(0o077)
            try:
                with patch.object(native_ci.urllib.request, "urlopen", return_value=io.BytesIO(b"locked input")):
                    native_ci.download_input(item, root)
            finally:
                native_ci.os.umask(previous_umask)
            self.assertEqual((root / item["file"]).stat().st_mode & 0o777, 0o644)

    def test_native_builder_downloads_locked_packages_without_snapshot_indexes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tools = root / "tools"
            (tools / "inputs").mkdir(parents=True)
            (tools / "input-lock.json").write_text(json.dumps({
                "snapshot": "20260912T120000Z", "image": "ubuntu@sha256:fixture",
            }))
            package_bytes = b"locked Ubuntu package"
            package_file = "gawk_1%3a5.2.1-2ubuntu0.1_amd64.deb"
            package_url = "https://launchpadlibrarian.net/12345/gawk_5.2.1-2ubuntu0.1_amd64.deb"
            (tools / "inputs/packages.json").write_text(json.dumps([{
                "package": "gawk", "version": "1:5.2.1-2ubuntu0.1", "file": package_file,
                "sha256": hashlib.sha256(package_bytes).hexdigest(), "url": package_url,
            }]))
            (tools / "inputs/assets.json").write_text("[]")
            engine = root / "engine-source"
            binary = engine / "target/x86_64-unknown-linux-gnu/release/zerobox"
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b"engine")
            (engine / "UPSTREAM_VERSION").write_text("fixture")
            inputs = root / "inputs"
            commands = []
            requests = []

            def download(url, **kwargs):
                requests.append(url)
                self.assertEqual(url, package_url)
                return io.BytesIO(package_bytes)

            def run(*args, **kwargs):
                commands.append(args)
                if "download" in args:
                    (inputs / "build-inputs" / package_file).write_bytes(package_bytes)
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
                patch.object(native_ci.urllib.request, "urlopen", side_effect=download),
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
            self.assertEqual(requests, [package_url])
            self.assertEqual((inputs / "build-inputs" / package_file).read_bytes(), package_bytes)
            self.assertFalse(any("update" in command or "download" in command for command in commands))
            disconnect = next(index for index, command in enumerate(commands) if command[:3] == ("docker", "network", "disconnect"))
            install = next(index for index, command in enumerate(commands) if "install" in command)
            self.assertLess(disconnect, install)

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
