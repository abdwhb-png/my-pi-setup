# Mock tools reference

`mockTools` is the mechanism that lets your tests stay deterministic without faking Pi itself. The key insight: it intercepts `tool.execute()` for specific tool names, but everything around it — the tool registry, the hook pipeline, the event bus — runs for real.

## The three handler forms

`mockTools` is a `Record<string, MockToolHandler>`. Each value can be one of three shapes:

```typescript
type MockToolHandler =
  | string                                                        // 1. static text
  | ToolResult                                                    // 2. full result object
  | ((params: Record<string, unknown>) => string | ToolResult);   // 3. dynamic function
```

### 1. Static string

The simplest. Becomes `{ content: [{ type: "text", text: "<string>" }] }`.

```typescript
mockTools: {
  bash: "command output here",
}
```

Use this when the tool's params don't change the response, e.g. mocking `read` to a fixed string.

### 2. Dynamic function

Receives the params object and returns a string or a full `ToolResult`.

```typescript
mockTools: {
  read: (params) => `contents of ${params.path}`,
  bash: (params) => `$ ${params.command}\nfile1.txt\nfile2.txt`,
}
```

Use this whenever the response should reflect what was asked. This is the shape that makes your mock feel realistic enough that test assertions on `result.text` are meaningful.

### 3. Full ToolResult

For precise control over `content`, `details`, error responses, etc.

```typescript
mockTools: {
  write: {
    content: [{ type: "text", text: "Written successfully" }],
    details: { bytesWritten: 42 },
  },
}
```

Use this when your extension reads from `result.details` or when you need to return non-text content blocks.

## What stays real, what gets faked

This is the part that surprises people: **everything except `tool.execute()` keeps running.**

| Layer                       | Mocked?         | Notes                                                             |
| --------------------------- | --------------- | ----------------------------------------------------------------- |
| Tool registration           | No              | Real `wrapToolsWithExtensions` pipeline                           |
| `tool_call` hook            | No              | Fires through `AgentSession.beforeToolCall` — **including for mocked tools** |
| `tool_result` hook          | No              | Fires through `AgentSession.afterToolCall`                                  |
| Tool's own `execute()` body | Yes (if listed) | The mock handler runs instead                                     |
| Event collection            | No              | Real event bus                                                    |

Why this matters: if your extension registers a `tool_call` hook that blocks `bash` in plan mode, the block works correctly even when `bash` is mocked. The mock handler never runs (the block happens first), and the result will show `isError: true`.

## Extension-registered tools run for real

A common confusion: extension-registered tools **execute for real** unless they appear in `mockTools`. This is by design — it's how you test your own tool logic while keeping built-ins deterministic.

So: if your extension registers `summarize_doc`, list only the *built-in* tools (`bash`, `read`, `write`, `edit`, etc.) in `mockTools`, and let `summarize_doc` execute its real implementation.

```typescript
const t = await createTestSession({
  extensions: ["./src/index.ts"],   // registers summarize_doc
  mockTools: {
    // Built-ins: mocked so the test stays fast and offline
    bash: (p) => `mock: ${p.command}`,
    read: "mock contents",
    write: "mock written",
    edit: "mock edited",
    // summarize_doc NOT listed → executes its real code
  },
});
```

## What to mock: a decision tree

```
Is this tool implemented by the extension under test?
  Yes
    -> DO NOT mock it. You want to test its real code.
  No (it's a built-in or another extension)
    -> Does the test depend on the tool's *output*?
        Yes
            -> Mock it with a realistic value (form 1 or 2).
        No (test only depends on whether it was *called*)
            -> Mock it with any placeholder; assert on
               t.events.toolCallsFor(name) instead.
```

## Error propagation: `propagateErrors`

When a **real** tool execution throws (i.e. a tool that's *not* in `mockTools`), you control how the harness handles it.

| Value            | Behavior                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `true` (default) | Aborts the test immediately, with a diagnostic pointing at the exact playbook step             |
| `false`          | Captures the error as a tool result with `isError: true`, allowing your extension to handle it |

```typescript
const t = await createTestSession({
  propagateErrors: false,   // capture errors as results instead of aborting
  // ...
});
```

### When to use `propagateErrors: false`

Use it whenever your extension is **supposed to** recover from tool failures. Examples:

- A retry-with-backoff wrapper around `bash`.
- A fallback path when `read` returns `ENOENT`.
- An error message the assistant should paraphrase to the user.

With `propagateErrors: false`, the playbook keeps running, and you can assert on `t.events.toolResultsFor("bash")[0].isError` to confirm the error reached your extension.

### When to leave it true (default)

Use the default when **real** tool errors mean a bug. The diagnostic the harness produces is excellent:

```
Error during tool execution at playbook step 3 (call "bash"):
  ENOENT: no such file or directory '/foo/bar'
  at Object.readFileSync (node:fs:...)

This error was thrown by the real tool execution, not by the playbook.
To capture errors as tool results instead of aborting, set:
  createTestSession({ propagateErrors: false })
```

## Blocked tools: assert the event records

When an extension's `tool_call` hook blocks a tool call, the canonical signals are the collected event records: `blocked: true` + `blockReason` on the `ToolCallRecord`, and `isError: true` + result text on the `ToolResultRecord`. Assert those — the package still exports `ToolBlockedError` for source compatibility, but a normal Pi 0.83 run through `AgentSession` does not promise to throw it.

### Pattern A: assert via events after the fact

```typescript
await t.run(when("Try write", [
  calls("bash", { command: "rm -rf /" }),
  says("Done."),  // consumed regardless of block — the block becomes a result that feeds back into streamFn
]));

const result = t.events.toolResultsFor("bash")[0];
expect(result.isError).toBe(true);

// You can also confirm the block specifically via the call record:
const call = t.events.toolCallsFor("bash")[0];
expect(call.blocked).toBe(true);
expect(call.blockReason).toMatch(/blocked by/i);
```

Note: the playbook **continues** after a block — the block surfaces as a tool result with `isError: true`, which feeds back into the next `streamFn` call, so subsequent `calls(...)` / `says(...)` still get consumed. Hook-block paths are classified as blocks (`blocked: true`) rather than test failures.

### Combining `propagateErrors` with blocks

Regardless of `propagateErrors`, the call record carries `blocked: true` and `blockReason: "..."` so you can assert the hook fired. With `propagateErrors: false`, blocked calls also surface as `isError: true` in the result record and the playbook continues. Do not rely on a `ToolBlockedError` throw from normal Pi 0.83 runs.

## Common pitfalls

- **Listing your extension's own tool in `mockTools`**. If you do, your tool's `execute()` never runs and you're testing nothing. Remove it.
- **Expecting `calls(...)` to throw `ToolBlockedError` on a block**. Normal Pi 0.83 runs do not promise that throw; assert the canonical event records (`blocked`, `blockReason`, `isError`, result text) instead. If you want the playbook to keep flowing, set `propagateErrors: false` and read `.isError`.
- **Mocking a tool the extension doesn't actually call**. The mock is harmless but adds noise; trim the list to what the test exercises.
