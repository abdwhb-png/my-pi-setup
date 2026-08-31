# ADR-018: Replace Autopilot with Unattended prompt suppression

## Status

Accepted

## Date

2026-08-30

## Context

ADR-015 combined prompt suppression with continuation turns, budgets, completion protocol, lexical external-action guards, and session telemetry. Continuation consumes model turns and overlaps `extensions/until.ts`, which owns explicit looping. Prompt suppression remains useful independently when agent work must not block on human UI.

## Decision

Replace Autopilot with `/unattended on|off|status` in `pi-dangerous-mode`.

Unattended suppresses `ask_user_question`, structured `ExtensionUIContext` prompts, and active-run `custom()` UI. Suppressed calls use `UNATTENDED_PROMPT_BLOCKED` and direct the model to choose only a safe, reversible, context-supported path or end normally with a concrete blocker.

Unattended has no CLI flag, does not enable Dangerous, and does not persist beyond session command semantics. It never injects a continuation, registers a completion tool, evaluates plans, tracks budgets, guards external actions, or records Autopilot telemetry.

Dangerous stays unchanged under ADR-013. Its permission bypass and blocker bypass are neither granted nor changed by Unattended.

## Alternatives considered

### Retain Autopilot aliases

Rejected. Aliases would retain an obsolete authority model and obscure removal of looping semantics.

### Retain external-action guards

Rejected. They couple prompt suppression to a second policy system. Dangerous authorization remains explicit and separate.

### Make Unattended a CLI flag

Rejected. The requested mode is explicitly toggled during a live session; `/unattended` makes activation visible and reversible without launch-time configuration.

## Consequences

- Human prompts no longer stall active agent work when Unattended is enabled.
- Agent may end with blocker instead of receiving fabricated approval.
- No hidden model turns, completion protocol, token budget, or action-policy side effects remain.
- `extensions/until.ts` is sole explicit looping mechanism.
- ADR-015 is superseded. ADR-013 remains active.

## Verification

Focused unit and Pi runtime tests prove command activation, independent Dangerous state, pre-execution prompt blocking, idle custom UI access, and absence of continuation/completion tooling. Repository formatting, linting, typecheck, and tests run before completion.
