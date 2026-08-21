---
description: Plan, implement, review, and apply focused review fixes.
---

Implement and review: $ARGUMENTS

Create the concrete plan in the main session. Then invoke one `subagent` `workflowScript` that:

1. runs `worker` with a stable `implement` key and the approved plan;
2. runs the read-only `reviewer` with a stable `review` key, the original requirements, and the implementation output;
3. runs `worker` with a stable `fix` key to address only actionable reviewer findings;
4. returns the final worker result.

Use `await runs.run(...)` for each dependency. Do not use legacy top-level `chain`, `tasks`, or `parallel` payloads. The reviewer must remain read-only and must not be asked to mutate files or use shell tools.
