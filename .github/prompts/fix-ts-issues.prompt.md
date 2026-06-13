---
description: "Fix all TypeScript type errors and parse errors in the pi agent extensions"
agent: "agent"
---

You are fixing TypeScript issues in the pi agent extensions at `~/.pi/agent/extensions/`.

## Discovery Phase

1. Run `cd ~/.pi/agent && bun run types:check` to find ALL type errors.
2. Run `cd ~/.pi/agent && bun run check:parse` to find ALL parse errors.
3. Run `cd ~/.pi/agent && bun run lint` to check for lint issues.

Collect each error with the **exact** file path, line number, and error message.

## Triage Phase

Group errors by file and by root cause:

| Class | What to look for |
|-------|-----------------|
| **Explicit type annotations** | `Set<unknown>` → `Set<string>`, literal types (`version: 1` → `version: 1 as const`) |
| **Missing `details` in tool returns** | `AgentToolResult<T>` requires `details: T`. All error/empty return paths in `registerTool` execute handlers need `details: undefined` added. |
| **Function signature mismatch** | `_onUpdate` with explicit `(data: unknown) => void` clashes with `AgentToolUpdateCallback<T>`. Remove the explicit type — let TypeScript infer contextually. |
| **`unknown` from dynamic access** | `Object.entries()` yields `unknown` values. Add type assertions like `as { tools?: string[] \| false }`. |
| **Missing interface properties** | Tests access properties like `commitMessage` or `cursorPosition` that don't exist on the interface. Add them as optional. |
| **Parse issues** | `node --check` can't parse TypeScript. Scripts using it should use `bun build --no-bundle --no-clear-screen` or `tsc --noEmit` instead. |

## Fix Phase

For each error:

1. Read the affected file to understand context.
2. Apply the minimal, focused fix.
3. Only fix the errors identified in Discovery — no refactoring or scope creep.

## Verification Phase

1. Run `cd ~/.pi/agent && bun run types:check` — must exit with 0.
2. Run `cd ~/.pi/agent && bun run check:parse` — must exit with 0.
3. Run `cd ~/.pi/agent && bun test` — all tests must pass.
4. Run `cd ~/.pi/agent && bun run lint` — must exit clean.

If any verification step fails, go back to Discovery. Never declare done until all four pass.