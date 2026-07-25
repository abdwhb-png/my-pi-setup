# ADR-006: BOM-resilient skill discovery

## Status

Accepted

## Date

2026-07-25

## Context

Pi core skill discovery requires frontmatter to start with `---`. A UTF-8
byte-order mark (BOM) before the delimiter makes a valid `SKILL.md` invisible:
it is absent from the model catalog, `/skill:name`, `search_skill`, and
`load_skill`. Direct file reads still work, which makes the fault difficult to
diagnose.

Global package files must not be patched because upgrades overwrite them and Pi
customizations belong in this repository's extension layer.

## Decision

`agent/extensions/pi-overrides/` provides an in-memory compatibility layer for
BOM-prefixed skills.

- Scan standard global and trusted project skill roots.
- Normalize only a leading BOM in memory; never rewrite a source skill automatically.
- Preserve Pi core ownership when a valid core skill uses the same name.
- Make rescued skills discoverable to models, `/skill:name`, `search_skill`,
  and `load_skill`.
- Warn interactively and expose `/validate-skills` for path-specific diagnostics.
- Do not scan project skill directories until Pi reports the project trusted.

## Consequences

Malformed source files remain visible and actionable while users keep working.
Source skills should still be resaved as UTF-8 without BOM.

This layer covers standard global/project skill roots only. Package-, settings-,
and CLI-supplied custom paths remain core-owned because Pi does not expose a
reliable public discovery API for their unresolved paths.
