# ADR-013: pi-dangerous-mode renames pi-yolo and auto-allows via the authorizer chain

## Status

Accepted — supersedes ADR-010 (mechanism retained, naming and permission layer replaced)

## Date

2026-08-22

## Context

ADR-010 introduced `pi-yolo`, a session-scoped central bypass of unprotected
extension `tool_call` blockers. Since then, two problems surfaced:

1. **Naming collision and confusion.** Three distinct "yolo" concepts coexist:
   the `pi-yolo` extension (`/yolo`), `@gotgenes/pi-permission-system`'s
   persistent `yoloMode` config knob, and the local
   `pi-permission-system-addons` toggle (`/yolo-permission`) that reads/writes
   that knob. The footer status published by the package (`yolo` via
   `ctx.ui.setStatus`) reflects only the package's `yoloMode`, so `/yolo off`
   appears broken while the footer still shows `yolo`. Diagnosis confirmed all
   three layers are mechanically independent; only the names collide.

2. **Partial coverage.** Launching a session "like Claude Code's
   `--dangerously-skip-permissions`" requires silencing both layers:
   extension blockers (pi-yolo) *and* permission prompts (package `yoloMode`
   or equivalent). Using the two existing flags (`--yolo --yolo-permission`)
   is easy to get half wrong, reproducing exactly the confusion above.

Forcing the package's `yoloMode: true` from a launch flag was rejected: the
only supported write path persists to `extensions/pi-permission-system/config.json`,
and a crash between write and restore would leave every future session running
with loosened permissions.

The package exposes a purpose-built alternative: the live-authority chain
(ADR 0007 of the package). A registered link reviews each `ask` before the
terminal human prompt and may return `allow`, `deny{reason}`, or `defer`.
Activation is opt-in via the operator's `authorizerChain` config list, which is
persistent but inert until a link with that name registers. The
bounded-delegation checkpoint caps link `allow`s on the excluded surfaces
(`external_directory`, `path`) down to `defer`.

## Decision

### Rename pi-yolo → pi-dangerous-mode

- Extension directory: `agent/extensions/pi-dangerous-mode/`.
- CLI flag: `--dangerously-skip-permissions` (Claude Code parity).
- Command: `/dangerous-mode on|off|status`.
- Internal state symbol: `Symbol.for("pi-dangerous-mode.state")`.
- Config files: `~/.pi/agent/pi-dangerous-mode.json` and `<cwd>/.pi/pi-dangerous-mode.json`.
  The legacy `pi-yolo.json` filename is **not** maintained; delete or rename
  any existing file.
- Session semantics are unchanged from ADR-010: flag-derived state at
  session start, `/reload` preserves an explicit override, new sessions reset
  to the CLI flag.

### Cover the permission layer through an authorizer chain link

The renamed extension registers a chain link named `"pi-dangerous-mode"` on
the package's `permissions:ready` event:

```ts
service.registerAuthorizer("pi-dangerous-mode", async (_details, _query, log) => {
    if (!isDangerousEnabled()) return { kind: "defer" };
    log.debug("dangerous_mode.auto_allow", {});
    return { kind: "allow" };
});
```

Properties:

- **No disk writes.** The verdict reads live session state (`Symbol.for`) per
  ask. Launching with the flag never mutates `config.json`; crash-safe by
  construction.
- **Opt-in activation.** `"authorizerChain": ["pi-dangerous-mode"]` is added
  once to `agent/extensions/pi-permission-system/config.json`. Removing that
  entry silently fails safe: every ask prompts again.
- **Immediate toggle.** `/dangerous-mode off` takes effect on the next ask
  without reload.
- **Disposal.** Links are re-registered per service generation (correct across
  `/reload`; duplicate registration within one generation throws) and disposed
  at `session_shutdown`.

### What dangerous mode does not lift

Accepted invariants of the package:

- Surfaces excluded by the bounded-delegation checkpoint (`external_directory`,
  `path`) still prompt: a link `allow` is capped to `defer` there.
- Explicit `deny` rules still deny.
- Wrapper-floor asks (e.g. `timeout …`, matched as
  `<indirection-bash-wrapper>`) reach the chain and ARE auto-allowed under the
  mode — unlike under `yoloMode`, where they still prompted.
- The footer `yolo` status continues to reflect the package's `yoloMode`
  exclusively; it is unaffected by this mode by design.

## Alternatives Considered

### Force `yoloMode: true` at launch and restore on shutdown

Rejected. Requires persisting to the shared config file; a crash before
restore leaks a permissive policy into unrelated future sessions.

### Keep both flags behind a shell wrapper (`pi --yolo --yolo-permission`)

Rejected as the long-term shape (kept viable as an interim). Two flags invite
partial invocation, and the naming confusion remains.

### Update ADR-010 in place

Rejected. The rename plus permission-layer integration is a distinct decision;
ADR-010 stays as the record of the runner-patch mechanism it approved (which
this ADR retains unchanged).

## Consequences

### Positive

- One flag expresses the full "never prompt" intent across both layers.
- Zero persistent state mutation from launching; rollback is deleting the
  `authorizerChain` entry.
- The `yolo` namespace is freed for the permission system's own vocabulary.

### Negative

- Old invocations using `--yolo` lose that flag silently (unknown-flag
  behavior); Herdr launch conventions must switch to
  `--dangerously-skip-permissions`.
- The chain-link layer depends on the third-party package keeping its
  `registerAuthorizer` surface and `permissions:ready` channel stable.

## Verification

1. Focused Bun tests: authorizer-link registration/allow/defer/disposal;
   flag and command contract; runner patch behavior (renamed).
2. Full suite, typecheck, lint.
3. Bounded E2E with `yoloMode` temporarily `false`: flagged session executes
   an `ask`-rule command without prompting (decision trace in the review
   log); unflagged session prompts; `yoloMode` restored afterwards.
