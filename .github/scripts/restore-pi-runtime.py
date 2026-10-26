#!/usr/bin/env python3
"""Restore the exact frozen Pi archives referenced by the agent lockfile."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
import shutil


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent-root", required=True, type=Path)
    parser.add_argument("--fixture-root", required=True, type=Path)
    args = parser.parse_args()
    agent = args.agent_root.resolve()
    fixture = args.fixture_root.resolve()
    manifest = json.loads((fixture / "release-manifest.json").read_text())
    packages = {entry["name"]: entry for entry in manifest["packages"]}
    dependencies = json.loads((agent / "package.json").read_text())["dependencies"]
    pending = []
    for name, spec in dependencies.items():
        if not name.startswith("@earendil-works/"):
            continue
        if not spec.startswith("file:../runtime/pi-core/releases/"):
            raise ValueError(f"Expected an immutable Pi archive for {name}")
        entry = packages[name]
        source = (fixture / entry["tarball"]).resolve()
        destination = (agent / spec.removeprefix("file:")).resolve()
        if not source.is_relative_to(fixture) or not destination.is_relative_to(agent.parent / "runtime/pi-core/releases"):
            raise ValueError(f"Archive path escapes the runtime boundary: {name}")
        if source.name != destination.name:
            raise ValueError(f"Archive name differs from the daily dependency: {name}")
        if sha256(source.read_bytes()).hexdigest() != entry["sha256"]:
            raise ValueError(f"Archive checksum mismatch: {name}")
        pending.append((source, destination))
    for source, destination in pending:
        destination.parent.mkdir(parents=True, exist_ok=True)
        if source != destination:
            shutil.copyfile(source, destination)
    print(f"Restored {len(pending)} verified daily Pi archives; lockfile unchanged")


if __name__ == "__main__":
    main()
