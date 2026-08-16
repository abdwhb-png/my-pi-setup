# SDD Validation Agents: QA and Browser Testing

**Date:** 2026-07-22

**Status:** Accepted design; implementation not started

**Targets:** `agent/agents/`, `agent/extensions/sdd-orchestrator/`, `agent/settings.json`, `agent/tool-groups.json`

## Context

The deterministic SDD workflow validates code through worker acceptance and read-only specification/quality reviews. It has no dedicated runtime stage for independent automated QA or real-browser testing. Adding either as an unconditional reviewer would reintroduce the launch and latency costs that the current profile system was designed to cap.

The desired addition is therefore explicit and typed: a plan opts into QA checks per task and browser scenarios per task. The orchestrator runs only the declared checks. A browser run aggregates all approved scenarios into one final validation wave after all task-level work is verified.

`chrome-devtools-axi` is operational locally and supports named sessions, snapshots, console, network, screenshots, and performance tooling. `agent-browser` is configured as a fallback skill but is currently not operational: its bundled binary fails with an `EPERM` permission error. The implementation must report this as a blocked fallback, never pretend it ran successfully, and must not repair its installation without separate authorization.

## Goals

- Add a read-only `sdd-qa` for explicitly declared automated checks.
- Add a read-only `browser-tester` for explicitly declared user-facing scenarios.
- Use Chrome DevTools AXI first and `agent-browser` only after an AXI capability/transport failure.
- Isolate browser sessions by SDD run and preserve reproducible artefact references.
- Make QA and browser results typed, persisted, observable, and bounded by the approved manifest.
- Put a QA or browser failure in `needs_input` with evidence; never auto-launch a fixer.
- Preserve current Direct, Light, Standard, and Critical worker/review semantics when no validation is declared.

## Non-goals

- Do not make browser testing automatic merely because a task changes frontend files.
- Do not give either tester general source-editing tools, nested delegation, or supervisor intercom. Their only file mutation is the bounded `write_report` tool from `pi-scoped-write`.
- Do not start application dev servers, seed data, or access a user's existing Chrome profile implicitly.
- Do not repair or reinstall `agent-browser` as part of this change.
- Do not replace existing code-review stages or turn QA into another design/code reviewer.

## Agents

### `sdd-qa`

`sdd-qa` is a fresh, read-only, medium-reasoning execution validator. It receives the approved task contract plus only the task's declared QA commands. It may inspect source, diagnostics, and command output, but it cannot edit files, broaden the command list, launch another agent, or contact a supervisor.

Its terminal output is a schema-validated `QaResult` containing the task ID, verdict (`pass`, `fail`, or `blocked`), commands executed, evidence, and reproducible findings. Before returning that same JSON payload, it persists it as `qa-result.json` through `write_report`. It has no `write`, `edit`, or `edit_report` authority. `fail` and `blocked` both move that task and the run to `needs_input`; no correction is inferred.

The existing `verify` array remains worker acceptance evidence. New `qa` commands are independent checks that deliberately rerun only when a plan asks for independent QA.

### `browser-tester`

`browser-tester` is a fresh, read-only, medium-reasoning scenario executor. It receives all approved browser scenarios for one manifest, an orchestrator-provided artefact directory, and an isolated session name derived from the run ID. It has the explicit skills `chrome-devtools-axi` and `agent-browser`, even though its global skill inheritance remains disabled. Its shell access is limited to `safe_bash` plus read-only inspection tools.

Its only file mutation is `write_report`, used once to persist the final JSON payload as `browser-result.json` before returning the same payload to the orchestrator. It has no general `write`, `edit`, or `edit_report` authority.

For every scenario it must:

1. verify the declared base URL and preconditions;
2. use Chrome DevTools AXI first, with the supplied named session;
3. take a fresh snapshot after every state-changing action;
4. collect relevant console/network evidence and artefact references;
5. execute declared cleanup before completing whenever setup changed application state.

It may use `agent-browser` only when AXI is unavailable at the CLI, bridge, or browser-connection layer. A failed expectation, console error, HTTP failure, or application flow failure is a test failure, not a reason to repeat the scenario with another tool. If the fallback itself is unavailable, the result is `blocked` with both error records.

The agent never silently attaches to a user's existing browser/profile. A scenario can request an existing remote-debugging endpoint explicitly; otherwise the AXI session is isolated.

## Plan and manifest contract

`~~~sdd-task` metadata gains an optional `qa` field and an optional `browser` field. Existing plans remain valid and have neither validation stage.

```json
{
  "id": "task-2",
  "dependsOn": ["task-1"],
  "files": ["src/profile.tsx"],
  "verify": [{"id":"unit","command":"bun test src/profile.test.ts"}],
  "qa": [{"id":"a11y","command":"bun run test:a11y profile"}],
  "browser": [{
    "id": "save-profile",
    "baseUrl": "http://app.local",
    "preconditions": ["Demo account profile-user is available"],
    "steps": ["Open Profile", "Change display name", "Save", "Reload"],
    "expected": ["A success message is shown", "The saved name persists after reload"],
    "cleanup": ["Restore the original display name"]
  }]
}
```

The parser validates unique IDs, non-empty arrays, bounded text fields, and one-to-one scenario ownership. Browser scenarios remain associated with their task for reporting, but the manifest aggregates all of them into a single final browser delegation.

The manifest records a distinct validation-launch preview: one QA launch per opted-in task and zero or one browser launch per manifest. These launches are visible in approval and status; they are not hidden inside profile budgets. A schema-repair retry, if retained for validation outputs, consumes the corresponding declared validation launch capacity.

## Execution model

```text
task worker/reviews
  -> sdd-qa only when that task declares qa
  -> task verified

all tasks verified
  -> browser-tester once when at least one scenario is declared
  -> run completed
```

Task QA is executed after existing worker/review requirements pass. It also applies after explicit Direct-task evidence. A QA failure records its terminal response and moves the task/run to `needs_input` with reason `qa_failed` or `qa_blocked`.

Browser validation is run-level state, analogous to but distinct from the existing final integration review. A browser failure leaves previously verified tasks unchanged, records the scenario evidence on the run, and moves the run to `needs_input` with `browser_validation_failed` or `browser_validation_blocked`. The user decides the next action; the machine does not infer which task or code change should fix an E2E failure.

Cancellation, idempotency, restart recovery, and active-request ownership follow the existing foreground-delegation rules. An uncertain QA or browser request never relaunches automatically after restart.

## Testing strategy

- Parser compatibility and rejection tests for all new metadata fields.
- Pure manifest tests for aggregation, launch preview, and unchanged legacy budgets.
- Prompt and agent-contract tests for skills, tool restrictions, AXI-first/fallback wording, absence of intercom/general write tools, and the scoped `write_report` exception.
- State-machine and store tests for QA/browser transitions, cancellation, failure, and restart uncertainty.
- Workflow tests with delegation doubles for task QA, one aggregated browser wave, and fail-to-`needs_input` behavior.
- One real Pi CLI smoke test in a temporary fixture: a tiny local browser scenario, a unique AXI session, visible artefact output, and explicit proof that no fallback is attempted when AXI succeeds.
- A separate environment health check for `agent-browser`; while its permissions remain broken, assert an honest blocked fallback result rather than a false pass.

## Rollout

1. Ship the two agents and typed contracts with validation opt-in disabled by absence of metadata.
2. Run the temporary-fixture Pi CLI smoke test using AXI.
3. Use QA commands first on one Standard SDD plan and browser scenarios on one small local UI plan.
4. Measure extra launches and elapsed time from `sdd_status` before making validation defaults broader.
