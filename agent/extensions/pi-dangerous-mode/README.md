# Pi Dangerous Mode and Autopilot

One Pi extension exposes two independent session modes:

- **Dangerous** auto-allows eligible permission asks and bypasses unprotected extension `tool_call` blockers.
- **Autopilot** suppresses human prompts, induces Dangerous while active, continues through normal Pi turns, and stops on explicit completion, a protected action, or a budget.

Autopilot does not make Dangerous auto-answer business questions. Dangerous-only behavior remains defined by [ADR-013](../../../docs/adr/ADR-013-pi-dangerous-mode-authorizer-chain.md).

## Activation

| Surface  | Dangerous                         | Autopilot                    |
| -------- | --------------------------------- | ---------------------------- |
| CLI flag | `--dangerously-skip-permissions`  | `--autopilot`                |
| Command  | `/dangerous-mode on\|off\|status` | `/autopilot on\|off\|status` |

Both flags and commands apply to the current session. They do not persist a permissive setting to disk.

`/reload` preserves explicit command overrides. A new, resumed, or forked session resets overrides and derives state from its CLI flags.

## State composition

Dangerous effective state is the union of:

1. its CLI flag,
2. its explicit command override, and
3. the source induced by effective Autopilot.

Turning Autopilot off removes only source 3. Dangerous remains effective when its flag or direct override is still on.

Autopilot fails closed when its configuration, runner patch, or UI broker is incompatible. A UI-broker incompatibility disables Autopilot without disabling independently requested Dangerous mode.

## Autopilot flow

1. Autopilot adds `autopilot_complete` to active agent tools.
2. `before_agent_start` tells same active model to avoid human input, use safe non-interactive paths, validate work, and call `autopilot_complete` when done.
3. Standard human prompts are blocked before UI rendering.
4. After agent settles without completion, extension starts at most one normal Pi continuation when no other message is pending.
5. `autopilot_complete` ends loop with `completed` or `blocked` outcome and removes itself from active tools.

No nested evaluator or provider request exists. Continuations are normal Pi model turns and consume normal model tokens.

### Explicit completion

Model calls:

```json
{
    "outcome": "completed",
    "summary": "Requested work and executable validation completed.",
    "remainingRisks": []
}
```

Use `outcome: "blocked"` when protected action or human authority is required. Explicit completion depends on model following system instruction; budgets prevent unbounded continuation but do not prove work quality.

## Prompt interception

While Autopilot is effective:

- `ask_user_question` is blocked before extension handlers and before its UI opens.
- `ExtensionUIContext.select`, `confirm`, `input`, and `editor` throw `AUTOPILOT_PROMPT_BLOCKED` before underlying UI is called.
- Tool receives controlled error text telling model to choose safe non-interactive path instead of repeating prompt.
- Dangerous-only mode does not suppress these prompts.

`ExtensionUIContext.custom()` is opaque. During active agent run it is blocked rather than guessed. While agent is idle, user-invoked custom dashboards remain allowed.

Runner-bound contexts cover TUI, RPC, JSON, and print modes. Interactive factory is patched separately for shortcut-created contexts. UI created outside `ExtensionUIContext` cannot be intercepted.

## Configuration

Global configuration:

```text
~/.pi/agent/pi-dangerous-mode.json
```

Project configuration:

```text
<cwd>/.pi/pi-dangerous-mode.json
```

Defaults:

```json
{
    "protectedTools": [],
    "protectedExtensions": [],
    "autopilot": {
        "maxTurns": 8,
        "maxRetries": 2,
        "maxDurationMs": 600000,
        "guardedTools": [
            "*deploy*",
            "*publish*",
            "*purchase*",
            "*payment*",
            "*delete*",
            "*destroy*"
        ],
        "guardedCommands": [
            "*git push*",
            "*gh pr create*",
            "*gh release create*",
            "*npm publish*",
            "*bun publish*",
            "*pnpm publish*",
            "*docker push*",
            "*kubectl apply*",
            "*kubectl delete*",
            "*helm install*",
            "*helm upgrade*",
            "*terraform apply*",
            "*terraform destroy*"
        ]
    }
}
```

Project fields override global fields. Declared arrays replace lower-layer arrays; undeclared fields inherit. Budgets must be positive integers.

- `protectedTools` and `protectedExtensions` preserve selected extension blockers under Dangerous mode.
- `guardedTools` and `guardedCommands` protect actions under Autopilot.
- Patterns support `*` globs.

## Budgets

- `maxTurns` counts Pi `turn_end` events while Autopilot runs.
- `maxRetries` counts turns containing error tool results.
- `maxDurationMs` measures elapsed time from Autopilot activation.

Budget is checked at each turn end. Exhaustion stops Autopilot deterministically with `turn_budget`, `retry_budget`, or `time_budget`; no continuation is queued.

## Protected actions

Autopilot checks configured tool and command patterns before execution. Shell command input also uses shared `safe_bash` danger inspection. Default categories cover:

- irreversible deletion,
- publication,
- deployment,
- purchase or payment,
- other external effects.

A match ends Autopilot in `blocked` phase before tool execution. Induced Dangerous mode does not bypass this guard. Custom patterns without known category are treated as external effects.

These lexical guards reduce risk but are not a complete security boundary. Unknown tools can hide side effects, and patterns can produce false positives. False positives stop safely and require explicit human action to proceed.

## Telemetry and privacy

Extension appends metadata-only custom session entries:

```text
pi:autopilot:telemetry
```

Every record contains:

```json
{
    "schemaVersion": 1,
    "timestamp": "2026-08-29T00:00:00.000Z",
    "event": "mode_change"
}
```

Event kinds are `mode_change`, `prompt_blocked`, `guard_blocked`, `turn_recorded`, `continuation_queued`, `completed`, and `stopped`.

Records may include mode, source, enabled state, prompt kind, guard category, tool name, counters, outcome, or stop reason. They never include prompt text, answers, options, raw tool input, commands, content, or arbitrary details. Telemetry uses `pi.appendEntry()` only, has no network export or global archive, and never changes mode enforcement if append fails.

## Verification

Run focused extension suite from `~/.pi/agent`:

```bash
bun test --isolate extensions/pi-dangerous-mode
```

Real runtime coverage uses `@abdwhb-png/pi-test-harness` with Pi 0.84.x extension loading, tool wrapping, lifecycle events, and UI boundary mocks.
