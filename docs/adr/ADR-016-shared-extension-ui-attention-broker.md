# ADR-016: Share extension UI interception for guards and attention notifications

## Status

Accepted

## Date

2026-08-29

## Context

Pi tasks can require human action through any extension using `ExtensionUIContext.select`, `confirm`, `input`, `editor`, or `custom`. Tracking named tools or package events misses unknown and future extensions. `ask_user_question` already uses these primitives: `custom` in TUI mode and `select`/`input` in RPC mode. Yeet commit-plan review uses `custom`.

The existing notification extension handled only a stale `permission-gate:waiting` event and `agent_end`. No repository emitter exists for that permission event. `agent_end` is also too early because Pi may still retry, compact, or continue. Notifications included assistant text, which can leak content onto lock screens.

ADR-015 added low-level UI interception inside `pi-dangerous-mode` for Autopilot. Adding a second independent prototype patch for notifications would create competing proxies. Each patch could wrap the other patch's context, duplicate observation, or notify for UI that Autopilot subsequently blocks.

Pi loads extension entrypoints through separate Jiti instances with `moduleCache:false`. A normal module singleton cannot coordinate cross-extension patch ownership. Pi 0.84 exposes two generic runtime seams:

```text
ExtensionRunner.prototype.setUIContext
InteractiveMode.prototype.createExtensionUIContext
```

Both must be covered. Runner contexts serve registered tools and RPC/TUI dispatch. Interactive factory contexts also serve direct TUI actions and shortcuts.

Desktop delivery must work outside Herdr and across macOS, Windows, WSL, and Linux. It must remain best-effort so a broken notification backend cannot block Pi UI or task settlement.

## Decision

### Use one process-global UI broker

Create `agent/extensions/_shared/extension-ui-broker.ts` as sole owner of both Pi UI prototype patches.

Broker state lives on `globalThis` under `Symbol.for("pi.extension-ui-context-broker")`. It stores:

- original methods by patched prototype,
- raw-context to proxy mappings,
- known proxy identities,
- guards keyed by stable owner ID,
- observers keyed by stable owner ID.

Stable owner replacement makes `/reload` idempotent. An unregister closure removes only callback instance that created it, so stale shutdown handlers cannot delete newer reload registration.

The broker recognizes only five blocking prompt methods:

```text
select, confirm, input, editor, custom
```

Non-prompt methods and properties delegate with original receiver binding.

### Order guards before observers

Prompt invocation order is:

1. run every guard,
2. run every observer,
3. call underlying Pi UI method.

A guard exception stops later phases. Therefore Autopilot-blocked UI produces no attention notification and never renders. Observer failures, including rejected promises, are contained and cannot alter UI result.

Observers receive prompt kind only. Broker does not expose title, message, options, defaults, answer, or custom component arguments.

`pi-dangerous-mode/ui-broker.ts` becomes a thin Autopilot guard adapter. ADR-015 remains authoritative for Autopilot policy. This ADR amends only interception ownership and composition.

### Preserve live reload from legacy broker

During transition, already-running Pi processes may retain old `Symbol.for("pi-dangerous-mode.ui-broker")` wrappers after `/reload`. Shared broker recovers original methods from legacy state, replaces old prototype wrappers, and disables legacy guard dependencies. This prevents stale double wrapping until process restart.

### Refactor existing notification extension

Keep `agent/extensions/notify.ts`, `/notify`, and `PI_NO_NOTIFY=1`. Do not add second notification extension.

Notification observer is active only between `agent_start` and final settlement. Idle commands, shortcuts, and user-opened dashboards remain silent.

Prompt notification payload contains only:

- project basename,
- `action-required`,
- generic prompt kind label.

Completion moves from `agent_end` to `agent_settled`. It reports project basename, elapsed seconds, turn count, and successful edit/write count. It never reads assistant messages.

`agent_settled` handlers execute sequentially, and another extension such as Autopilot may queue continuation during same event. Completion therefore runs on a zero-delay deferred check. It sends only when:

- no newer agent lifecycle generation started,
- agent remains inactive,
- notifications remain enabled,
- context is idle,
- no message is pending.

Stale contexts after session replacement are treated as delivery failure and ignored.

### Use node-notifier plus terminal BEL

Pin runtime dependency `node-notifier@10.0.1` and development types `@types/node-notifier@8.0.5`.

`node-notifier` selects established native backends:

- macOS Notification Center through terminal-notifier,
- Windows toast through SnoreToast,
- WSL through Windows toaster,
- Linux through `notify-send`.

Requests use `sound: true` and `wait: false`. Linux `notify-send` has no equivalent sound option, so Linux outside WSL also emits terminal BEL when stdout is a TTY. Native callback error or synchronous failure falls back to one BEL. No raw terminal bytes are written when stdout is redirected.

Delivery is fire-and-forget. No custom icon, prompt-derived app ID, PowerShell script, or external audio player is used.

## Alternatives Considered

### Track named tools and extension events

Rejected. It requires ongoing package-specific maintenance and misses unknown extensions using standard Pi UI services. Existing `permission-gate:waiting` listener had no emitter.

### Patch Pi UI separately in each extension

Rejected. Independent proxies can stack, duplicate notifications, and observe prompts that another patch later blocks. One broker makes ordering explicit.

### Depend on Herdr notifications

Rejected. User needs same Pi behavior outside Herdr. Herdr remains free to add its own workspace notifications, but Pi notification correctness cannot depend on host terminal.

### Keep custom OSC and PowerShell transport

Rejected. It requires terminal detection, shell escaping, and WSL-specific code while covering fewer desktop environments. OSC is not reliable native desktop delivery across supported platforms.

### Use notifier-hook

Rejected. It offered richer APIs but was newly published with minimal adoption. Requirement favors established dependency and stable platform backends.

### Include assistant or prompt text

Rejected. Lock-screen notification content can expose repository, customer, credential, or business context. Generic metadata is enough to direct user back to Pi.

### Notify immediately inside agent_settled

Rejected. Later `agent_settled` handlers can queue continuation. Immediate delivery can announce completion before Autopilot or another extension resumes work.

## Consequences

### Positive

- Current and future extensions using standard Pi UI primitives trigger action-required notification without package tracking.
- Guards and observers compose deterministically.
- Autopilot-blocked prompts neither render nor notify.
- Idle user UI remains silent.
- Completion waits through Pi retries, compaction, queued messages, and extension continuation scheduling.
- Lock-screen payload contains no prompt or assistant content.
- Notification failure cannot block Pi UI or lifecycle.
- Shared global state remains stable across separate Jiti instances and `/reload`.

### Negative

- Prototype interception depends on Pi internal class and method shapes. Compatibility tests must follow Pi upgrades.
- `node-notifier` bundles platform executables and has an older release cadence.
- Linux audible fallback depends on terminal BEL support and TTY focus policy.
- `ask_user_question` may emit its own BEL, producing duplicate sound alongside native notification. Notification extension does not add package-specific suppression.
- macOS and native Linux branches cannot be manually exercised from current WSL environment and rely on deterministic platform tests.
- Completion adds one event-loop delay before notification.

## Verification

1. Shared broker tests cover all five prompt methods, preserved results and binding, guard-before-observer ordering, observer error isolation, proxy reuse, owner replacement, stale unregister safety, malformed constructors, and legacy reload migration.
2. `pi-dangerous-mode` unit and real Pi runtime suites preserve Autopilot blocking before UI rendering.
3. Notification lifecycle tests cover `agent_settled`, deferred continuation checks, active-only prompts, disabled/headless behavior, privacy, successful file counting, and shutdown cleanup.
4. Real Pi harness tests prove notification occurs before UI render, idle UI stays silent, and Autopilot guard runs before notification observer.
5. Transport tests cover native payload, generic completion stats, macOS/Windows/WSL sound path, Linux BEL, callback and synchronous failure, duplicate-BEL prevention, and redirected output.
6. Full repository tests, typecheck, oxlint, oxfmt check, parse checks, and LSP diagnostics run before completion.
