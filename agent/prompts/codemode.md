---
description: Use codemode for the requested task
argument-hint: '[task]'
---

Complete the task below using the `codemode` tool to orchestrate tool calls. If no argument is provided, apply this instruction to the task already in progress.

- Check that `codemode` is available. If it is not, state this clearly and continue with the available tools, without claiming to have used codemode or changing configuration to enable it.
- Read tool declarations before constructing their arguments. Call existing tools from the script rather than reimplementing their behavior.
- Batch independent reads and searches with `Promise.allSettled()`. Inspect every result, including failures. Await the required results before dependent operations and execute mutations sequentially.
- Filter or aggregate results in the script. Return information useful for the next decision, necessary evidence, and explicit errors, without dumping large outputs or secrets.
- Respect the active role, permissions, validation requirements, and task scope. Codemode does not grant additional authorization. Do not call another model unless the task requires it.

TASK: $ARGUMENTS
