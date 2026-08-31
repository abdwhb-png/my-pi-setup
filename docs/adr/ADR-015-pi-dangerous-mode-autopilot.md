# ADR-015: Add budgeted Autopilot to pi-dangerous-mode

## Status

Superseded by [ADR-018](ADR-018-pi-dangerous-mode-unattended-prompt-suppression.md)

## Date

2026-08-29

## Context

ADR-013 defines `pi-dangerous-mode` as one session-scoped authority for eligible permission asks and unprotected extension `tool_call` blockers. It intentionally does not answer business questions. In practice, tools such as `ask_user_question` and unknown extensions using `ExtensionUIContext` can still stop agent execution for human input even while Dangerous is effective.

Autopilot requires broader behavior:

- suppress standard human prompts before rendering,
- let same active model choose safe non-interactive path,
- continue through normal Pi turns until explicit completion,
- retry after error turns within conservative budgets,
- stop before irreversible or externally consequential actions,
- preserve Dangerous-only behavior,
- keep activation session-scoped,
- record useful operational evidence without prompt or response content.

Prompting extensions are not known in advance. Intercepting only named tools cannot cover third-party `select`, `confirm`, `input`, or `editor` calls. Conversely, blindly cancelling arbitrary `custom()` UI can break user dashboards and cannot infer return value from opaque component factory.

Pi 0.84 exposes runner UI context through mutable `ExtensionRunner.setUIContext`, and extension contexts resolve UI lazily. Interactive shortcuts create additional contexts through `InteractiveMode.createExtensionUIContext`. These two runtime seams provide generic interception without modifying each package.

## Decision

### Keep one extension with two user modes

`pi-dangerous-mode` owns Dangerous and Autopilot as separate modes:

- Dangerous: `--dangerously-skip-permissions` and `/dangerous-mode`.
- Autopilot: `--autopilot` and `/autopilot`.

Autopilot contributes one source to Dangerous effective state. It does not duplicate permission bypass logic. Turning Autopilot off removes only induced source, leaving direct Dangerous flag or override intact.

ADR-013 remains authoritative for Dangerous authorizer chain, bounded delegation, explicit denies, and session semantics. This ADR extends same module; it does not supersede ADR-013.

### Intercept standard extension UI below tool layer

Install idempotent process-global wrappers around:

```text
ExtensionRunner.prototype.setUIContext
InteractiveMode.prototype.createExtensionUIContext
```

Wrapped `select`, `confirm`, `input`, and `editor` throw `AUTOPILOT_PROMPT_BLOCKED` before underlying UI runs. Tool result tells model to use safe non-interactive path and not repeat prompt.

`ask_user_question` retains dedicated pre-execution interception because it is identifiable and must be blocked before its own extension events or overlay.

`custom()` remains opaque. It is blocked during active agent run, where unresolved promise would stall Autopilot. It remains available while agent is idle so user-invoked dashboards are not destroyed blindly. UI created outside `ExtensionUIContext` remains outside interception contract.

### Continue through normal Pi turns

Register `autopilot_complete`, hidden while Autopilot is off and active only while effective. `before_agent_start` instructs active model to avoid human input, validate requested work, and call tool exactly once with `completed` or `blocked` outcome.

At `agent_settled`, when no message is pending and phase remains running, extension sends one hidden custom message with `triggerTurn: true`. This starts normal Pi model turn. It does not call provider, completion, evaluator, or model API directly.

Errors are counted from `turn_end` tool results. Retry reason is retained across all model turns in one agent run, including final clean text turn after earlier tool error. Completion and budget exhaustion prevent further continuation.

### Enforce conservative budgets and protected-action guards

Defaults:

- 8 Pi turns,
- 2 error turns,
- 600000 ms elapsed time.

Budget exhaustion ends mode with stable reason and removes completion tool.

Before tool execution, Autopilot evaluates configured guarded tool and command globs plus shared `safe_bash` danger inspection. Default policy protects irreversible deletion, publication, deployment, purchase/payment, and other external effects. A guard match ends mode in `blocked` phase before execution. Induced Dangerous cannot bypass this layer.

### Record metadata-only session telemetry

Append versioned custom entries under:

```text
pi:autopilot:telemetry
```

Records contain timestamp and bounded metadata for mode changes, blocked prompt kind, blocked guard category/tool name, counters, continuation reason, completion outcome, or stop reason. They exclude titles, messages, prompts, options, answers, raw input, commands, content, and arbitrary details.

Telemetry stays inside Pi session through `appendEntry()`. It has no network export, global archive, retention service, or stats command. Append failure cannot alter control flow.

### Fail closed on runtime incompatibility

Low-level runner and UI patches validate required constructor and method shapes. Incompatibility disables affected mode and reports error. UI incompatibility disables Autopilot only; independently requested Dangerous can remain active. Process-global `Symbol.for(...)` state prevents wrapper stacking across `/reload` while allowing callbacks to refresh.

## Alternatives Considered

### Separate Autopilot extension

Rejected. Autopilot must compose Dangerous without introducing second permission authority or duplicated bypass state. One extension with separated internal components preserves ownership and user-selected surface.

### Inline evaluator model call after every turn

Rejected. It adds provider calls, cost, latency, credential handling, and disagreement between worker and evaluator. Same active model must decide path and explicit completion through normal Pi loop.

### Tool replay or synthetic answer protocol

Rejected. Replaying arbitrary third-party tools after synthesizing UI answers requires package-specific schemas, can duplicate side effects, and cannot generically reconstruct continuation state.

### Global telemetry archive

Rejected. Raw or centralized history adds privacy, retention, redaction, and export obligations. Session-local metadata is sufficient for operation and review.

### Blindly cancel every custom UI while idle

Rejected. `custom()` also powers user dashboards and exposes no generic semantics or safe default return value. Idle custom UI remains available; active-run custom UI blocks clearly.

## Consequences

### Positive

- Unknown extensions using standard UI primitives cannot render blocking human prompts during Autopilot.
- Dangerous-only behavior remains unchanged.
- One source-composed state prevents Autopilot disable from accidentally disabling direct Dangerous.
- Explicit completion and finite budgets prevent unbounded loops.
- Protected actions stop before execution even though Dangerous is induced.
- Runtime telemetry supports diagnosis without storing prompt, answer, or command content.
- Real Pi 0.84 integration tests verify runner dispatch, UI interception, lifecycle continuation, completion, retries, budgets, guards, and mode separation.

### Negative

- Normal continuation turns still consume model tokens and provider quota.
- Explicit completion depends on model compliance and does not prove semantic quality.
- Guard false positives stop safely and require human intervention.
- Low-level prototype patches depend on Pi runtime internals and may disable Autopilot after incompatible Pi update.
- UI outside `ExtensionUIContext` cannot be intercepted.
- Lexical guard patterns cannot prove absence of side effects hidden by unknown tools.
- Opaque custom UI cannot be auto-resolved safely.

## Verification

1. Unit tests cover source-composed state, reload/new-session semantics, budgets, terminal transitions, guard classification, telemetry privacy, UI proxy idempotence, runner compatibility, permission authorizer, and loop scheduling.
2. Real Pi runtime tests prove hidden completion tool activation, unknown-extension structured UI blocking without UI calls, dedicated `ask_user_question` blocking, Dangerous-only parity, one continuation, explicit completion, retry accounting across multi-turn agent runs, turn/retry/time budgets, and pre-execution guards.
3. Focused suite runs from `~/.pi/agent` with `bun test --isolate extensions/pi-dangerous-mode`.
4. LSP diagnostics, oxlint, formatting, and repository gates run before completion.
