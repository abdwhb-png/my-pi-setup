# ADR-017: Enforce session-plan persistence programmatically

## Status

Accepted

## Date

2026-08-29

## Context

`quick-planner` instructed the model to persist every plan with `session_plan save`, but session `01a04c57-5817-7ab6-9eb9-6dfc8a62ea48` showed that prompt compliance was insufficient: the model presented a plan and only saved it after the user explicitly asked.

Tool visibility controls capability, not tool usage. Removing or forking context-mode would not enforce `session_plan` and would address a separate concern.

## Decision

Opt `quick-planner` into `handoffGuard: session-plan-persistence` and enforce that contract in `pi-roles-addons`.

The guard:

- marks every quick-planner agent run as requiring a fresh successful `session_plan save`;
- accepts only a non-error `session_plan` result whose details identify a valid `save`;
- replaces premature final prose through `message_end`;
- injects a deterministic `turn_end` follow-up that requires the save before retrying;
- records session evidence tied to the active role activation;
- blocks role exit until that activation has recorded a successful save;
- fails closed when volatile guard state is missing after reload;
- caps consecutive interventions to prevent an infinite loop.

## Alternatives Considered

### Strengthen the role prompt

Rejected. The role already contained explicit `session_plan save` instructions when the failure occurred.

### Remove context-mode from Pi

Rejected. Context-mode is unrelated to whether the model calls `session_plan`. Its planning-role access is controlled separately through tool groups.

### Fork context-mode to prohibit edits

Rejected. This would add maintenance cost while leaving the missing persistence invariant unresolved.

### Require user reminders

Rejected. Correctness must not depend on the user detecting an omitted tool call.

## Consequences

- Quick-planner cannot present a final answer or hand off without durable plan evidence.
- Each quick-planner agent run may create a new plan version, even when the plan changes little. This is intentional: deterministic persistence is preferred over semantic guessing about whether prose changed the plan.
- The behavior is reusable by any future role that opts into the same `handoffGuard` value.
- `session_plan history` and failed saves do not satisfy the guard.
