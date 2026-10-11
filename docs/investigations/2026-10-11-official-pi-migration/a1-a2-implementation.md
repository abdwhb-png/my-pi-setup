# A1/A2 — shared boundary on pi-subagents 0.73.1

Date: October 11, 2026. The implementation and review fixes were first qualified locally. The GitHub publication and installation, subsequently authorized by the user, are described in P1–P4. The user's decisions supersede the investigation's open options: updated pi-subagents is the only remaining candidate for the next stage. The pi-core fork is retained, and merging official upstream changes belongs to a later stage.

## Changes

- **D1 — Shared owner.** `agent/extensions/_shared/subagents/index.ts` exposes the delegation contract. SDD, Brainstorm research and verification, restrictions, preflight, fallback advice, the overview, and the wait guard use this owner. Foreground/RPC transports, events, and artifact formats stay behind this boundary. Domain state stays in the consuming extensions. The overview and wait guard retain their previous configuration.
- **D2 — Canonical resolution.** In `~/engineering/pi-integrations/pi-subagents/src/agents/agents.ts`, builtin overrides are applied in the order builtin → user → project. A project that only overrides tools preserves the user's model and thinking settings. The existing resolver preserves field provenance, provider variants, scopes, and the `disableThinking` policy. For a builtin, `thinking: false` clears the field under the package's existing contract.
- **D3 — Native execution.** The package retains discovery, models, controls, child sessions, and resume behavior. No second execution registry, generic backend, or pool was added. Native JavaScript workflows and Fleet remain available. Fallback remains temporary advice to the parent, without automatic retry.
- **D4 — Verified boundary.** The import classifier rejects `pi-subagents` and its subpaths in production consumers. Native imports are allowed in the shared owner and compatibility tests. Historical SDD snapshots remain readable.

## Contract

| Code | API | Behavior |
|---|---|---|
| C1 | `run(request, options)` | Foreground execution with request/owner/node correlation, progress, text or structured results, and known usage. |
| C2 | `start(request)` | Detached agent or declarative workflow. Returns a `RunRef` bound to the identity returned by the runtime. |
| C3 | `inspect(ref)` / `wait(ref)` | Normalized observation, terminal event, or recovery from engine artifacts. An observation timeout or abort does not stop the child. |
| C4 | `control(ref, command)` | Steer, interrupt, or stop. An acknowledgment does not prove that the process terminated. |
| C5 | `resume(ref, message)` | Native resume using the persisted child contract, a new reference, and `resumedFrom`. The current model is not injected again. |
| C6 | `subscribe(listener, ref?)` | Observation on demand, session/run correlation, deduplication, and bounded replay. Consumers that only use foreground execution or status do not retain foreign async completions. |
| C7 | `preflight(request, {projectTrusted?})` / `restrict(policy)` | Public export of the configured package, resolved using the runtime's trust decision, with the native ceiling registered under the session file key when available. Brainstorm caps `allowedAgents` identities. Its read-only tool allowlist is passed separately through the tool-groups binding. |

The owning session comes from the native `ping`, using its session file when available. Control or resume with a foreign reference is rejected before the native call. Missing usage measurements remain absent. Domain controls and results do not replace native evidence that processes and leases have closed.

Workflows contain ordered stages, each consisting of parallel items with unique keys. `{outputs.key}` serializes the structured value from a previous stage. Unknown references or references without a structured value fail explicitly. A failed stage stops subsequent stages and preserves results already obtained. Brainstorm verification also preserves other verifiers' successes when a verifier fails and the advisory step never launches.

The durable reader checks the exact identifier, session, replay/receipt/archive versions, read limits, and absence of symbolic links. It recovers inline results and output references published by the engine. It reuses Pi's public parser for child sessions. It neither scans directories nor reconstructs execution state. Reads are limited to 1 MiB per file. Once native retention expires, or an artifact is missing or corrupted, observation cannot invent the lost result.

The file protocol is that of 0.73.1. The root comes from `PI_SUBAGENTS_TEMP_ROOT` or the UID scope beneath the temporary directory on the current Linux runtime. A platform without a UID requires an explicit root. Preflight resolves the physical root declared in the packages and rejects multiple distinct owners. Consumers with a context pass `ctx.isProjectTrusted()`, including session approval. Without an explicit context, the resolver reuses the persisted trust decision from the central configuration owner. Traversal filters the project scope before reading its settings, resolving its packages, or opening their metadata. Ceilings use the public global registry, shared between copies of the same package version.

## Qualification and baseline

Fixtures use the daily launcher and its promoted core `0.87.1-00c5e7e300ba-51024884e6e0`, the installed 0.73.1 package as the reference, the patched `dist-pkg` as the candidate, a deterministic fake provider, and the real MCP adapter 3.0.0 connected to a local server. Each fixture has its own HOME, agentDir, project, and run storage. No paid provider call or installation is performed during these fixture runs.

**V1 — Actual child contract.** Candidate preflight resolves the correct package. Programmatic foreground, async, direct LLM tool, and builtin workflow calls actually use the target model and `high` thinking, with the expected tools. After changing the model and thinking in temporary configuration, resume preserves the original child's settings and lineage. A new client instance also recovers completed structured results.

**V2 — Measurements.** The runner performs five warmups followed by twenty measurements per scenario and arm, alternating reference and candidate while keeping parent processes alive. The five scenarios are foreground, single async, three parallel children, dependent stage, and interrupt/resume. Measurements cover preparation, the first provider call, the completion event, PIDs, runtime, and MCP calls. RSS is sampled during provider calls; it is not a continuously measured peak. Network connection counts are not instrumented and remain `null`, never zero by default. These initial measurements were collected during local verification and remain descriptive.

The measured foreground scenario uses `read`. With this version, the tested foreground path did not make the MCP direct tool available. Async scenarios use the real MCP integration. The observed async runtime is Node, while the parent and foreground runtime is Bun. A1/A2 does not change the package's runtime choice.

The [200 measurements and qualification](./a1-a2-baseline.json) retain the roots actually loaded. They predate the review fixes below and were not repeated after those fixes. The interrupt/resume scenario was measured again after correcting the fixture to wait for an actual MCP response before interrupting. The latencies below run from the request to the completion event, in milliseconds. The p95 uses the upper rank across twenty measurements.

| Scenario | Reference p50 | Reference p95 | Candidate p50 | Candidate p95 | Child processes | MCP calls |
|---|---:|---:|---:|---:|---:|---:|
| Foreground | 104 | 147 | 102 | 170 | 0 | 0 |
| Single async | 3775 | 7808 | 3555 | 8732 | 1 | 1 |
| Parallel × 3 | 6044 | 9823 | 6135 | 8941 | 3 | 3 |
| Dependent stage | 11786 | 29773 | 11864 | 26570 | 4 | 4 |
| Interrupt/resume | 5012 | 6898 | 5280 | 6635 | 2 | 1 |

Medians are close, and workflow measurements have substantial dispersion. This baseline proves neither a performance gain nor sufficient stability for daily promotion. Process and MCP call counts are identical between the two arms for each scenario.

Reproduce from `~/.pi/agent`, with the candidate built in its own repository using `npm run build:pkg`:

```sh
PI_SUBAGENTS_CANDIDATE_ROOT="$HOME/engineering/pi-integrations/pi-subagents/dist-pkg" PI_BASELINE_OUTPUT=/tmp/pi-delegation-baseline.json bun tooling/subagents/baseline.ts
PI_SUBAGENTS_CANDIDATE_ROOT="$HOME/engineering/pi-integrations/pi-subagents/dist-pkg" PI_BASELINE_OUTPUT=/tmp/pi-delegation-qualification.json PI_BASELINE_SAMPLES=0 PI_BASELINE_WARMUPS=0 PI_BASELINE_SCENARIOS=foreground PI_BASELINE_QUALIFICATION=extended bun tooling/subagents/baseline.ts
```

## Validation limits

**V3 — Local typecheck.** The only remaining failure in the current checkout concerns `pi-mcp-adapter/unix-socket-transport.ts`, where `string | NonSharedBuffer` is passed to a Buffer API. The same diagnostic was reproduced on the untouched worktree. This managed package was not modified.

**V4 — Source package lint.** Linting the two changed files reports 301 diagnostics, identical after normalizing positions on the untouched tag and candidate. Rules are not suppressed. The patch adds no diagnostic to these files. Local lint of the shared boundary accepts parsing warnings at package boundaries.

**V5 — Lifecycle and concurrency tests.** The installed native tool-groups lifecycle test fails when reloading the ceiling, including on the untouched worktree. A `generated-tool-settings` concurrency test encountered `ELOCKED` in a grouped run, then passed in isolation and in the final grouped run. The first parallel package integration run reported 50 failures and one canceled test, with numerous startup or settlement timeouts. The job that remained active was interrupted. The complete sequential run passed with 1,107 tests passed and 7 skipped. That success does not prove stability of the default parallel command. The first three failing scenarios also passed in isolation on both the untouched tag and candidate.

## Command results

| Code | Check | Result |
|---|---|---|
| V6 | Local tests for the boundary, SDD, Brainstorm, addons, and classifier | 773 passed, 2 skipped, 0 failed, 62 files. The two disabled tests require an explicit integration flag. |
| V7 | Source package tests | Initial unit run: 3,430 passed, 13 skipped, 0 failed. After adding the provenance matrix: 130 focused tests passed, 0 failed. |
| V8 | Complete sequential native integration | 1,107 passed, 7 skipped, 0 failed, 48 suites, about twenty minutes. The initial parallel command still fails; see V5. |
| V9 | Build and diagnostics | `npm run build:pkg` and `npm run typecheck` pass in the source repository. The import boundary, focused lint, and `git diff --check` pass. Lint retains warnings. Local typecheck remains blocked by V3. |

Final suite commands from their respective roots:

```sh
# From ~/.pi/agent
bun test --isolate extensions/_shared/subagents extensions/brainstorm-forcer extensions/sdd-orchestrator extensions/pi-subagents-addons tooling/extension-boundaries/extension-boundaries.test.mjs
bun run lint:boundaries
bun run typecheck

# From ~/engineering/pi-integrations/pi-subagents
npm run typecheck
node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/unit/agent-overrides.test.ts test/unit/agent-disabled.test.ts test/unit/agent-eject-disable.test.ts test/unit/model-scope.test.ts
node --experimental-strip-types --import ./test/support/register-loader.mjs --test --test-concurrency=1 test/integration/*.test.ts
```

The complete agent test suite and complete agent lint were not rerun. Verification covers the changed consumers, their shared contracts, and the global import boundary graph. None of these fixture results constitutes validation with a real remote provider.

At the end of this initial qualification, the candidate had been neither published nor installed. Personal settings and pre-existing changes were preserved. The source patch remained on the local `codex/a1-a2-delegation` branch in pi-integrations, based on 0.73.1. Subsequent publication and installation are described below.

## Fixes after the L1–L5 review

Findings F1–F8 were fixed locally at the user's request. The initial review report remains a historical record. No further delegated review was launched.

| Code | Fix and regression coverage |
|---|---|
| F1 | Brainstorm `session_start` defers attachment so Pi can initialize the native context. A failure removes the incomplete run, retains a warning, and preserves pending domain state for retry. Attachment also inspects native artifacts to recover a completion published before subscription. Tests cover retry, durable recovery, and handler order through the real Pi SDK with a deterministic transport. |
| F2 | Persisted trust and the context's explicit decision reach preflight and the overview. Tests cover an approved project as the sole owner, an explicit veto, session approval, multiple physical owners, and deduplication of physical aliases. |
| F3 | Filtering occurs during canonical traversal before reading the ignored scope. A fixture with a FIFO `package.json` reproduced the hang before the fix and now completes without opening the FIFO. |
| F4 | Native `interrupted` and `stopped` flags are normalized. Replay hydrates missing outcomes from correlated status steps without replacing an exact child identity with another attempt at the same workflow step. Event/payload/replay parity for paused and stopped outcomes is checked with the real installed `toWaitCompletion` and `writeCompletionReplay`. |
| F5 | Brainstorm registration, lookup, and preflight use the shared native key `sessionFile ?? sessionId`. The domain UUID remains in snapshots. A persisted session whose file and UUID differ is tested against the real public ceiling registry, including verification of its release. |
| F6 | Async listeners are installed on demand. Events are retained only for observed references or while correlating a launch/resume receipt. A foreign result can no longer evict an owned terminal. Completions arriving before receipts and diagnostics remain covered. |
| F7 | Waiters for the same run share their recovery loop within an instance. Concurrent session checks share the ping in flight. Each timeout and abort remains independent, and the final departure stops polling without stopping the child. |
| F8 | The guard collects literal `import.meta.resolve` lookups. The overview's private resolver is removed. Its root comes from the shared owner with the context's trust decision. Tests cover rendering a builtin from a temporary project package and the import graph. |

**V10 — Fix validation.** The grouped run passed 806 tests, skipped 2, and failed none, with 3,354 assertions across 66 files. It includes `_shared/package-install`, the subagents boundary, Brainstorm, SDD, addons, and the classifier. After the final listener dispatch adjustment and relocation of the overview helper, the 57 affected tests passed again. The global import boundary graph and focused lint pass with warnings. Typecheck reports only V3. Protected personal files retain all 20 hashes captured for the review.

**V11 — Current qualification.** The existing runner repeated extended qualification with zero measurements and zero warmups. Its six proofs cover preflight, the direct tool, foreground, async, workflow, and resume using the real 0.73.1 candidate and daily core 0.87.1. Model, thinking, tools, lineage, and durable recovery checks pass. The [proofs and observation measurements](./a1-a2-corrections-validation.json) retain the roots loaded. No remote provider is used.

**V12 — Measured observation.** Three consumers without async interest received 384 handler calls and each replayed a foreign completion. After the fix, the same 128 events trigger no handlers in these consumers and no foreign replay. Eight concurrent waits of 1,050 ms for the same run go from 48 pings and 40 status calls to 6 pings and 5 status calls, with eight timeouts in both cases. Heap/RSS samples are retained in the artifact but do not demonstrate a stable physical memory gain. Emission time includes data generation and does not isolate handler CPU time. The recovery interval remains 250 ms, shared per run within an instance.

The complete launch baseline, the twenty-minute sequential native suite, the complete agent suite, and complete agent lint were not rerun for these fixes. Limits V3–V5 remain visible. Cleanup of PIDs not observed by the provider, noted during review, still requires failure-path qualification. No leak has been demonstrated.

## GitHub publication and installation

**P1 — Published fork.** Commit `c0ae7d70464d15eeac1944d7d5d8f2c4bcf00d5e` is published on `abdwhb-png/pi-subagents`, branch `codex/a1-a2-delegation`, with annotated tag `v0.73.1-a1a2.1`. The tag and its target were checked through the GitHub API before installation. The manifest retains upstream version `0.73.1`. The tag and SHA identify the patched fork revision.

**P2 — Pi-managed installation.** The daily CLI installed `git:github.com/abdwhb-png/pi-subagents@v0.73.1-a1a2.1`, then removed `npm:pi-subagents@0.73.1`. Dependency installation used the existing `npmCommand`, `sfw -- bun`, and four postinstall scripts remained blocked by Bun. Only one pi-subagents source is declared. `pi list`, the clone's HEAD, and the `agent/node_modules/pi-subagents` link confirm the root `~/.pi/agent/git/github.com/abdwhb-png/pi-subagents`. The daily core remains `0.87.1-00c5e7e300ba-51024884e6e0`. Only the settings' `packages` list changed, including the usual repositioning of tool-groups to the last entry. Removing the npm package removed its dependency from the managed manifest and obsolete lock entries. Version `yaml@2.9.0`, already locked beforehand, replaces `2.8.3` at the npm root. The Git CLI derives its directory from the host and repository path, without the ref. The tag therefore appears in the declaration, not in the installation directory.

**P3 — Qualified installation root.** The source repository's 62 override tests and typecheck pass again. Lint reports the same 301 diagnostics from V4. Extended qualification passes first from the source repository, then from the installed Git clone. Its six proofs cover preflight, the direct tool, foreground, async, workflow, and interrupt/resume, including model, thinking, tools, and durable recovery. The [provenance proofs and provider observations](./a1-a2-github-installation.json) retain the root and SHA. No paid remote provider is called, and no latency baseline is measured again.

**P4 — Runtime fixture adapted to the Git package.** The initial run of 808 tests reported 805 passes, two skips, and one fixture failure. That fixture loaded the private file `src/extension/index.js`, which is absent from the Git repository. It now loads the package's resolved public entrypoint through Pi's loader. Its dedicated subprocess preserves global state isolation. In that subprocess, Bun 1.3.14's `--isolate` flag caused the factory to be called before its asynchronous initialization finished. The same scenario passes without that flag, with four internal runtime tests and their 30 assertions, followed by the wrapper passing its two assertions. The other 805 tests were not rerun after this fixture change. The import boundary graph passes with warnings, and harness typecheck remains limited to V3. Protected personal files, including the pre-existing deletion of `agent/SYSTEM.md`, are preserved. An already open Pi session must be reloaded to use the new declaration.

Replacement commands executed from `~/.pi`:

```sh
pi install git:github.com/abdwhb-png/pi-subagents@v0.73.1-a1a2.1
pi remove npm:pi-subagents@0.73.1
pi list
```

Return to the npm distribution, if requested, by installing the replacement source first:

```sh
pi install npm:pi-subagents@0.73.1
pi remove git:github.com/abdwhb-png/pi-subagents@v0.73.1-a1a2.1
```
