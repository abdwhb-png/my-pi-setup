---
name: "safe-delegation"
description: "Reliably delegate parallel implementation tasks to subagents without scope creep or token waste. Use when you have a plan with 2+ implementation tasks and want to delegate them via subagents."
version: 1
created: "2026-06-10"
updated: "2026-06-10"
---
## When to Use
Use when you have a plan with 2+ independent or semi-independent implementation tasks and want to delegate them in parallel to subagents. Also use for any single focused edit where you want strict boundaries and no surprises.

## Procedure
1. **Before delegating, handle prerequisites yourself.** Install dependencies, create new files that other tasks depend on, or run any command that only needs to happen once. Subagents should only edit existing files or create files that don't depend on others.
2. **Pick the right agent for each task:**
- Simple text edits (add export, rename, fix import, 1-2 files) → `delegate` (lightweight, inherits parent model, no fork context)
- Complex implementation (rewrite files, multiple edits, new file creation) → `task-doer` (focused worker variant with fresh context)
- Autonomous research or web search → `researcher`
- Code review → `reviewer`
3. **Every task gets `acceptance.stopRules`.** At minimum include: `"Do NOT modify any file not listed in this task"` and `"Do NOT run commands unless explicitly told to"`. For simple edits, also add `"Do NOT run linters or formatters"`.
4. **Never give a subagent the full plan context.** Write a focused task description that only describes what that specific subagent needs to do. Do not paste the overall plan or reference other tasks. Each subagent should only know about its own piece.
5. **Chain dependent tasks; parallelize independent ones.** If task B needs task A's output (e.g., export a function → import it in a test), use a chain: `{ chain: [{agent: "task-doer", task: "..."}, {agent: "task-doer", task: "..."}] }`. If tasks touch completely different files, use parallel: `{ tasks: [...] }`.
6. **Structure the parallel invocation clearly:**
```ts
// Good pattern
subagent({
  tasks: [
    {
      agent: "delegate",
      task: "In repo at X: add 'export' to function Y in file Z.ts. Only touch Z.ts.",
      acceptance: {
        stopRules: ["Do NOT modify any file except Z.ts", "Do NOT run any commands"]
      }
    },
    {
      agent: "task-doer",
      task: "In repo at X: rewrite test file A.ts to vitest format. ...",
      acceptance: {
        stopRules: ["Only modify A.ts", "Do not modify index.ts or any other file", "Do not run vitest"]
      }
    }
  ],
  concurrency: 3
})
```
7. **Verify yourself after all children complete.** Run `pnpm vitest run` and `pnpm lint` in the parent session. Do not delegate verification to a subagent — they may have made incompatible changes that only surface when all pieces are combined.

## Pitfalls
- **Fork context scope creep**: `worker` defaults to `context: 'fork'`, which inherits the entire parent conversation. If the parent discussed a full plan, the worker may try to execute all of it regardless of its specific task. Solution: use `task-doer` (fresh context) or `delegate`.
- **Subagent runs linters/formatters**: A subagent given a narrow edit may decide to run `oxlint --fix` and modify unrelated files. Solution: add `"Do NOT run linters or formatters"` to stopRules.
- **Parallel workers editing the same file**: Two parallel tasks that touch the same file will conflict. Solution: check file overlap before delegating; if they touch the same file, chain them instead.
- **Verification delegated to subagent**: A subagent that runs tests only sees its own changes, not cross-file issues from parallel edits. Solution: always verify from the parent after all children complete.
- **Task description too broad**: "Convert the test file to vitest" leads to different interpretations. Solution: be specific — list the exact describes, matchers, and patterns to use.

## Verification
1. `git diff --name-only` shows only the files that were supposed to be modified — no unrelated files touched
2. All tasks returned `completed` (not `failed` or `timedOut`)
3. `pnpm vitest run` passes
4. `pnpm lint` shows no new warnings (pre-existing only)
5. The output summaries from each subagent mention only the files they were tasked with