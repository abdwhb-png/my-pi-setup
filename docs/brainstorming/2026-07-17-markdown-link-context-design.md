<!-- markdownlint-disable MD013 -->

# Markdown Link Context Extension

**Date:** 2026-07-17  
**Status:** Superseded by [ADR-022](../adr/ADR-022-source-aware-markdown-link-rewriting.md)

**Target:** `agent/extensions/markdown-links/`

ADR-022 replaces recursive linked-content injection with source-aware destination rewriting. This file remains historical context only.

## Context

Pi loads `AGENTS.md`/`CLAUDE.md` into `systemPromptOptions.contextFiles`. It discovers `SYSTEM.md` and `APPEND_SYSTEM.md` separately. Pi concatenates these resources into the system prompt but does not resolve Markdown links inside them. A link such as `[ABOUT-PI.md](../docs/ABOUT-PI.md)` therefore remains text and does not load the referenced file.

The extension must resolve local Markdown links without changing Pi core, fetching network resources, scanning every Markdown file in a repository, or silently weakening path security.

## Decision

Build a directory-form Pi extension that listens to `before_agent_start` and augments the current system prompt with recursively linked local Markdown files.

Use Sätteri `0.9.5` as the Markdown parser. Its JavaScript API exports `markdownToHtml` and `defineMdastPlugin`; the HTML pipeline accepts MDAST visitors that can collect `link`, `linkReference`, and `definition` nodes while respecting Markdown parsing rules. Sätteri uses precompiled Rust/N-API binaries. Bun supports N-API in general, but the extension must run a real Bun smoke test before acceptance.

No regex fallback. If Sätteri cannot load on the current runtime, Pi continues without expansion and status reports the parser error.

## Package structure

```text
agent/extensions/markdown-links/
├── index.ts
├── index.test.ts
├── package.json
└── bun.lock
```

`package.json` declares the runtime dependency directly:

```json
{
  "name": "pi-extension-markdown-links",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "pi": { "extensions": ["./index.ts"] },
  "dependencies": { "satteri": "0.9.5" }
}
```

The root `agent/package.json` must not receive this dependency.

## Lifecycle and data flow

1. `session_start` loads configuration, dynamically imports Sätteri, and resets diagnostics.
2. `before_agent_start` obtains `event.systemPromptOptions.contextFiles` and builds roots.
3. In `scope: "context"`, roots are only Pi's context files.
4. In `scope: "all"` (default), roots are all file-backed prompt roots available to the extension: context files plus discoverable `SYSTEM.md` and `APPEND_SYSTEM.md`. Skill files are not roots because Pi only exposes their metadata; it does not load their bodies into the prompt.
5. Each root is parsed with Sätteri's `markdownToHtml` pipeline using a non-mutating MDAST collector. Inline links, reference links, and definitions are collected in source order.
6. Relative targets resolve against the containing Markdown file. Fragments and query strings are removed. Only `.md` and `.markdown` targets are accepted. `http(s)`, `mailto`, empty destinations, images, and unsupported extensions are skipped.
7. Files are read recursively. `realpath` provides canonical identity for duplicate and cycle detection. Depth and UTF-8 byte budgets apply globally per turn.
8. The extension appends one section to the current `event.systemPrompt`, using `<project_instructions path="...">` blocks and preserving earlier extension changes.

Project `SYSTEM.md`/`APPEND_SYSTEM.md` paths are considered only when `ctx.isProjectTrusted()` is true, matching Pi's trust behavior. Global files use the configured agent directory. Inline CLI `--system-prompt`/`--append-system-prompt` text has no reliable source path and is not parsed for relative links.

## Configuration and security

Configuration lives under `markdownLinks` in `settings.json`:

```json
{
  "markdownLinks": {
    "scope": "all",
    "maxDepth": 10,
    "maxBytes": 500000,
    "allowedRoots": ["$cwd", "$agentDir", "$agentDir/..", "$contextDirs"]
  }
}
```

Project settings override global extension settings. Invalid settings fall back to defaults. Supported root tokens expand to current cwd, Pi agent directory, its parent, and directories containing loaded roots. Users can add explicit absolute or tilde paths.

Authorization occurs after `realpath`; a target is accepted only if its canonical path is inside an allowed root. This blocks `..` escapes and symlink escapes. External links are never fetched.

## Errors and status

A malformed setting, parser import failure, unreadable file, missing target, unsupported target, root violation, cycle, duplicate, depth overflow, or size overflow is non-fatal. The resolver records a short diagnostic and continues.

Register `/markdown-links:status`. It reports scope, limits, allowed roots, roots considered, included paths/bytes, skipped links/reasons, and parser errors. It never prints included file contents.

## Testing and verification

Follow TDD:

1. Add failing parser/resolver and extension-import tests.
2. Add Sätteri package and implement minimal passing behavior.
3. Refactor only after focused tests pass.

Tests must import the real `index.ts`. Cover:

- inline links, angle-bracket destinations, balanced parentheses;
- reference links and definitions;
- code fences, inline code, images, anchors, external URLs;
- relative resolution from each recursion level;
- recursion, cycles, duplicate realpaths, symlink escapes;
- allowed-root authorization;
- depth/byte limits and malformed settings;
- `scope: "context"` vs `scope: "all"`;
- parser import failure without breaking agent startup;
- exact system-prompt injection and status command behavior;
- Bun import smoke test for Sätteri `0.9.5`.

Required gates after implementation: focused Bun tests, full Bun test suite, LSP diagnostics on changed files, `bun run typecheck`, `bun run lint`, and `bun run fmt:check`. Do not run build/dev commands.

## Alternatives rejected

### Local parser

Avoids native dependency but requires maintaining Markdown edge-case handling. Rejected because true CommonMark/GFM link semantics are core feature requirements.

### `@path` syntax

The existing `pi-context-include` extension is useful inspiration for recursion, limits, diagnostics, and cycle handling, but a custom syntax would not make existing Markdown links work.

### Repository-wide Markdown scan

Rejected as default and not part of `scope: "all"`. It would inject unrelated documentation, increase latency, and widen the prompt-injection surface.

### Network link fetching

Rejected. It adds latency, privacy risk, availability failures, and remote prompt-injection risk.

## References

- Pi context loading: `.pi/agent/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js`
- Pi prompt construction: `.pi/agent/node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js`
- Pi extension lifecycle: `.pi/agent/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Inspiration: <https://github.com/d3ara1n/pi-extensions/tree/main/packages/pi-context-include>
- Sätteri: <https://github.com/bruits/satteri>
- Sätteri package: <https://www.npmjs.com/package/satteri>
- Bun N-API: <https://bun.sh/docs/runtime/node-api>
- Related local design: `docs/plans/2026-07-01-file-reference-resolution-design.md`
