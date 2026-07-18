# Playbook DSL reference

The playbook replaces the LLM. Instead of calling a model, the Pi agent loop consumes scripted actions in order. The DSL is small — three builders and a couple of compositional tricks — but it's the heart of `pi-test-harness`, so this file is the most important reference.

## Builders

### `when(prompt, actions)`

Defines a single conversation turn: the prompt you'll send and what the model does in response.

```typescript
when("Deploy the app", [
  calls("bash", { command: "npm run build" }),
  calls("bash", { command: "gcloud run deploy" }),
  says("Deployed successfully."),
])
```

- `prompt` is the user-side message that begins the turn.
- `actions` is an ordered list of `calls(...)` and `says(...)`.
- The harness serves actions to the agent loop one per `streamFn` call, in array order.
- A turn ends when `says(...)` is consumed — `says` produces a final assistant message and signals turn end.

### `calls(tool, params)`

The model calls a tool. Pi's hooks fire normally, the tool executes (real or mocked per `mockTools`), and the result feeds back into the next `streamFn` call.

```typescript
calls("plan_mode", { enable: true })
calls("bash", { command: "ls -la" })
```

`params` may be either an object literal or a function `() => params` for late binding (see "Late-bound params" below).

Each `calls(...)` returns a builder you can chain `.then()` onto.

### `says(text)`

The model emits text. The agent turn ends.

```typescript
says("All done. The deployment is complete.")
```

`says` must be the last action in a turn — it produces the terminating assistant message.

## Multi-turn conversations

Pass multiple turns to `run()`:

```typescript
await t.run(
  when("What files are in the project?", [
    calls("bash", { command: "ls" }),
    says("Found 3 files."),
  ]),
  when("Now read the README", [
    calls("read", { path: "README.md" }),
    says("Here's what it says..."),
  ]),
);
```

Each new `when(...)` is treated as a fresh user message; the model's prior text and tool calls remain in the session state for the next turn.

## Late-bound params and `.then()`

When one tool call produces a value that the next call needs, use `.then()` to capture the result, and pass a `() => params` function so the params are resolved at call time (after `.then()` has fired).

The canonical pattern: a tool returns a generated ID in its text output, and the next tool needs that ID:

```typescript
let planId = "";

await t.run(
  when("Create and approve a plan", [
    calls("plan_propose", {
      title: "Send invoice",
      steps: [
        { description: "Send email", tool: "go-easy", operation: "send" },
      ],
    }).then((result) => {
      // Extract the plan ID from the tool result text
      planId = result.text.match(/PLAN-[a-f0-9]+/)![0];
    }),
    // Late-bound: params resolved at call time, after .then() has fired
    calls("plan_approve", () => ({ id: planId })),
    says("Plan approved and executing."),
  ]),
);

expect(planId).toMatch(/^PLAN-/);
```

How it works:

1. `plan_propose` runs, returns a result whose `.text` contains something like `Plan PLAN-a3f9c2 created`.
2. `.then()` fires with the `ToolResultRecord`. Save the value to a test variable.
3. The next `calls(...)` is given a function. The harness invokes it at call time — so `planId` is now populated, and the params object is what actually gets passed.

This is the supported way to chain dependent calls. Without `.then()` + a function-returning params, you'd be stuck with whatever you pre-declared.

## Real-world example: testing pi-planner

A non-trivial extension that registers 8 tools, blocks writes in plan mode, and manages plan lifecycle:

```typescript
import {
  createTestSession, when, calls, says, type TestSession,
} from "@marcfargas/pi-test-harness";
import * as path from "node:path";

const EXTENSION = path.resolve(__dirname, "../../src/index.ts");
const MOCKS = {
  bash: (p: Record<string, unknown>) => `mock: ${p.command}`,
  read: "mock contents",
  write: "mock written",
  edit: "mock edited",
};

describe("pi-planner", () => {
  let t: TestSession;
  afterEach(() => t?.dispose());

  it("enters plan mode and proposes a plan", async () => {
    t = await createTestSession({
      extensions: [EXTENSION],
      mockTools: MOCKS,
    });

    let planId = "";

    await t.run(
      when("Plan the deployment", [
        calls("plan_mode", { enable: true }),
        calls("plan_propose", {
          title: "Deploy v2",
          steps: [
            { description: "Build",   tool: "bash",   operation: "build" },
            { description: "Deploy",  tool: "gcloud", operation: "deploy" },
          ],
        }).then((r) => {
          planId = r.text.match(/PLAN-[a-f0-9]+/)![0];
        }),
        says("Plan proposed."),
      ]),
    );

    expect(planId).toMatch(/^PLAN-/);
    expect(t.events.toolResultsFor("plan_mode")[0].text).toContain("enabled");
    expect(t.events.uiCallsFor("notify")).toHaveLength(1);
  });
});
```

## Diagnostics: when the playbook doesn't match reality

The harness auto-asserts that all playbook actions are consumed after `run()` completes. If script and reality disagree, you get one of two diagnostic shapes.

### 1. Playbook exhausted unexpectedly

```
Playbook exhausted unexpectedly.
  Consumed 2 action(s).
  Last consumed: calls("bash", {"command":"ls"}) at step 2

  The agent loop called streamFn but no more playbook actions were available.
  This usually means a tool call produced an unexpected result that caused
  additional streamFn calls (retries, error handling).
```

**What it means**: the agent loop called `streamFn` more times than your script expected. The most common causes:

- A tool call produced an error, triggering automatic retry inside Pi.
- A hook blocked a tool and Pi retried with a different action.
- An extension spawned an extra `streamFn` call you didn't anticipate.

**Fix**: read the diagnostic's "Last consumed" line to find where reality diverged. Either add the missing actions to your script, or change `mockTools` so the tool doesn't error / the hook doesn't fire.

> **Do not confuse** this exhaustion diagnostic with the `propagateErrors: true` error diagnostic, which looks like:
> ```
> Error during tool execution at playbook step 3 (call "bash"):
>   ENOENT: no such file or directory '/foo/bar'
> ```
> That one fires when a **real** (non-mocked) tool throws and `propagateErrors` is on. The exhaustion diagnostic above fires when the **script** and the agent loop disagree on how many actions exist. Different cause, different fix.

### 2. Playbook not fully consumed

```
Playbook not fully consumed after run() completed.
  Consumed 1 of 3 action(s).
  Remaining:
    - calls("write", {"path":"out.txt","content":"hello"})
    - says("Done writing.")

The agent loop ended before all playbook actions were used.
This usually means a tool was blocked by a hook or returned early,
causing fewer streamFn calls than expected.
```

**What it means**: a tool was blocked by an extension hook, or returned early, so Pi ended the turn before consuming everything you queued.

**Fix**: if the block is *expected*, restructure your script so the unconsumed actions reflect what reality did (or wrap the call in a try/catch on `ToolBlockedError`). If the block is *unexpected*, the test just surfaced a real bug — investigate the hook.

## Parallel tool calls (known intentional gap)

Today the playbook emits one tool call per assistant message, which is deterministic and good for most extension tests. True Pi-side parallelism (multiple `toolCall` blocks in one assistant message) is not yet modeled. To test parallel tool execution you'd need a grouped/batched call action — flagged in the package's Testing Scope notes as a future addition, with results asserted by `toolCallId` rather than completion order.

For now: if your extension's correctness depends on *parallel* rather than *sequential* tool execution, write a focused test that calls the extension's handler directly rather than driving it through the playbook.
