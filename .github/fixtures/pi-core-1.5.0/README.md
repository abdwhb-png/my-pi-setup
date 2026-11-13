# Frozen daily Pi packages

These immutable archives are copied from the promoted Pi release `1.5.0-7722134adab8-dirty-8a8959609011`. They match the exact archive names and hashes referenced by `agent/package.json` and `agent/bun.lock`. Native sandbox CI must exercise the same Pi APIs as the installed harness.

The original release manifest preserves each archive's SHA-256 and source metadata for commit `7722134adab83cbf5d491db7142f10644d23a011`. The manifest records an existing dirty source snapshot. Its producer metadata is preserved verbatim because it participates in the immutable release identity; its repository path is provenance, not a runtime filesystem grant. These archives were copied from the already installed release without rebuilding or modifying the core fork. The fixture contains generated distribution artifacts because disposable CI hosts cannot read the local runtime store. It does not maintain another implementation of Pi.

Do not edit or rebuild individual archives. When the pinned Pi release changes, replace the complete fixture from that release and update its manifest, CI paths, dependency references and lockfile together. The restore script verifies the manifest before copying; the frozen package-manager install verifies the lockfile without rewriting integrity values. The test harness uses its independent registry pin.
