# Frozen daily Pi packages

These archives are the immutable inputs already referenced by `agent/package.json` and `agent/bun.lock`, copied from the promoted daily release `1.1.0-00c5e7e300ba-dirty-79f8bc0b6a58`. Native sandbox CI must test the same Pi APIs as the installed harness. Rebuilding the older commit recorded before source finalization omits the Pi 1.1.0 workspaces and cannot reproduce this release.

The original release manifest preserves each archive's SHA-256 and build-source metadata. The finalized source commit is `26eb6a028cf93787d2f00e8181c6c2f06fb0bbc6`; its integration evidence is recorded in `docs/investigations/2026-10-11-official-pi-migration/source-finalization.md`.

This fixture exists because the native CI runner cannot access the local runtime store. It contains generated distribution artifacts, not another maintained implementation. Do not edit or rebuild individual archives. When the daily Pi release changes, replace the complete fixture from that promoted release and update its manifest together with the dependency and lockfile references. The restore script checks the manifest before copying; the frozen package-manager install checks the lockfile without rewriting integrity values. The test harness is restored from its existing registry pin in the same lockfile.
