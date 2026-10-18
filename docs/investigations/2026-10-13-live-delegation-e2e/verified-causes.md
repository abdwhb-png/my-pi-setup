# Verified causes of E1–E3

Date: 2026-10-13. Follow-up to the live qualification, requested specifically to establish causes. The installed package remains `pi-subagents@0.77.0+fork.2` at `b4657e7ed8e37959888a22dbcad3dfde48a07fba`. No production code, personal configuration, dependencies, or promoted runtime were changed for this investigation.

## E1 — The configured oracle model ID is misspelled

The source is `agent/settings.json:90`: `subagents.agentOverrides.oracle.model` is `openai-codex/gtp-6-sol`. The settings override is applied to the agent model by `src/agents/agents.ts:1543` in the installed package. Registry resolution cannot match that ID and throws the explicit unknown-model error in `src/runs/shared/model-resolution.ts:293`.

The actual oracle launch failed in 0.230 seconds with that exact ID in the error. The same live environment successfully ran the architect using `openai-codex/gpt-6-sol:xhigh`, including an actual file read. This identifies the transposed `gtp` spelling as the cause of the observed launch rejection. It does not qualify the oracle's remaining settings after a future correction.

Evidence: `foreground-oracle.json` and `foreground-architect.json` in the original private evidence directory. The configured value was reread during this follow-up.

## E2 — Selected extension tools have no provider loaded in the foreground child

The scout override at `agent/settings.json:53` selects `@inspect`, `@lens`, `write_report`, and `contact_supervisor`. The actual preflight contract contains their concrete tool names, with no unresolved alias. It also records empty `toolExtensionPaths`, `configuredExtensions`, and `requiredExtensionIds`. Its only extension argument is the package's internal prompt runtime.

The native launch code sets `ambientExtensions = input.host === "runner" && !toolPlan.disableAmbientExtensions` in `src/runs/shared/child-launch.ts:316`. The foreground host consequently receives `noExtensions: true` in `src/runs/shared/child-session.ts:459`. The Lens extension configured globally at `~/engineering/shared-services/pi-lens/dist/index.js` and the auto-discovered `agent/extensions/pi-scoped-write/index.ts` therefore do not register their tools in that child. These own the missing Lens tools and `write_report`, respectively.

Before the model request, `src/runs/shared/subagent-prompt-runtime.ts:534` compares required tool names with the tools actually registered in the child. That check rejects the missing providers' tools. The unrestricted foreground reproduction failed in 1.031 seconds with zero model input/output tokens. A foreground run restricted to native read tools succeeded in 12.479 seconds. An async child retaining the full configured selection also completed its real file read.

The cause is the missing binding between selected extension tool names and the extensions loaded in this foreground child. Alias expansion itself succeeded. A successful selection preflight is not proof that those providers have loaded. The four native files `child-tool-plan.ts`, `child-launch.ts`, `child-session.ts`, and `tool-availability.ts` are byte-identical between the frozen review baseline `7fcc8a42c93ededa7e299a9a6100122d84a51f7b` and the installed release. This comparison does not establish the behavior of the former 0.73.1 installation.

Evidence: `preflight-scout.json`, `unrestricted-foreground.json`, `foreground-scout.json`, and `unrestricted-async.json` in the original private evidence directory.

## E3 — Full analysis-bundle verification exhausts the shell startup deadline

The timeout was reproduced through the daily CLI with the existing dotenv file loaded. Temporary process-local instrumentation recorded filesystem operation counts and durations, the actual 30-second deadline, and real Zerobox process starts. It preserved the original operations, results, cancellation signals, and configured deadline. No production module or configuration file was patched, no delay was injected, and the probes ran sequentially.

The verified execution path is:

1. C1 — `agent/extensions/sandbox/index.ts:1182` gives sandbox initialization a 30-second deadline.
2. C2 — `runtime/service.ts:131` waits for the backend probe before lease recovery, lease creation, and shell policy admission.
3. C3 — `runtime/zerobox-backend.ts:537` awaits `resolvePrivateRuntime()` before invoking even `zerobox --version` or the strict sandbox engine probe.
4. C4 — `runtime/runtime-bundle.ts:284` verifies both the shell and analysis components. Each component traverses its entries serially, checking paths, permissions, and SHA-256 digests, followed by a scan for unlisted entries. The shell cannot become ready until both component verifications finish.

The installed manifest contains 211 shell entries and 4,014 analysis entries. The analysis component alone contains 4,012 regular files with 283,437,554 bytes and two symlinks. The backend memoizes its probe only on that backend instance. A new session or replacement backend starts a fresh verification.

In the instrumented RPC reproduction, the sandbox deadline fired after 30,006 ms. The analysis traversal stopped after 1,910 completed file reads. Its accumulated asynchronous durations were 13,402 ms for `readFile`, 7,449 ms for `realpath`, and 6,443 ms for `lstat`. The shell component had already finished. No Zerobox process had started. The runtime was subsequently observed in `state=error`. The maximum two-second heartbeat delay during that verification window was 20.3 ms, which excludes one long JavaScript event-loop stall as the explanation for this reproduction.

The isolated real backend probe completed successfully in 17,413 ms. Runtime resolution accounted for 16,560 ms, while the actual strict engine probe took 592 ms. Together with the failing daily-CLI trace, this locates the reproduced failure in distribution verification, before the engine and before the requested shell command. The original successful shell repeat remains evidence that the same distribution can pass, not evidence of a durable repair.

The separate print-mode reproduction failed during startup after 30,003 ms. Its actual `safe_bash` call then reached `prepareShellExecution()`, which requested a replacement backend because the current runtime was not enabled (`index.ts:1657`). That fresh verification hit its own deadline after 30,014 ms while reading the analysis component. No Zerobox process started in either attempt. The terminal tool event recorded `isError=true`, `phase=policy`, `outcome=blocked`, and 30,127 ms of preparation for `printf LIVE_SHELL_OK`.

The established cause is the dependency of shell admission on a complete analysis-bundle verification that does not finish within the fixed startup budget in the affected runs. The lower-level reason why asynchronous filesystem latency varies between runs is not established. The traces do not distinguish storage latency, filesystem worker scheduling, or other host contention. No particular cache, MCP server, credential, or kernel defect is claimed as the cause.

## Validation boundaries

The RPC probe exited normally with code 0. The print-mode probe captured both the terminal tool result and the final assistant event, then its runner exited with code 143. The cause of that subsequent SIGTERM was not investigated, and normal shutdown is not claimed for that probe. No process from these probes remained at the final inspection. All 38 protected files from the original live qualification remained byte-identical. Project-wide tests were not rerun because production code and configuration were unchanged.

The sanitized machine-readable evidence is in [verified-causes.json](./verified-causes.json). The detailed traces contain successful and failed controls, not just the error messages.

Follow-up private evidence: `/tmp/pi-e123-causes-20261013/`. Original private evidence: `/tmp/pi-live-e2e-20261013-omewkf4d/`. Raw traces are local diagnostic artifacts, not repository fixtures.
