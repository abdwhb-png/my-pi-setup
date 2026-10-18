# Live delegation E2E qualification

**Date:** 2026-10-13. **Result:** Real model calls, foreground delegation with a restricted selection, async delegation, workflows, completed-run resume, active interruption/resume, and permitted nested delegation passed. Four operational findings remain. The sandbox finding recovered on the final repeat, with its underlying cause still unresolved.

## Installation and method

The daily `~/.pi/bin/pi` wrapper was used against the promoted runtime `1.1.0-00c5e7e300ba-dirty-79f8bc0b6a58`. `pi-fork verify` passed before and after qualification. The configured source is `git:github.com/abdwhb-png/pi-subagents@v0.77.0+fork.2`, its managed clone is `~/.pi/agent/git/github.com/abdwhb-png/pi-subagents`, and both the clone HEAD and the harness import resolve to commit `b4657e7ed8e37959888a22dbcad3dfde48a07fba`. The starting harness commit was `4e75550dfd870c988bc5a18f5becc7c3d2a74bbf`.

Print/JSON and RPC sessions used a private temporary workspace containing one proof file. Temporary command extensions invoked the real shared `SubagentIntegration` boundary. No fake provider or synthetic model stream was registered. A separate real parent turn invoked the native `subagent` tool through the normal tool execution pipeline. Successful model IDs in the transcripts were `cpa/ocg/go-deepseek-v4.1-flash`, `cpa/gemini-3.8-flash`, `cpa/muse-spark-1.3-contributor`, `openai-codex/gpt-6-sol`, and `openai-codex/gpt-6.1-sol`.

Most delegation probes applied a temporary read-only capability ceiling. Full configured foreground and async selections were checked separately. The exact ceiling is a test safety boundary, not a replacement for personal tool groups or agent definitions. No personal model, thinking, tool, permission, or agent configuration was edited.

The initial execution environment did not export Exa and Firecrawl credentials. Subsequent affected checks loaded the existing `~/.pi/agent/.env` through Bun's `--env-file`, without printing its contents. Command-only probes also needed a real parent warm turn before inspecting MCP tools: connections start in the background, and a premature snapshot was empty. Those probe setup conditions were corrected before the final nested result was assessed.

## Results

Durable, sanitized measurements are in [results.json](./results.json). Private commands, session files, transcripts, and raw diagnostics remain in `/tmp/pi-live-e2e-20261013-omewkf4d/`.

| Check | Observed outcome | Scope |
| --- | --- | --- |
| T1 — Default parent and real `read` | Passed, proof returned | Configured CPA parent; one actual file read |
| T2 — Native preflight | Passed, concrete selectors | `scout`, configured model, no unresolved aliases |
| T3 — Foreground `scout` | Passed, 12.5 s | Read-only ceiling |
| T4 — Foreground `architect` | Passed, 19.7 s | Read-only ceiling; configured Codex model |
| T5 — Async `worker` and wait | Passed, 64.2 s | Read-only ceiling; ambient child extensions retained |
| T6 — Async `scout` with its full selection | Passed, 75.9 s | Current agent configuration and ambient child extensions |
| T7 — Two-stage workflow | Passed, 81.4 s | Structured proof passed to the dependent stage |
| T8 — Resume a completed `scout` run | Passed, 77.9 s for both attempts | Same persisted context and read-only ceiling |
| T9 — Interrupt and resume an active `architect` | Passed, 43.6 s | Actual read observed before interruption; paused state observed before resume; ambient extensions denied |
| T10 — Nested `code-reviewer → qa-tester` | Passed, 25.4 s | Existing `allowedAgents` permission preserved; read-only ceiling |
| T11 — Forbidden `code-reviewer → scout` | Correctly rejected | Transcript contains an actual rejected `subagent` call; no proof returned |
| T12 — Configured `oracle` | Failed before model execution | E1 |
| T13 — Foreground `scout` with its full selection | Failed through both native and shared paths | E2 |
| T14 — Real `safe_bash` | Initial preparation timeout; final repeat passed | E3; final execution was sandboxed by Zerobox |
| T15 — MCP connection/discovery | Five servers connected, one failed | E4; existing dotenv channel loaded |

T10 was verified beyond the outer assistant response. Its transcript contains `subagent(agent="qa-tester", async=false)`, a successful tool result with the proof, and a nested `qa-tester` transcript using the configured CPA Muse model and calling `read` on the temporary proof file. T9 returned a new run identity with `resumedFrom` pointing to the interrupted run and completed with the persisted proof.

## Findings

### E1 — Invalid oracle model override

`agent/settings.json` sets `subagents.agentOverrides.oracle.model` to `openai-codex/gtp-6-sol`. That ID is absent from the active registry. A real launch failed explicitly with `Unknown subagent model 'openai-codex/gtp-6-sol'`, and the diagnostic listed `openai-codex/gpt-6-sol` among the closest registered models. The configured architect's actual calls established that the latter ID works in this environment. No automatic model substitution occurred.

**Owner:** Personal model configuration. **Impact:** `oracle` cannot launch with the current override.

### E2 — Full scout selection cannot start as a foreground child

The resolved scout selection contains extension tools such as `ast_grep_search`, `lsp_navigation`, `lens_diagnostics`, and `write_report`. A foreground child does not load its parent's ambient extensions, and no provider binding for those selected tools was supplied. The real native `subagent` call and a shared foreground launch both rejected the selection before a model call. Restricting the selection to read tools passed. An async launch retaining the full current selection also passed.

Alias expansion produced concrete names. The failure occurs when the foreground child checks whether the selected tools have actually been registered. The native diagnostic identifies `subagentOnlyExtensions`, `extensions`, or path-like tool entries as existing provider-loading mechanisms. The relevant foreground rule in `src/runs/shared/child-tool-plan.ts` is unchanged between the frozen review baseline `7fcc8a42c93ededa7e299a9a6100122d84a51f7b` and the installed corrective release. This does not establish how the earlier 0.73.1 installation behaved.

**Owner:** Agent selection/provider binding at the native foreground boundary. **Impact:** The full configured scout selection is currently unusable in foreground mode.

### E3 — Intermittent sandbox startup/preparation timeout

Fresh sessions reported `Sandbox initialization failed: timeout:30`. A real `safe_bash` invocation of `printf LIVE_SHELL_OK` then failed before process execution: provenance reported `phase=policy`, `outcome=blocked`, and preparation took approximately 30,093 ms. The sandbox runtime also reported `state=error` in sessions that loaded the existing dotenv file.

The final separate shell repeat succeeded with `status=sandboxed`, `backend=zerobox`, `profile=bash-general`, exit code 0, and the expected stdout. Preparation took approximately 9 ms and execution 2,089 ms. A read-only distribution inspection took 21.9 s, and the final isolated native backend verification passed in 3.5 s. These observations establish a recovered symptom, not a proven root cause or durable fix. Returned backend capability flags do not independently qualify every security invariant. Some observed cold starts took approximately 90–117 s before the first user message reached the model. The no-MCP comparison also took approximately 72 s to start, so these samples do not isolate MCP as the cause.

**Owner:** Sandbox startup/runtime preparation, separate from the delegation selection implementation. **Impact:** Shell execution can be unavailable during an affected startup. **Follow-up:** [Instrumented diagnosis](./verified-causes.md) reproduced the failure during full analysis-bundle verification, before any Zerobox process started. Both startup and a subsequent real `safe_bash` replacement attempt exhausted the fixed 30-second budget. The lower-level reason for filesystem latency variation remains unresolved.

### E4 — Vision MCP initialization returns HTTP 404

`pi mcp list --json`, with the existing dotenv file loaded, connected `context7`, `deepwiki`, `exa`, `firecrawl`, and `youtube-transcript`. `vision-mcp-server` still failed with `MCP HTTP request failed with status 404: 404 page not found`; the CLI exited 1. Exa and Firecrawl failures from the initial credential-free test context disappeared after loading that file. The vision endpoint or remote service was not repaired or reconfigured.

**Owner:** Vision MCP endpoint/service integration. **Impact:** Vision MCP is unavailable in the tested configuration.

## Boundaries and remaining uncertainty

- B1 — Two ambient CPA interruption probes did not reach a real tool call within the test window, and one persisted a 120-second timeout. Active interruption/resume is qualified for the configured Codex model with ambient extensions denied. A 7-second interruption before a child had started acknowledged the interrupt but could not immediately resume; it is not evidence that active recovery is generally broken.
- B2 — A successful MCP connection/discovery check does not qualify every tool invocation, every resource, or every OAuth lifecycle. No external MCP write action was executed.
- B3 — The configured reviewer allows `qa-tester`, not `scout`. The forbidden-target probe was a successful enforcement check. Before a real parent warm turn, an empty MCP snapshot also blocked command-only nested probes. Neither condition is a new repository defect.
- B4 — CLI exit code 0 was not treated as proof of success. Native result statuses, `tool_execution_end.isError`, persisted lifecycle states, and actual nested transcripts determined the outcomes.
- B5 — Production code was unchanged, so project-wide unit/integration suites, lint, and typecheck were not rerun. The previous corrective-release validation remains separate from this live qualification.

All 38 files snapshotted before testing remained byte-identical. Installation provenance and the promoted Pi core release remained unchanged. Temporary runtime visibility, capability restrictions, and model-provider state belonged to the test processes. Only this investigation report and its sanitized results were added to the tracked repository surface.
