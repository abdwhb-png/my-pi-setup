# Private runtime distribution builder

Build only inside the Ubuntu 24.04 amd64 builder pinned by `input-lock.json`. `input-lock.json` and its tracked `inputs/` directory pin the builder image, exact `.deb` filenames/versions/SHA-256s, builder package versions, Node and Bun archives, and the Analysis package closure. Analysis inputs include the TypeScript transformer peer, each package version and a digest of its full copied file tree. The command uses no network and rejects inputs that differ from these records.

Prepare a cache before the offline assembly. Pull the exact Ubuntu image digest, obtain the Node 24.18.0 and Bun 1.3.14 archives from the URLs in `inputs/assets.json`, and obtain the exact Ubuntu 24.04 amd64 `.deb` files named by `inputs/packages.json` from an approved Ubuntu archive or mirror snapshot. Copy them to `downloads/` and `build-inputs/` under the chosen input root. Reject every download whose SHA-256 differs from the tracked index; the builder independently repeats that check. Disconnect the builder network before installing these verified local `.deb` files with APT, which orders their pre-dependencies. The assembly verifies the complete installed package set and never resolves or installs dependencies.

Preserve library SONAME aliases when relocating the ELF closure. Use relative symlinks within each component, and remove inherited package write permissions from distributed files. Run `python3 -m unittest build_test.py` inside the pinned builder to check those distribution boundaries.

Preserve the executable's existing ELF program headers when replacing `PT_INTERP`: require the private loader path to fit the original field and reject any binary where it does not fit. The pinned PatchELF interpreter rewrite makes Bun exit with signal 11, including with `--no-sort`. Use the bounded in-place interpreter replacement for distributed executables and PatchELF for `DT_RPATH`. Verify Bun by running the real private Analysis worker. Never rewrite an authorized personal installation.

```text
python3 build.py assemble \
  --lock runtime/distribution/input-lock.json \
  --input-root /prepared/pi-runtime-inputs \
  --builder-root / \
  --agent-root /work/agent \
  --engine /work/zerobox \
  --helper /work/zerobox-linux-sandbox \
  --engine-provenance /work/zerobox-provenance.json \
  --output /out/zerobox-2026.09.12.1 \
  --version 2026.09.12.1
```

The supplied engine and helper must be regular files. The helper is copied as a static engine-build input at `components/shell/libexec/zerobox-linux-sandbox` only after `readelf` confirms it has no dynamic interpreter. The builder runs the supplied engine's `--version` command and requires it to match the supplied provenance before writing the candidate. `--version` names the runtime distribution, while candidate provenance preserves the rebuilt engine version and records the distribution as `runtimeVersion`. It also records the pinned image, input-lock SHA-256, durable metadata digests, exact `.deb` versions/hashes, archive URLs/hashes, and builder package versions. The builder uses the downloaded, unmodified Bun archive to build the QuickJS worker before relocating the distributed binaries and libraries. It recursively copies the locked Analysis dependency closure, including conflicting nested jsonjoy versions, copies package licences, hashes every emitted regular file and records symlinks in `manifest.json`.

Stage only after independent qualification, never as part of ordinary builds or tests:

```text
bun stage-release.ts \
  --candidate-root /out/zerobox-2026.09.12.1 \
  --runtime-base ~/.pi/runtimes \
  --managed-binary ~/.pi/bin/zerobox \
  --provenance-source /work/zerobox-provenance.json \
  --previous-provenance-source /work/previous-zerobox-provenance.json \
  --expected-binary-sha256 <sha256>
```

`stageRuntimeRelease` validates the candidate with `resolvePrivateRuntime`, writes a versioned release and matching provenance together, preserves the prior managed executable and optional legacy provenance under a unique immutable recovery directory, and only then atomically replaces the managed entry. Release provenance preserves the validated engine `version`, records the verified distribution as `runtimeVersion`, and enriches the candidate with `binarySha256`, `runtimeManifestSha256`, and `helperSha256`; it never trusts stale source values for those fields.

Run native qualification through `.github/workflows/private-runtime-validation.yml`. The workflow checks out exact engine, Pi and test-harness commits, restores locked dependencies through Socket Firewall, builds the static engine, and assembles the runtime with the pinned Ubuntu image. `native-ci.py` rejects WSL and non-x86_64 runners before preparing inputs. It checks every downloaded archive and `.deb` digest before use, disconnects the builder network before assembly, and records the native kernel and source commit. Run shell and Analysis contracts sequentially with their own process time limits. Finish with atomic installation and a fresh Pi test session using its default managed entry. Do not publish binaries or treat a WSL container as native qualification.
