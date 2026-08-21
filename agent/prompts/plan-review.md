---
description: Build context, write an implementation plan, and review it for executability.
---

Prepare an implementation plan for: $ARGUMENTS

Use `subagent` only through a `workflowScript`. First run a fresh `scout` node to inspect the relevant code and return concrete findings. Use those findings and the `writing-plans` skill to write the plan yourself; the removed `context-builder` and `planner` roles must not be referenced. Then run a fresh `plan-reviewer` node against the written plan and the scout evidence. Address at most three actionable review gaps and present the final executable plan.

Do not use legacy top-level `chain`, `tasks`, or `parallel` payloads. Use stable `runs.run` keys and pass prior node output explicitly in later tasks.
