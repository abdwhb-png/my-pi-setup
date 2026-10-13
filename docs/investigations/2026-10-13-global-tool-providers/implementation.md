# Global tool providers for native subagents

## Scope and implementation

O3 supplies global tool-provider extensions automatically when a native child selects their tools. It requires no per-agent extension lists, provider map, settings rewrite, new runner, or dependency upgrade. Project-local providers and unrelated extension hooks are outside this version's scope.

The addon reads the bound `pi.getAllTools()` registry when the fork captures a fresh root launch. It groups user-scoped tools by canonical source file, excludes synthetic sources and the resolved `pi-subagents` package root, and registers the result through the existing `requiredExtensions` API. IDs are SHA-256 hashes of canonical paths. A normal reload makes newly loaded providers available. Registration uses the Pi UUID and is disposed on session replacement or shutdown.

The fork adds optional `whenTools` conditions and a synchronous callback form to the existing registration contract. It selects providers after tool exclusions and capability ceilings. Explicit `extensions`, `subagentOnlyExtensions`, and path-like tool selections remain authoritative. Denying extensions removes conditional providers. Unconditional requirements keep their previous behavior. Loading a provider does not grant its other tools.

The full catalogue remains in child runtime configuration, detached runner configuration, recovery descriptors, and retained workflow admission. The child loader receives only selected providers. This preserves providers for descendants even if an intermediate child does not use them. The existing launch digest already covers the selected paths. External-runner admission and MCP selection retain their existing rules.

Shared preflight now passes the actual session UUID and the session file separately. Native preflight captures the callback once so admission and tool planning cannot observe different catalogues. Restrictions, ownership checks, and run references continue using the existing file-based key when a session file exists.

## Changed surfaces

- **F1 — Fork:** `src/shared/required-child-extensions.ts`, `src/runs/shared/child-tool-plan.ts`, `src/runs/shared/child-launch.ts`, the workflow admission condition in `src/runs/foreground/subagent-executor.ts`, and one snapshot capture shared by admission and selection in `src/api/preflight.ts`. Public API documentation and focused tests accompany these five production files.
- **F2 — Addon:** `agent/extensions/pi-subagents-addons/tool-providers.ts` and registration in its existing `index.ts`. Tests cover provenance, canonical grouping, reload, disposal, native tool enforcement, and file preservation.
- **F3 — Common boundary:** Public required-extension exports in `agent/extensions/_shared/subagents/` and corrected preflight identity. Alias expansion in `tool-selection.ts` is unchanged.

## Candidate provenance

The isolated worktrees are `~/engineering/pi-integrations/.worktrees/pi-subagents-global-providers` and `~/engineering/pi-integrations/.worktrees/pi-harness-global-providers`, both on `feat/global-tool-providers`. Their starting commits are `b4657e7ed8e37959888a22dbcad3dfde48a07fba` and `22df6f06158006bda39a05b348e61adc64e6a4c2` respectively. Dependencies were reused locally without installation or manifest changes. Future activation must include both the fork and addon changes because the currently installed fork does not support callback registration. Candidate harness imports resolve to the candidate fork, while the daily installed Git clone remains untouched.

## Verification

### Deterministic regressions

RED evidence was observed for conditional entries being rejected by the previous contract, callback registration, full-catalogue inheritance and retention, UUID-based preflight, addon provider discovery through the actual Pi resource loader, and both synchronous and asynchronous workflow retention after registration disposal.

Focused fork checks cover static compatibility, malformed and asynchronous callback results, bounded concrete tool names, empty selections, explicit providers, exclusions, ceilings, detached and nested propagation, recovery decoding, and workflow append storage. The SDK composition test imports the real addon and fork, executes an allowed tool, observes Pi reject another tool from that provider, tests canonical/symlink deduplication, and performs a real reload to discover a new provider without changing an earlier snapshot.

### Live qualification

Private evidence is retained under `/tmp/pi-global-providers-live-a4rrv36n/`. The candidate was loaded by the daily promoted Pi 1.1.0 runtime using an isolated agent directory and workspace. The resolved package root was checked before delegation. The scout model and tool selection came from the current settings, including `cpa/gemini-3.8-flash`, `@inspect`, `@lens`, and `write_report`.

Both foreground and asynchronous scout runs completed. Their actual transcripts contain successful `module_report` and `write_report` calls, and their reports exist under the temporary workspace's scoped report roots. A second lifecycle run exercised `module_report` in the parent before delegation, after the foreground child, and after the asynchronous child. All three parent calls succeeded.

Two setup findings remain in the evidence: the minimal initial fixture lacked the CPA provider extension, and `ast_grep_outline` was registered but inactive in the parent. The completed qualification loads the existing CPA extension in its isolated configuration and uses the active `module_report` tool. These were probe setup corrections, not production changes. No per-agent provider list was introduced.

The SHA-256 checks for the daily `agent/settings.json` and `agent/config/tool-groups.json` matched before and after qualification. No daily runtime activation, package installation, publication, merge, or push was performed.

### Repository checks

Final command results and baseline comparisons are recorded in `validation.json`. Raw test and diagnostic logs are retained under `/tmp/pi-global-providers-validation/`. Initial unrestricted parallel full-suite attempts overloaded the host and were stopped. Their partial failures are not used as correctness evidence. Subsequent runs use explicit Node test concurrency before the test paths.

The fork's existing lint rules also flag its existing boundary validators. The added `typeof` checks have narrow documented suppressions at the array-or-callback API and external name-validation boundaries. No lint configuration, classifier, or ownership check was weakened.

## Final result

The focused harness suite passed all 26 tests. The final fork preflight/conditional suite passed all 41 tests, the contract/recovery suite passed all 43, and the workflow retention probe passed all three scenarios. Fork typechecking passed. The extension ownership scan passed. Focused lint introduced no diagnostics in either repository.

The full fork unit run recorded 4,012 passes, six failures, and 16 skips. Four failures also occurred on the original fork. The other two passed isolated reruns. The full integration run recorded 1,185 passes, 18 failures, and seven skips. All 18 failing cases passed later targeted runs, including a separate isolated rerun of the last timeout case. This is not a green full-suite result, and the timing sensitivity remains a qualification limitation. The harness typecheck retains the same three sandbox test errors seen on its baseline.

Both candidate branches and worktrees are retained for review. Publication and daily activation remain separate steps.

## A1 corrective review follow-up

The targeted review found and reproduced two additional cases outside the original live scenarios: an empty catalogue rejected native remote placement, and empty catalogues were not retained through workflow admission and recovery. Both are corrected in the candidate worktree. The [corrective review](review-corrections.md) records the RED/GREEN evidence, final checks, reviewed scope, and remaining validation limits. The original results above remain historical evidence for the initial candidate.

## A2 activation follow-up

The fork and matching addon are now integrated into the daily installation. The [activation report](activation.md) records the versioned Git release, installed provenance, the alias-placeholder correction discovered with the full daily configuration, and the successful foreground/asynchronous smoke test. Earlier sections remain historical evidence for their respective qualification stages.
