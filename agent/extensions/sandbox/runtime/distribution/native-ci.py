#!/usr/bin/env python3
"""Assemble a source-built candidate on a disposable native Linux CI runner."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid


def run(*args, cwd=None):
    subprocess.run(args, cwd=cwd, check=True)


def output(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def download_input(item, directory):
    filename = item["file"]
    if not isinstance(filename, str) or Path(filename).name != filename:
        raise RuntimeError("Locked input must have a plain filename")
    with tempfile.TemporaryDirectory(prefix=".download-", dir=directory) as staging:
        downloaded = Path(staging) / filename
        for attempt in range(3):
            try:
                with urllib.request.urlopen(item["url"], timeout=120) as response:
                    with downloaded.open("wb") as target:
                        shutil.copyfileobj(response, target)
                break
            except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
                if (isinstance(error, urllib.error.HTTPError)
                        and error.code not in {429, 500, 502, 503, 504}) or attempt == 2:
                    raise
                print(f"Retrying locked input {filename} ({attempt + 2}/3)", file=sys.stderr, flush=True)
                time.sleep(2 ** attempt)
        if digest(downloaded) != item["sha256"]:
            raise RuntimeError(f"Runtime input digest mismatch: {filename}")
        downloaded.chmod(0o644)
        os.link(downloaded, directory / filename)


def require_native_linux():
    if (platform.system() != "Linux" or platform.machine() != "x86_64"
            or "microsoft" in platform.release().lower()
            or "wsl" in platform.release().lower()):
        raise RuntimeError("Native Linux x86_64 qualification cannot run on WSL or another platform")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-host", action="store_true")
    parser.add_argument("--engine-root", type=Path)
    parser.add_argument("--agent-root", type=Path)
    parser.add_argument("--input-root", type=Path)
    parser.add_argument("--version")
    args = parser.parse_args()
    require_native_linux()
    if args.check_host:
        print(platform.release())
        return
    if not all((args.engine_root, args.agent_root, args.input_root, args.version)):
        parser.error("engine-root, agent-root, input-root and version are required")
    root = args.input_root.resolve()
    root.mkdir(mode=0o700)
    engine_root = args.engine_root.resolve()
    agent = args.agent_root.resolve()
    tools = Path(__file__).resolve().parent
    lock = json.loads((tools / "input-lock.json").read_text())
    packages = json.loads((tools / "inputs/packages.json").read_text())
    snapshot = lock.get("snapshot")
    if not isinstance(snapshot, str) or re.fullmatch(r"\d{8}T\d{6}Z", snapshot) is None:
        raise RuntimeError("Native qualification requires a locked Ubuntu snapshot")
    assets = json.loads((tools / "inputs/assets.json").read_text())
    downloads = root / "downloads"
    downloads.mkdir()
    (root / "build-inputs").mkdir()
    (root / "build-inputs").chmod(0o755)
    for asset in assets:
        download_input(asset, downloads)
    for package in packages:
        download_input(package, root / "build-inputs")
    binary = engine_root / "target/x86_64-unknown-linux-gnu/release/zerobox"
    if output("git", "status", "--porcelain", cwd=engine_root):
        raise RuntimeError("Native qualification requires a clean engine source checkout")
    shutil.copy2(binary, root / "engine")
    provenance = {
        "version": output(str(binary), "--version").split()[-1],
        "binaryName": "zerobox",
        "binarySha256": digest(binary),
        "helperSha256": digest(binary),
        "sourceCommit": output("git", "rev-parse", "HEAD", cwd=engine_root),
        "build": {
            "compiler": output("rustc", "--version"),
            "command": "cargo rustc --offline --locked --release -p zerobox --bin zerobox --target x86_64-unknown-linux-gnu -- -C target-feature=+crt-static",
        },
        "engineVersionFile": (engine_root / "UPSTREAM_VERSION").read_text().splitlines(),
        "patches": [{"path": path.relative_to(engine_root).as_posix(), "sha256": digest(path)}
                    for path in sorted((engine_root / "scripts").glob("upstream-*.patch"))],
    }
    (root / "engine-provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    if not Path("/etc/ssl/certs/ca-certificates.crt").is_file():
        raise RuntimeError("Native runner requires a CA certificate bundle for snapshot downloads")
    run("docker", "pull", lock["image"])
    container = f"pi-native-runtime-{uuid.uuid4().hex}"
    run("docker", "create", "--name", container,
        "-v", f"{root}:/inputs", "-v", f"{agent}:/agent:ro",
        "-v", f"{root / 'build-inputs'}:/packages:ro",
        "-v", "/etc/ssl/certs/ca-certificates.crt:/etc/ssl/certs/ca-certificates.crt:ro",
        "-v", f"{tools}:/build:ro", lock["image"], "sleep", "infinity")
    try:
        run("docker", "start", container)
        run("docker", "network", "disconnect", "bridge", container)
        # Let apt order Pre-Depends, using only the already verified local
        # packages. The separate mount lets _apt read them without opening the
        # private input root. The disconnected container cannot fetch more inputs.
        run("docker", "exec", "-e", "DEBIAN_FRONTEND=noninteractive", "-e", "TZ=Etc/UTC",
            container, "apt-get", "--no-install-recommends", "--yes", "install",
            *[f"/packages/{p['file']}" for p in packages])
        run("docker", "exec", "-e", "PYTHONDONTWRITEBYTECODE=1", "-w", "/build",
            container, "python3", "-m", "unittest", "build_test.py")
        run("docker", "exec", container, "python3", "/build/build.py", "assemble",
            "--lock", "/build/input-lock.json", "--input-root", "/inputs",
            "--builder-root", "/", "--agent-root", "/agent", "--engine", "/inputs/engine",
            "--helper", "/inputs/engine", "--engine-provenance", "/inputs/engine-provenance.json",
            "--output", "/inputs/candidate", "--version", args.version)
        run("docker", "exec", container, "chown", "-R", f"{os.getuid()}:{os.getgid()}", "/inputs/candidate")
    finally:
        run("docker", "rm", "--force", container)
    candidate = root / "candidate"
    evidence = {"candidateRoot": str(candidate), "binarySha256": digest(candidate / "bin/zerobox"),
                "kernel": platform.release(), "sourceCommit": provenance["sourceCommit"]}
    (root / "native-build.json").write_text(json.dumps(evidence, indent=2) + "\n")
    env_file = os.environ.get("GITHUB_ENV")
    if env_file:
        with open(env_file, "a") as target:
            target.write(f"PI_SANDBOX_RUNTIME_BUNDLE={candidate}\n")
            target.write(f"PI_SANDBOX_ZEROBOX_BINARY={candidate / 'bin/zerobox'}\n")
            target.write(f"PI_SANDBOX_ZEROBOX_SHA256={evidence['binarySha256']}\n")


if __name__ == "__main__":
    main()
