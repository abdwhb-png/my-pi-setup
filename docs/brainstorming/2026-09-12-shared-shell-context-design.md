# Shared shell execution context and tool guidance

Date: 2026-09-12

Status: implemented locally. Deterministic validation and remaining check limitations are recorded below. Reload an open Pi session to load the changes.

> **Transport correction under user evaluation (2026-09-15):** The original
> `context` hook implementation below is superseded. Pi converted its hidden
> custom message into a user message after the latest task/tool result. Session
> `01a0a600-212a-745a-b2c3-c35fb9823bd4` contained 50 context acknowledgements
> across 96 text-bearing assistant messages. The replacement uses
> `before_provider_request` to place one block in a request-local copy of the
> system instructions. It preserves the base prompt, conversation and saved
> history. Provider adapters are shared with the existing tools catalog.
> Protocol/transition tests establish placement and freshness. The user will
> evaluate autonomous behavior in live sessions before retaining this approach.
>
> Validation for this correction: 273 tests passed, 3 existing tests skipped,
> with no failures across the focused shell, provider catalog and transition
> suites. Node/Jiti loading and the focused TypeScript check passed. The protocol
> matrix covers all ten supported API names, including OpenAI Completions used
> by the reported GLM session. Source formatting and `git diff --check` passed.
> Repository lint still reports 73 errors in untouched files, with no errors in
> this correction's files. No live LLM or real-engine qualification was run for
> this transport-only change. Reload Pi before testing; use a fresh session to
> avoid carrying earlier context acknowledgements into the behavioral trial.

> **Private-runtime scope note (2026-09-12):** This record verifies the shared
> presentation work, not the later private-runtime architecture. Its V2
> planned-policy receipt language is superseded by the approved
> [private runtime and local environments design](2026-09-12-sandbox-private-runtime-and-local-environments-design.md): only V3 context derived from a validated engine admission report proves effective mounts. Consult the [runtime guide](../../agent/extensions/sandbox/docs/runtime.md#qualification-and-activation) for its implementation, installation and separate qualification evidence.

## Destination and scope

Give `bash` and `safe_bash` the same routing, execution environment contract and contextual guidance. Preserve per-tool command rewrites and the additional command checks in `safe_bash`. Keep all new descriptions, guidelines and diagnostics in English.

D1–D4 below identify decisions in this discussion, not sandbox profiles or the decisions numbered in earlier sandbox plans. Use the validation section to distinguish implementation evidence from autonomous agent behavior.

## Verified starting point before implementation

| Finding | Source and observation |
| --- | --- |
| F1 — Shared routing already exists | [Extension registration](../../agent/extensions/bash-execution/index.ts) connects both tools to `resolveBashOperations` in [builtin-bash.ts](../../agent/extensions/bash-execution/builtin-bash.ts). `safe_bash` adds checks through the [command execution service](../../agent/extensions/_shared/command-execution/core.ts). |
| F2 — Tool presentation diverges | `bash` inherits Pi's built-in description and prompt contributions. The [Safe Bash description](../../agent/extensions/bash-execution/safe-bash/description.ts) reports `Mode=replace/coexist`, which concerns tool availability rather than sandbox/host execution. |
| F3 — Guidance is split | The execution-environment resolution guideline is registered only in [safe-bash/index.ts](../../agent/extensions/bash-execution/safe-bash/index.ts). [Sandbox registration](../../agent/extensions/sandbox/index.ts) injects policy facts separately through `before_agent_start`. |
| F4 — Some context facts are stale | The [context builder](../../agent/extensions/_shared/sandbox-runtime/execution-context.ts) reports host Unix sockets as unavailable and listeners as sandbox-only. The [backend](../../agent/extensions/sandbox/runtime/zerobox-backend.ts) already accepts configured Unix sockets and TCP publications. |

These findings describe the earlier implementation. The model-boundary tests below cover the replacement. They do not evaluate an autonomous agent's decisions.

## Selected approach

Use O1, a shared presentation contract backed by the effective execution state. Reuse the existing route rather than introducing a second sandbox selector.

```text
bash --------------------------+
                               +--> Shared route --> sandbox or explicit host
safe_bash --> command checks --+

Effective execution state --> Shared presentation contract
                               |-- Stable tool descriptions and snippets
                               |-- Common usage guidelines
                               |-- One contextual block for execution facts

bashRewrites --> Keep each rule's tool selection
```

Keep native file tools, extensions and MCP tools outside this shell boundary. Preserve the strict Think-in-Code environment and the existing explicit `!s` route. Do not infer the mode from an icon, tool name or the availability of a Zerobox runtime alone.

## Approved decisions

### D1 — Stable, accurate descriptions

Describe each tool's role and actual input/output contract. Use these opening sentences as the approved wording baseline:

- `bash`: “Execute a shell command using the current sandbox or host execution mode.”
- `safe_bash`: “Execute a shell command using the current sandbox or host execution mode, with additional command checks.”

Preserve useful information about `command`, `stdin`, timeout, stdout/stderr, truncation and full-output handling after checking the actual implementation. Keep `promptSnippet` consistent with the description and concise enough for the available-tools list.

Name `replace/coexist` as tool availability. Reserve execution mode for `sandbox/host`. Describe `default/custom/host` as derived profiles, not new selectors. Keep guard policy summaries specific to `safe_bash`; do not imply that `bash` has no other permission checks.

### D2 — Common, conditional usage guidelines

Share generic shell guidance between both tools. Use a conditional rule for commands targeting another execution environment:

> When a command targets another execution environment, resolve its executable paths and variables in that environment.

Preserve intentional caller-side values explicitly. Do not assume shared HOME or PATH across environments. Apply this rule in host mode too when a command targets another environment. Do not add product-specific instructions, automatic quoting repairs or inferred command rewrites.

Keep the additional Safe Bash guard and native-tool redirection guidance attached to `safe_bash`. Distinguish permission refusals, environment resolution failures and command failures. Do not treat every failure as proof of sandbox denial.

### D3 — One context derived from effective state

Present execution facts once for the shared shell route. Derive them from the admitted configuration and runtime state rather than copying defaults into prose.

Include the selected execution mode, derived profile and availability. Report the effective HOME/environment boundary, private or shared `/tmp`, network access, precise Unix socket openings and TCP publications when relevant. Distinguish configured permissions from observed reachability. Do not promise an executable is available merely because PATH contains its directory.

In host mode, remove claims that shell sandbox restrictions apply. If the selected sandbox is unavailable or reconfiguring, state that explicitly and retain the execution gate. Never imply or perform automatic host fallback. Do not expose secret environment values.

Keep context and tool metadata consistent after a mode selection, configuration change or reload. Preserve the original execution evidence for calls already admitted under an earlier configuration. Refresh facts in Pi's `context` hook before every model request. Prepare a changed sandbox only at the next shell admission.

### D4 — Shared execution, per-tool rewrites

Share routing, the execution environment contract and common guidance. Preserve the existing ability to select tools for each `bashRewrites` rule. Do not force identical rewrites on `bash` and `safe_bash`.

Keep the additional Safe Bash checks and the current restrictions on host-side rewriting. Do not introduce a new configuration file, a new profile, a product adapter or a merged replacement tool as part of this design.

## Alternatives considered

| Option | Disposition |
| --- | --- |
| O1 — Shared presentation contract and contextual state | Selected. Match both tools to the common route while preserving their differences. |
| O2 — Put all facts and rules in each tool description | Rejected. This duplicates state and makes descriptions bulky and easier to desynchronize. |
| O3 — Replace both tools with one configurable shell tool | Rejected for this scope. This changes the existing tool distinction without being necessary for shared routing or truthful guidance. |

## Acceptance criteria

- Verify that both tools select the same execution mode and environment under the same effective configuration, apart from explicitly configured rewrites and Safe Bash checks.
- Verify model-visible descriptions, snippets and guidelines with `bash` active alone, `safe_bash` active alone, and both active where the configured availability permits it.
- Verify transitions between sandbox and host, configuration changes, reload, and unavailable/reconfiguring states. Check the actual model request boundary for stale or contradictory information, not only helper output.
- Verify that private/shared temporary storage, configured socket access and TCP publications replace the current hardcoded claims without implying unconfigured access.
- Verify that generic environment guidance applies to another execution environment in either mode, with no tool- or product-specific adapter.
- Preserve per-tool rewrites, additional Safe Bash checks, existing permission gates and no automatic host fallback.

## Implementation

Use `_shared/shell-presentation/` for stable tool metadata, common guidelines and assembly of the ephemeral message. Keep that module free of execution authority. Let Sandbox supply execution facts through `sandbox/model-context.ts`, Bash Execution supply tool availability, and Safe Bash supply its current checks only when active.

Read and validate current sandbox configuration without preparing a backend. Report an unchanged admitted policy as ready, valid changes as pending, and invalid/unavailable state as blocked. Keep host shell facts separate from strict Think/Analysis policy. Explain that display aliases for host paths do not change shell HOME expansion.

Emit version 2 receipts from the backend's materialized policy. Preserve version 1 decoding and historical receipts. Keep HOME/PATH and policy names visible without copying other environment values. Report exact configured socket and publication grants without claiming observed reachability.

Pass common guidance through `promptGuidelines` for standard prompts and the existing catalog registry for custom prompts. Remove legacy system-prompt fact blocks. Do not persist the replacement context in session history.

Preserve global host authorization and explicit session selection. Keep project `enabled: false` and `mode: "host"` rejected. Preserve per-tool rewrites, Safe Bash controls, permissions, `!s`, strict Think execution and failure without fallback.

No dependency, configuration, migration, Zerobox binary or service change is part of this update. Load the extensions with `/reload` or a new Pi session.

## Validation evidence

| Check | Evidence |
| --- | --- |
| T1 — Presentation | Real registered tool definitions and model inputs cover each shell tool alone and both together, with standard and custom prompts. Guidelines remain generic and custom-provider contributions respect available tools. |
| T2 — Context | Public context and backend tests cover V2 HOME/PATH, private/shared temporary storage, Unix sockets, host/LAN publications, secret omission and unchanged V1 decoding. |
| T3 — Pi lifecycle | Harness sessions use Pi's real tool pipeline and simulated model. Provider-hook assertions exercise the real catalog finalizer. Session entries contain no persisted `pi.shell-context.v2` message. Node/Jiti loads both extensions. |
| T4 — Transitions | Model inputs within one request observe configuration changes as pending, then ready after shell admission. Preparation counts are `0, 0, 1`. Explicit mode changes, invalid configuration, reconfiguration, runtime error and `/reload` refresh one context without premature preparation. |
| T5 — Existing boundaries | Focused suites exercise per-tool rewrites, Safe Bash guards, permission denial, explicit host selection, `!s`, unavailable-policy blocking and execution receipts. The real installed Zerobox shebang fixture retains stderr and exit code with V2 context. |

Tests of native thrown-error results bypass only the harness's result-collection wrapper, which reformats exceptions or returns them as successful tool results in the installed harness/Pi combination. They retain the real Pi tool execution pipeline and event collector.

Final targeted regression run: **386 passed, 2 skipped, 1 failed** across 37 files.
The remaining failure, `does not claim a sandbox ran when preparation fails`,
expects provenance outcome `failed` but receives `unknown`. It also fails in a
temporary copy with the pre-change tracked implementation restored. This update
changes only the context type in that execution module and leaves its runtime
behavior intact. The two skipped tests cover native write/edit authority paths
and are already marked skipped in the repository.

The focused TypeScript check covering changed files and their imports passes.
The project-wide typecheck remains blocked by the preexisting
`runtime/websocket.integration.test.ts:109` assignment of `string | undefined`
to `string`. Repository lint reports 73 errors in five untouched files
(`config-loader.ts`, `providers.ts`, `flow-title.ts`, `pi-file-resolver.ts` and
`sandbox/capabilities/runtime.ts`), with no errors in the task's files.
Oxfmt was run on changed TypeScript files using repository settings, which
exclude tests. `git diff --check` passes.

The real Zerobox contract fixture used `~/.pi/bin/zerobox` with SHA-256
`6814f2ebc1715be50b8fedc63251dd922df625b3f5c086d7637ed658cb777df3`.
Only the shebang stderr/exit/context fixture was run against that binary. The
broader command was scoped to Bash Execution, shared command/context/provenance,
model-context transitions, runtime service/backend, and capability policy/authority
tests. The full repository test suite was not run.

These checks establish technical contracts. They do not establish that an autonomous agent will choose the correct command or diagnose every failure correctly. No live user session, browser workflow or service was replayed for this update.
