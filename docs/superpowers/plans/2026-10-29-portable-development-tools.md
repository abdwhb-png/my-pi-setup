# Portable development tools implementation plan

Goal: reuse explicitly authorized host installations with persistent Pi-owned caches and reproduce their configuration on another Linux x86_64 or WSL2 machine.

Use the existing installation, filesystem and environment contracts. Make private cache paths defaults, preserve protected runtime variables, and keep the closed baseline unchanged. Supply a versioned development fragment and deterministic preview/apply/check setup with optional machine-local installation bindings. Generate local identity, preserve unrelated state, validate canonical paths and publish atomically with backup and concurrency protection. Configure existing tools only; installation of missing host tools remains separate.

Validate cache precedence and denial using real production policy builders. Test setup with two home directories and installation layouts, idempotence, missing resources, invalid declarations, escaping symlinks, foreign identity and failed publication. Exercise persistent caches and read-only host resources through the pinned real engine. Run registered CLI tests, existing installation editor regressions, boundary checks, lint and typecheck. Qualify representative tool commands and report network or supply-chain coverage separately from tool availability. Do not claim another physical machine was tested from temporary-home fixtures alone.

Work in the existing checkout, preserve unrelated edits, add no dependencies or new engine protocol, and keep repository artifacts in English. Runtime and diagnostic failures must remain visible; no host fallback or automatic authorization expansion.
