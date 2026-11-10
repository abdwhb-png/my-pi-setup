---
description: Verify tool availability before reporting a blocker
argument-hint: '[task or tool]'
---

Verify tool availability for the task or tool below. Without an argument, apply this check to the task in progress. Keep the current role and authorization boundaries.

- Inspect the current request interfaces and their documented direct, `codemode`, or discovery paths. A previous failure or a historical tool list does not establish current availability.
- When an appropriate interface exists, attempt one relevant operation without side effects, such as reading a known non-sensitive file. Use documented discovery when needed; do not invent tool names or arguments.
- If the operation succeeds, resume the authorized task. If it fails, report the attempted tool and the actual error, excluding secrets. A failure of one tool does not establish that every tool is unavailable.
- If no suitable callable interface is supplied, state what you can observe and that no operation was attempted. Distinguish missing evidence, permission denial, command failure, and tool unavailability.
- Recommend reload or configuration changes only when evidence supports them. This check does not authorize changing configuration, switching roles, mutations, or additional provider calls.

TASK OR TOOL: $ARGUMENTS
