# ADR-027: Adopt official pi-subagents with request-local parent fallback advice

## Status

Accepted for local PR-branch use — published-release adoption awaits [upstream PR #2471](https://github.com/nicobailon/pi-subagents/pull/2471) and a verified release containing its fix

## Date

2026-09-24

## Context

The local `pi-subagents` fork implemented ordered `fallbackModels` in settings and agent frontmatter. Migrating to official `pi-subagents@0.71.0` restores upstream ownership of child execution and notifications, but its parser rejects that field. A failed child also cannot reliably be classified from `isError` or free-text result output. Official completed foreground results remove assistant messages before returning `tool_result`; some async workflow summaries omit model/error or child session paths.

The user requires ordered fallback advice only after a clear model/provider failure before useful work, no automatic relaunch, and no enduring addition to Pi's conversation context. The existing sandbox extension already injects request-local instructions via the shared `_shared/provider-system-prompt.ts` rewriter.

The first official `0.71.0` installation resolved a package-local `@earendil-works/pi-ai@0.80.3` while the running Pi used `0.87.1`. Its missing `getCurrentTools` export disabled dynamic tool activation and exposed `subagent` eagerly. The narrow upstream fix is [PR #2471](https://github.com/nicobailon/pi-subagents/pull/2471), built from upstream `main` with only its fix/test and changelog commits. A temporary restoration of the customized fork after the PR opened was incorrect for the user's intended interim setup; daily Pi now loads that PR branch's compiled package, without the fork's automatic fallback.

## Decision

Pending merge and publication, use the clean upstream PR branch locally: build its `dist-pkg`, install it through the daily Pi CLI (`pi install <local-dist-pkg-path>`), and remove the fork through `pi remove`. Move ordered per-agent suggestions into `agent/extensions/pi-subagents-addons/config.json`, remove upstream-rejected `fallbackModels` from settings and agent frontmatter, and enable request-local advice. Primary models stay in their original owner. After merge and publication, verify the version from the official registry/release, install it through `pi install npm:pi-subagents@<verified-version>`, then remove the local PR source through `pi remove`. Keep the advice config.

The addon observes only official child results and async completion events. It requires structured failure metadata plus a size- and path-bounded child session transcript showing assistant `stopReason: "error"` and `errorMessage`, with no previous substantive assistant output or tools. If evidence is missing, including a workflow projection without a trustworthy child session path, it stays silent. It never parses free-text errors as provider failures. Async correlation is scoped to the parent session and run/child identity, with in-memory one-shot deduplication.

Put qualifying advice in the next outgoing provider request with `before_provider_request`, using the shared rewriter. Do not add system/user/custom messages to Pi session history, change tool output, issue retries, or duplicate native notifications. The parent remains responsible for inspecting run status and deciding whether to relaunch. Advice order mirrors configuration, not enforced retry order. The addon reuses the existing extension owner; no launcher wrapper or new service layer.

## Options

- **Retain the local fork:** Its built-in automatic retries contradict the requested advice-only behavior even during the PR review; rejected for interim use.
- **Infer failure from official result text:** Smaller code, but task and provider failures share human-readable errors; can incorrectly suggest repeating work that already had effects. Rejected.
- **Read child transcript and advise in parent (chosen):** Adds bounded read-only I/O and deliberately misses unavailable or nonstandard sessions, but obtains an explicit provider error signal without changing official package internals or Pi's persisted conversation.

## Consequences and verification

- Once adopted, official `pi-subagents` owns execution; addon advice is ephemeral to the provider request. Pi session history does not include it, though provider-side logs or caches can.
- No advice when `sessionDir` places child outside the expected parent-derived path, transcript exceeds 1 MiB, child did work, child metadata is incomplete, or async completion arrives too late for the notification turn. Reload drops pending state; native completion remains authoritative.
- Existing candidates are suggestions, not a claim that providers/models are available. No automatic retry or guaranteed model ordering. Keys are syntax-validated, not checked against a static agent roster: Pi can register agents later at runtime, so a typo receives no advice.
- Focused tests exercise direct/parallel/workflow result shapes, async event correlation, request-only OpenAI Responses/Completions injection, deduplication, and clean persisted branch. The local upstream PR build is installed as the sole `pi-subagents` package source through Pi CLI; a focused harness smoke verifies its compiled root, on-demand tool activation, and tool list without an LLM. The earlier unpatched `0.71.0` install did **not** validate dynamic activation because of the stale peer. The Brainstorm runtime integration previously exercised an upstream async workflow with a deterministic provider fixture and cancellation. No live normal/bad-model scout result or real failed-child-to-parent fallback-advice end-to-end execution has yet been verified in the reloaded daily Pi session. Recheck the installed root and rerun these checks when the fixed version is published.
- See the addon README for configuration and rollback. This decision does not alter ADR-021's Brainstorm ownership of policy versus native child lifecycle, or ADR-026's immutable Pi core release boundary.
