# Mock Pi CLI reference

`createMockPi` is for extensions that **spawn** `pi --mode json -p` as a subprocess to delegate work to a child agent — common in subagent orchestrators, fan-out task runners, and reflection/replan loops.

In tests, those subprocesses would call a real LLM (non-deterministic, slow, possibly requiring credentials). `createMockPi` solves this by putting a *fake* `pi` binary on `PATH` that returns controllable responses from a queue.

## How it works

1. `install()` creates a temp directory with a platform-specific shim:
   - `pi.cmd` on Windows
   - shell script `pi` on Linux/macOS
2. The shim is prepended to `PATH` so `child_process.spawn("pi", ...)` resolves to it.
3. Each invocation reads the next response from a file-based queue (`queue.json` + a counter file).
4. When the queue is exhausted, the last response repeats.
5. If no responses are queued, the mock echoes back the task text.

You read & assert the queue from your test; the spawned subprocesses read it from disk. That decoupling is what makes this safe across worker boundaries.

## Full lifecycle

```typescript
import { createMockPi } from "@marcfargas/pi-test-harness";

const mockPi = createMockPi();
mockPi.install();                      // 1. enable

mockPi.onCall({ output: "Hello from agent", exitCode: 0 });    // 2. queue responses
mockPi.onCall({ stderr: "agent crashed", exitCode: 1 });
mockPi.onCall({
  jsonl: [
    { type: "tool_execution_start", toolName: "bash" },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
  ],
});

expect(mockPi.callCount()).toBe(0);    // 3. assert before

// ...playbook that triggers subprocess spawns via your extension...

// ...then assert after:
expect(mockPi.callCount()).toBe(3);

mockPi.uninstall();                    // 4. cleanup: restore PATH, delete temp dir
```

## Response options: `MockPiCall`

Each call to `onCall(response)` queues one `MockPiCall`. All fields are optional:

| Field        | Type                    | Default               | Purpose                                                                  |
|--------------|-------------------------|-----------------------|---------------------------------------------------------------------------|
| `output`     | `string`                | echo of the task text | Text emitted in a default `message_end` event                            |
| `exitCode`   | `number`                | `0`                   | Process exit code                                                         |
| `stderr`     | `string`                | (empty)               | Written to the child process's stderr                                     |
| `delay`      | `number`                | `0`                   | Delay (ms) before responding — used to test timeout/abort paths           |
| `jsonl`      | `object[]`              | (none)                | Raw JSONL event objects; if set, replaces the default `message_end`       |
| `writeFiles` | `Record<string,string>` | (none)                | Files to create in the spawned process's CWD (path → content)             |

### Choosing between `output` and `jsonl`

- **`output: "Hello"`** — quick, common case. The mock wraps your string in a default `message_end` event that Pi's subprocess protocol expects.
- **`jsonl: [...]`** — for tests that care about specific event types being emitted (e.g., simulating `tool_execution_start` before `message_end`, or simulating an error event midway).

Reach for `jsonl` when your extension parses the subprocess's event stream for specific shapes, not just the final text.

### The `writeFiles` field

Some real Pi subprocesses don't return text — they write to disk (chain_dir output, plan files, etc.). Simulate that with `writeFiles`:

```typescript
mockPi.onCall({
  output: "Result written",
  writeFiles: { "/tmp/output.md": "# Result\nDone." },
});
```

The mock writes those files to the spawned process's CWD during the call. Combined with `output` so your extension reads both channels.

## Safety features

These exist because tests crash, OSes differ, and typos happen:

- **Exit handler restores `PATH`.** On Node process exit — even if `uninstall()` was never called (test crash) — `PATH` is restored automatically. No permanent pollution of your environment.
- **Key validation.** Typos like `{ ouptut: "..." }` throw immediately at `onCall()`. Without this, the misspelled response would silently use the default and your test would pass for the wrong reason.
- **30-second timeout.** If something goes wrong (deadlocked consumer, etc.), the mock subprocess self-terminates after 30s rather than hanging your whole test run.

## The mock's control surface

| Method          | Returns    | Purpose                                        |
|-----------------|------------|------------------------------------------------|
| `install()`     | `void`     | Create shim, prepend to `PATH`                 |
| `uninstall()`   | `void`     | Restore `PATH`, delete temp dir                |
| `onCall(r)`     | `void`     | Queue a `MockPiCall` response                  |
| `reset()`       | `void`     | Clear queue and counter (use between tests)    |
| `callCount()`   | `number`   | Number of times the mock `pi` was invoked      |
| `dir`           | `string`   | Temp directory path (read-only accessor)       |

Always call `install()` before queuing or running tests. Always call `uninstall()` (or rely on the exit handler) in cleanup. For multi-test files, `reset()` between tests so queued responses from one test don't leak into the next.

## The concurrency caveat (read this)

`createMockPi` is designed for **serial spawns within a single test**. Concurrency is intentionally limited:

- Responses are consumed in queue order from a shared file.
- If your extension spawns multiple `pi` subprocesses concurrently, responses may be consumed out of order — whichever spawned process grabs the queue first wins.

For tests of fan-out parallel patterns, this can produce flaky results. Workarounds:

1. **Run your test serial** at the extension level so only one subprocess is ever in flight.
2. **If your extension genuinely parallelizes**, the responses you queue should be order-independent (e.g., all return "ok") so order shuffling doesn't change the result.
3. **Long-term**: the harness tracks the addition of a grouped/batched call action that would let test authors assert by `toolCallId` rather than completion order. Not yet supported.

If true parallel-subprocess testing is the critical path for your extension, that's a known intentional gap — call it out in your extension's own test plan rather than fighting the mock.

## Choosing `createMockPi` vs `createTestSession`

| Diagnostic question                                          | Use                |
|--------------------------------------------------------------|--------------------|
| Does my extension's `execute()` produce the right output?    | `createTestSession`|
| Do my hooks fire / block correctly?                          | `createTestSession`|
| Does my extension load when installed from npm?              | `verifySandboxInstall` |
| **Does my extension handle the `pi` subprocess crashing?**   | **`createMockPi`** |
| **Does my extension parse `pi`'s JSONL streaming output?**   | **`createMockPi`** |
| **Does my extension react to files the subprocess wrote?**   | **`createMockPi`** |

`createMockPi` is the layer you reach for when your test questions are about the *subprocess integration* itself, not the agent loop running inside the child.

## Pitfalls

- **Forgetting `install()`**. Without it, `pi` resolves to your real system Pi (or fails to resolve), and your test doesn't exercise anything meaningful.
- **Queueing fewer responses than spawns**. The last response repeats — which can mask the case where you spawn N times but expect N distinct outputs. Always assert `callCount()`.
- **Forgetting `uninstall()` in cleanup**. The exit handler catches you, but leaving `PATH` modified during a test run can interfere with other tests. Use it.
- **Test flakiness from concurrent spawns**. See the concurrency caveat above.
