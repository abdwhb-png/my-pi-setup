<!-- markdownlint-disable MD013 MD024 MD029 MD031 MD032 MD040 -->

# SDD QA and Browser Validation Agents Implementation Plan

> **For implementers:** Follow RED -> GREEN -> REFACTOR vertically. Do not repair `agent-browser`, alter its global installation, or modify unrelated dirty files.

**Goal:** Add explicit, bounded QA and Chrome-first browser validation to deterministic SDD without changing existing profile behavior for plans that declare no validation.

**Architecture:** Extend the strict SDD-plan metadata with typed optional QA commands and browser scenarios. Persist their manifest representation and execution state. `qa-tester` runs declared checks per task after normal SDD validation; `browser-tester` executes all declared scenarios once as a manifest-level final wave. Both return strict JSON, and either failure pauses the run for human input.

**Constraints:** Use only `pi-subagents/delegation`; no package fork; no automatic fixer for testing failures; fresh children only; no intercom; no write tools; AXI first; `agent-browser` fallback only on tool/transport unavailability; no dev/build command; preserve the existing SDD profile budgets for plans with no QA/browser metadata.

---

### Task 1: Add the validation domain contract and strict plan parser

~~~sdd-task
{"id":"task-1","dependsOn":[],"files":["agent/extensions/sdd-orchestrator/types.ts","agent/extensions/sdd-orchestrator/plan-parser.ts","agent/extensions/sdd-orchestrator/plan-parser.test.ts"],"verify":[{"id":"parser-tests","command":"cd ~/.pi/agent && bun test extensions/sdd-orchestrator/plan-parser.test.ts"}]}
~~~

- [ ] RED: Add parser tests that accept absent validation metadata, exact QA command arrays, and browser scenarios; reject duplicate IDs, empty steps/expected values, and unknown fields.
- [ ] GREEN: Add `QaCommand`, `BrowserScenario`, and optional `qa`/`browser` fields to `ParsedTask`; extend TypeBox metadata validation without weakening current path confinement or task validation.
- [ ] REFACTOR: Keep canonicalisation and error messages task-specific; rerun parser tests.

### Task 2: Persist validation declarations and expose their launch preview

~~~sdd-task
{"id":"task-2","dependsOn":["task-1"],"files":["agent/extensions/sdd-orchestrator/manifest.ts","agent/extensions/sdd-orchestrator/manifest.test.ts","agent/extensions/sdd-orchestrator/review-ui.ts","agent/extensions/sdd-orchestrator/review-ui.test.ts"],"verify":[{"id":"manifest-tests","command":"cd ~/.pi/agent && bun test extensions/sdd-orchestrator/manifest.test.ts extensions/sdd-orchestrator/review-ui.test.ts"}]}
~~~

- [ ] RED: Assert that a no-validation plan retains today’s launch preview, each opted-in task adds exactly one QA launch, and any browser scenarios add exactly one manifest-level browser launch.
- [ ] GREEN: Carry QA/browser declarations into draft and approved manifests; calculate visible validation launches separately from worker/reviewer profile budgets; show task QA and aggregate browser counts in the review overlay/controller.
- [ ] REFACTOR: Freeze and digest validation declarations with the approved manifest so restart cannot change them.

### Task 3: Create bounded tester agent contracts and settings overrides

~~~sdd-task
{"id":"task-3","dependsOn":["task-1"],"files":["agent/agents/qa-tester.md","agent/agents/browser-tester.md","agent/settings.json","agent/extensions/sdd-orchestrator/prompts.test.ts"],"verify":[{"id":"agent-contract-tests","command":"cd ~/.pi/agent && bun test extensions/sdd-orchestrator/prompts.test.ts"},{"id":"settings-json","command":"cd ~/.pi/agent && bun -e \"JSON.parse(require('node:fs').readFileSync('settings.json','utf8'))\""}]}
~~~

- [ ] RED: Add frontmatter/contract tests for `qa-tester` and `browser-tester`: fresh, medium reasoning, project context, explicit read-only acceptance, no `contact_supervisor`, no edit/write capability, and exact skills.
- [ ] GREEN: Create both agents. `qa-tester` may use `@inspect`, `@lens-inspect`, and `safe_bash` only. `browser-tester` may use `@inspect` and `safe_bash` only, declares `skills: chrome-devtools-axi, agent-browser`, and requires AXI-first, named-session isolation, fresh snapshots, evidence, cleanup, and honest fallback failure reporting.
- [ ] GREEN: Add only minimal model/fallback overrides if existing settings conventions require them; otherwise inherit the configured subagent default. Do not alter existing agent overrides.
- [ ] REFACTOR: Keep agent output contracts aligned with the schemas introduced in Task 4.

### Task 4: Add typed QA and browser-result schemas plus delegation request builders

~~~sdd-task
{"id":"task-4","dependsOn":["task-1","task-3"],"files":["agent/extensions/sdd-orchestrator/prompts.ts","agent/extensions/sdd-orchestrator/prompts.test.ts","agent/extensions/sdd-orchestrator/schemas.ts"],"verify":[{"id":"prompt-tests","command":"cd ~/.pi/agent && bun test extensions/sdd-orchestrator/prompts.test.ts"}]}
~~~

- [ ] RED: Add strict parsing tests for `QaResult` and aggregated `BrowserResult`, including schema rejection for prose/fences, mismatched task/scenario IDs, empty evidence, and unrecognised fallback reasons.
- [ ] GREEN: Implement TypeBox schemas and builders for a per-task QA request and one aggregate browser request. Pass only approved commands/scenarios, immutable task/run identifiers, a safe artefact directory, and the unique AXI session name.
- [ ] GREEN: Encode fallback eligibility as AXI CLI/bridge/browser connection unavailability only; application assertions, console errors, network errors, and expected-result mismatches must parse as test failures.
- [ ] REFACTOR: Reuse the existing structured-output repair boundary only if its retry is counted against the declared validation launch capacity.

### Task 5: Extend the durable state machine and store for validation stages

~~~sdd-task
{"id":"task-5","dependsOn":["task-2","task-4"],"files":["agent/extensions/sdd-orchestrator/state-machine.ts","agent/extensions/sdd-orchestrator/state-machine.test.ts","agent/extensions/sdd-orchestrator/store.ts","agent/extensions/sdd-orchestrator/store.test.ts"],"verify":[{"id":"state-tests","command":"cd ~/.pi/agent && bun test extensions/sdd-orchestrator/state-machine.test.ts extensions/sdd-orchestrator/store.test.ts"}]}
~~~

- [ ] RED: Specify legal transitions for task QA after worker/review or Direct evidence, and a separate run-level browser-validation record. Assert failed/blocked QA and browser results become durable `needs_input`, cancellation is persisted, and a restart with an active request remains uncertain rather than relaunching.
- [ ] GREEN: Add the minimal task/run states, planned-delegation stages, terminal result records, and reducer events required to represent QA and browser validation idempotently.
- [ ] REFACTOR: Preserve all existing serialized snapshots and legacy run handling; add migration/compatibility tests where needed.

### Task 6: Run QA conditionally after task validation

~~~sdd-task
{"id":"task-6","dependsOn":["task-4","task-5"],"files":["agent/extensions/sdd-orchestrator/config.ts","agent/extensions/sdd-orchestrator/config.test.ts","agent/extensions/sdd-orchestrator/workflow.ts","agent/extensions/sdd-orchestrator/workflow.test.ts","agent/extensions/sdd-orchestrator/sdd-orchestrator.integration.test.ts"],"verify":[{"id":"workflow-tests","command":"cd ~/.pi/agent && bun test extensions/sdd-orchestrator/config.test.ts extensions/sdd-orchestrator/workflow.test.ts extensions/sdd-orchestrator/sdd-orchestrator.integration.test.ts"}]}
~~~

- [ ] RED: Add integration tests showing no QA delegation without `qa`, exactly one `qa-tester` delegation with it, and `fail`/`blocked` results pausing the right task and run without a correction worker.
- [ ] GREEN: Add configurable QA/browser agent names and timeouts; invoke QA only after the normal profile work succeeds, including `sdd_direct_complete` evidence.
- [ ] GREEN: Persist request then response before applying it; route cancellation and recovery through the existing foreground-delegation logic.
- [ ] REFACTOR: Keep current worker/reviewer launch counts unchanged for legacy plans.

### Task 7: Execute one final Chrome-first browser validation wave

~~~sdd-task
{"id":"task-7","dependsOn":["task-6"],"files":["agent/extensions/sdd-orchestrator/workflow.ts","agent/extensions/sdd-orchestrator/workflow.test.ts","agent/extensions/sdd-orchestrator/sdd-orchestrator.integration.test.ts","agent/extensions/sdd-orchestrator/extension-tools.ts","agent/extensions/sdd-orchestrator/extension-tools.test.ts"],"verify":[{"id":"browser-workflow-tests","command":"cd ~/.pi/agent && bun test extensions/sdd-orchestrator/workflow.test.ts extensions/sdd-orchestrator/sdd-orchestrator.integration.test.ts extensions/sdd-orchestrator/extension-tools.test.ts"}]}
~~~

- [ ] RED: Test that browser validation is skipped when no scenarios exist, runs once after every task is verified, aggregates scenarios from several tasks, and moves only the run to `needs_input` on `fail` or `blocked`.
- [ ] GREEN: Add the final browser delegation, durable response/result application, cancellation, status/result projection, and artefact references. Do not run it before task QA and final integration review requirements are satisfied.
- [ ] GREEN: Ensure launch accounting includes this one explicit validation child and that no browser failure auto-selects a task or launches a writer.
- [ ] REFACTOR: Keep run-level integration review and browser validation distinct in stored status and user-facing labels.

### Task 8: Add real AXI smoke coverage and fallback-health evidence

~~~sdd-task
{"id":"task-8","dependsOn":["task-7"],"files":["agent/extensions/sdd-orchestrator/pi-runtime.integration.test.ts","agent/extensions/sdd-orchestrator/browser-validation.e2e.test.ts","agent/extensions/sdd-orchestrator/README.md","docs/plans/2026-07-22-sdd-validation-agents-design.md"],"verify":[{"id":"targeted-tests","command":"cd ~/.pi/agent && bun test extensions/sdd-orchestrator/pi-runtime.integration.test.ts extensions/sdd-orchestrator/browser-validation.e2e.test.ts"},{"id":"sdd-suite","command":"cd ~/.pi/agent && bun test --isolate extensions/sdd-orchestrator"}]}
~~~

- [ ] RED: Add a temporary-fixture E2E test that fails until AXI receives an isolated session and returns persisted browser evidence; add a fallback-health test that captures the current `agent-browser` permission failure as `blocked` rather than a pass.
- [ ] GREEN: Drive a tiny local fixture through Pi CLI and `browser-tester`, assert AXI success, no fallback attempt, a fresh post-action snapshot, and final run `completed`.
- [ ] GREEN: Record a documented manual preflight for the environment-specific fallback. Do not chmod, reinstall, or otherwise mutate `agent-browser`.
- [ ] REFACTOR: Document exact activation, manifest syntax, result interpretation, and the distinction between functional test failure and fallback unavailability.

### Task 9: Final verification and compatibility review

~~~sdd-task
{"id":"task-9","dependsOn":["task-8"],"files":["agent/extensions/sdd-orchestrator/migration.test.ts","agent/extensions/sdd-orchestrator/prompts.test.ts","agent/extensions/sdd-orchestrator/sdd-orchestrator.test.ts","docs/superpowers/plans/2026-07-22-sdd-validation-agents-implementation.md"],"verify":[{"id":"sdd-suite","command":"cd ~/.pi/agent && bun test --isolate extensions/sdd-orchestrator"},{"id":"typecheck","command":"cd ~/.pi/agent && bun run typecheck"},{"id":"lint","command":"cd ~/.pi/agent && bun run lint"},{"id":"format","command":"cd ~/.pi/agent && bun run fmt:check"},{"id":"parse","command":"cd ~/.pi/agent && bun run check:parse"}]}
~~~

- [ ] Verify legacy metadata and plans compile exactly as before and produce no validation delegations.
- [ ] Verify agent allowlists resolve through the Pi wrapper/tool-groups path; do not run children through the bare Pi binary.
- [ ] Run the focused SDD suite, then project gates. Attribute unrelated pre-existing failures separately and do not mask them.
- [ ] Inspect `git status --short` for only expected files and no generated browser profiles, screenshots outside SDD artefacts, package-lock changes, or modifications to the existing unrelated permission-system config.

