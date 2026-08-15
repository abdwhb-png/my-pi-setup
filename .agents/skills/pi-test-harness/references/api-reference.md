# API reference

Type definitions and the event-collection API for `@abdwhb-png/pi-test-harness` v0.7.0 (Pi 0.83.x). Use this as a reference when authoring assertions or tracing through snippets.

## Table of contents

- [API reference](#api-reference)
  - [Table of contents](#table-of-contents)
  - [Entry points](#entry-points)
  - [`createTestSession(options?)`](#createtestsessionoptions)
  - [`TestSession`](#testsession)
    - [`run(...turns)`](#runturns)
    - [`events`](#events)
    - [`playbook`](#playbook)
    - [`dispose()`](#dispose)
  - [`TestEvents`](#testevents)
    - [Method cheatsheet](#method-cheatsheet)
    - [Additional accessors](#additional-accessors)
    - [UI method names](#ui-method-names)
  - [`ToolCallRecord`](#toolcallrecord)
    - [Reading it](#reading-it)
    - [Pairing calls with results](#pairing-calls-with-results)
    - [Asserting on blocks](#asserting-on-blocks)
  - [`ToolResultRecord`](#toolresultrecord)
    - [Reading it](#reading-it-1)
    - [`.mocked` vs `.isError`](#mocked-vs-iserror)
  - [`UICallRecord`](#uicallrecord)
    - [Reading it](#reading-it-2)
    - [Reading bodies safely](#reading-bodies-safely)
  - [`MockToolHandler`](#mocktoolhandler)
  - [`MockUIConfig`](#mockuiconfig)
  - [`verifySandboxInstall(options)`](#verifysandboxinstalloptions)
  - [`createMockPi()`](#createmockpi)
  - [`MockPiCall`](#mockpicall)
  - [`MockPi`](#mockpi)
  - [`ToolBlockedError`](#toolblockederror)
  - [`safeRmSync(filePath)`](#safermsyncfilepath)

---

## Entry points

The package's top-level exports are:

```typescript
import {
  // Session testing
  createTestSession,
  // Playbook builders
  when, calls, says,
  // Sandbox / subprocess
  verifySandboxInstall,
  createMockPi,
  // Errors and helpers
  ToolBlockedError,
  safeRmSync,
  // Types (type-only)
  type TestSession,
  type ToolResultRecord,
  type MockToolHandler,
  type MockUIConfig,
  type MockPi,
  type MockPiCall,
  type Turn,
} from "@abdwhb-png/pi-test-harness";
```

The three playbook builders (`when`, `calls`, `says`) are covered in depth in `playbook-dsl.md`; this file documents the rest.

---

## `createTestSession(options?)`

Creates a test session with a real Pi environment.

```typescript
function createTestSession(options?: TestSessionOptions): Promise<TestSession>;
```

| Option               | Type                              | Default       | Notes                                               |
| -------------------- | --------------------------------- | ------------- | --------------------------------------------------- |
| `extensions`         | `string[]`                        | `[]`          | Extension file paths to load (via real jiti)        |
| `extensionFactories` | `Function[]`                      | `[]`          | Inline extension factory functions (no file needed) |
| `cwd`                | `string`                          | auto temp dir | Working directory (auto-cleanup on `dispose()`)     |
| `systemPrompt`       | `string`                          | (default)     | Override the system prompt                          |
| `mockTools`          | `Record<string, MockToolHandler>` | —             | Tool execution interceptors (see `mock-tools.md`)   |
| `mockUI`             | `MockUIConfig`                    | defaults      | UI mock configuration (see `mock-ui.md`)            |
| `propagateErrors`    | `boolean`                         | `true`        | If true, real tool errors abort the test            |

Returns `Promise<TestSession>`.

---

## `TestSession`

The session object returned by `createTestSession`.

```typescript
interface TestSession {
  run(...turns: Turn[]): Promise<void>;
  session: AgentSession;          // the real Pi session underneath
  cwd: string;                    // working directory
  events: TestEvents;             // all collected events
  playbook: { consumed: number; remaining: number };
  dispose(): void;                // cleanup temp dir and session
}
```

### `run(...turns)`

Runs the conversation script. Each turn is the output of `when(prompt, actions)` from the playbook DSL.

```typescript
await t.run(
  when("Prompt A", [calls("tool", {...}), says("...")]),
  when("Prompt B", [calls("tool", {...}), says("...")]),
);
```

`run` is async; resolve it before asserting on `t.events`.

### `events`

See [`TestEvents`](#testevents) below.

### `playbook`

After `run()`, you can inspect how much of the script was consumed:

- `consumed`: number of actions the agent loop pulled from the playbook.
- `remaining`: number of actions still queued.

If `remaining > 0`, the harness will also throw a diagnostic — see "Playbook not fully consumed" in `playbook-dsl.md`. This field is mostly useful for debugging mid-test where you'd want to assert `remaining === 0`.

### `dispose()`

Cleans up the session resources and (if auto-generated) the temp `cwd`. Always call in `afterEach`. Note that `dispose()` does **not** fire `session_shutdown` — that event fires on process exit. See `safeRmSync` for why this matters on Windows.

---

## `TestEvents`

The collected-event accessor. Every tool call, tool result, UI interaction, and message flows through here.

```typescript
interface TestEvents {
  // Tool interactions
  toolCallsFor(name: string): ToolCallRecord[];
  toolResultsFor(name: string): ToolResultRecord[];
  blockedCalls(): ToolCallRecord[];  // subset of toolCallsFor where blocked === true

  // UI interactions
  uiCallsFor(name: UIMethodName): UICallRecord[];

  // Raw history
  messages: AgentMessage[];
  all: AgentSessionEvent[];
}
```

### Method cheatsheet

| Method                   | Returns               | Purpose                                                     |
| ------------------------ | --------------------- | ----------------------------------------------------------- |
| `toolCallsFor("bash")`   | `ToolCallRecord[]`    | All invocations of `bash`                                   |
| `toolResultsFor("bash")` | `ToolResultRecord[]`  | All results returned by `bash` (real or mocked)             |
| `blockedCalls()`         | `ToolCallRecord[]`    | Calls blocked by extension hooks (where `blocked === true`) |
| `uiCallsFor("confirm")`  | `UICallRecord[]`      | All calls to that UI method                                 |
| `messages`               | `AgentMessage[]`      | The conversation history                                    |
| `all`                    | `AgentSessionEvent[]` | Every event, in order                                       |

### Additional accessors

`TestEvents` also exposes:

```typescript
toolSequence(): string[];     // ordered list of tool names as they were called
```

Useful when the *order* of tool invocations matters more than their params, e.g. asserting your extension always calls `plan_mode` before `plan_propose`.

### UI method names

Pass any of these to `uiCallsFor`:

- `"confirm"`
- `"select"`
- `"input"`
- `"editor"`
- `"notify"`

---

## `ToolCallRecord`

The shape returned by `t.events.toolCallsFor(name)`. Use it when you want to assert *what was asked*, not what came back — that goes through [`ToolResultRecord`](#toolresultrecord). Also returned by `blockedCalls()`.

```typescript
interface ToolCallRecord {
  step: number;                              // playbook step index
  toolName: string;
  input: Record<string, unknown>;           // the params object from calls(tool, params)
  blocked: boolean;                          // true if an extension hook blocked this call
  blockReason?: string;                      // the reason string if blocked
}
```

**Source**: verified against `dist/types.d.ts` in v0.7.0. Note the field is `input` (not `params`); it carries the params you passed via `calls(tool, params)`. There is no `toolCallId` on `ToolCallRecord` — pair with results by index (e.g. `toolCallsFor(name)[i]` ↔ `toolResultsFor(name)[i]`) since both arrays are in call order.

### Reading it

```typescript
const bashCalls = t.events.toolCallsFor("bash");
expect(bashCalls).toHaveLength(1);

const c = bashCalls[0];
expect(c.toolName).toBe("bash");
expect(c.input).toEqual({ command: "ls -la" });
expect(c.blocked).toBe(false);              // no hook blocked
```

### Pairing calls with results

Pair `toolCallsFor(name)` with `toolResultsFor(name)` by index — both arrays are in call order:

```typescript
const call = t.events.toolCallsFor("summarize_doc")[0];
const result = t.events.toolResultsFor("summarize_doc")[0];

expect(call.input).toEqual({ path: "README.md" });
expect(result.mocked).toBe(false);          // extension's real code ran
```

### Asserting on blocks

`ToolCallRecord.blocked` + `blockReason` (since v0.5.0) are the canonical way to assert a hook did the blocking. `blockedCalls()` returns the subset where `blocked === true`:

```typescript
await t.run(when("Try write", [calls("bash", { command: "rm -rf /" }), says("Done.")]));

const blocked = t.events.blockedCalls();
expect(blocked).toHaveLength(1);
expect(blocked[0].toolName).toBe("bash");
expect(blocked[0].blocked).toBe(true);
expect(blocked[0].blockReason).toBeTruthy();
```

This is the lower-friction alternative to catching `ToolBlockedError` — see `mock-tools.md` for when to prefer each.

---

## `ToolResultRecord`

The primary shape you'll assert on for tool results.

```typescript
interface ToolResultRecord {
  step: number;                              // playbook step index
  toolName: string;
  toolCallId: string;
  text: string;                              // concatenated text content
  content: Array<{ type: string; text?: string }>;
  isError: boolean;
  details?: unknown;                         // optional details object (mock-provided or real)
  mocked: boolean;                           // true if mockTools handled it
}
```

**Source**: verified against `dist/types.d.ts` in v0.7.0.

### Reading it

```typescript
const bashResults = t.events.toolResultsFor("bash");
expect(bashResults).toHaveLength(1);

const r = bashResults[0];
expect(r.mocked).toBe(true);                 // mockTools handled this one
expect(r.isError).toBe(false);               // no error
expect(r.text).toContain("file1.txt");       // text content
expect(r.step).toBe(0);                      // first playbook step
```

### `.mocked` vs `.isError`

- `.mocked === true` → the mock handler produced this result. Hooks still fired, but no real tool code ran.
- `.isError === true` → the result is an error (either produced by the extension hook blocking the call, or captured from a real tool throw when `propagateErrors: false`).

---

## `UICallRecord`

The shape returned by `t.events.uiCallsFor(method)`. Note: there is no `step` or `title` field — `args` carries the positional arguments (typically `[title, messageOrItemsOrPlaceholder]` depending on method).

```typescript
interface UICallRecord {
  method: string;                            // "confirm" | "select" | "input" | "editor" | "notify"
  args: unknown[];                           // positional args the extension passed
  returnValue?: unknown;                     // what the mock returned (omitted for outbound-only methods)
}
```

**Source**: verified against `dist/types.d.ts` in v0.7.0. `notify` calls are recorded here too — `returnValue` is typically omitted for outbound methods.

### Reading it

```typescript
const confirms = t.events.uiCallsFor("confirm");
expect(confirms).toHaveLength(1);

const c = confirms[0];
expect(c.method).toBe("confirm");
expect(c.args[0]).toContain("Delete");      // args[0] is typically the title
expect(c.returnValue).toBe(false);          // what the user (mock) answered

// `notify` is outbound-only and not in MockUIConfig, but it IS recorded —
// so uiCallsFor("notify") is the canonical way to assert "the user saw X".
const notifies = t.events.uiCallsFor("notify");
expect(notifies).toHaveLength(1);
expect(JSON.stringify(notifies[0].args)).toContain("Plan approved");
```

### Reading bodies safely

The `notify` body lives in `args` (positional, no pinned shape beyond method). Stringify the whole record if your assertion is substring-based and you don't want to commit to a specific arg index:

```typescript
const text = JSON.stringify(t.events.uiCallsFor("notify"));
expect(text).not.toMatch(/agent crashed/i);  // raw stderr never leaks
expect(text).toMatch(/couldn't|unable|sorry/i); // friendly message present
```

---

## `MockToolHandler`

```typescript
type MockToolHandler =
  | string
  | ToolResult
  | ((params: Record<string, unknown>) => string | ToolResult);
```

| Variant      | Returns                                        | Use case                            |
| ------------ | ---------------------------------------------- | ----------------------------------- |
| `string`     | `{ content: [{ type: "text", text: "..." }] }` | Static, canned response             |
| `ToolResult` | (the object itself)                            | Precise control of content/details  |
| function     | `string` or `ToolResult` (resolved per call)   | Dynamic, params-dependent responses |

The function form receives `Record<string, unknown>` — cast or narrow as needed for your test.

---

## `MockUIConfig`

```typescript
interface MockUIConfig {
  confirm?: boolean | ((title: string, message: string) => boolean);
  select?: number | string | ((title: string, items: string[]) => string | undefined);
  input?: string | ((title: string, placeholder?: string) => string | undefined);
  editor?: string | ((title: string, prefilled?: string) => string | undefined);
}
```

Each field accepts a static value (same for every call) or a dynamic function (computed per call). Defaults when no `mockUI` is provided: `confirm → true`, `select → 0`, `input → ""`, `editor → ""`.

See `mock-ui.md` for the full behavior table and when to override defaults.

---

## `verifySandboxInstall(options)`

```typescript
function verifySandboxInstall(options: SandboxInstallOptions): Promise<SandboxInstallResult>;
```

| Option              | Type                              | Required | Purpose                                |
| ------------------- | --------------------------------- | -------- | -------------------------------------- |
| `packageDir`        | `string`                          | yes      | Package directory (must have pkg.json) |
| `expect.extensions` | `number`                          | —        | Expected extension count               |
| `expect.tools`      | `string[]`                        | —        | Required tool names                    |
| `expect.skills`     | `number`                          | —        | Expected skill count                   |
| `smoke.mockTools`   | `Record<string, MockToolHandler>` | —        | Mock tools for the smoke test          |
| `smoke.script`      | `Turn[]`                          | —        | Playbook turns for the smoke test      |

Returns `{ loaded, smoke? }` — `loaded` includes `extensionErrors`, `tools`, `extensions`, `skills`; `smoke` (if configured) exposes the `TestEvents` API for the in-sandbox run. See `sandbox-install.md`.

---

## `createMockPi()`

```typescript
function createMockPi(): MockPi;
```

Returns a `MockPi` instance. Doesn't install anything until `.install()` is called. See `mock-pi-cli.md` for lifecycle and response shapes.

---

## `MockPiCall`

Response object accepted by `MockPi.onCall(response)`.

```typescript
interface MockPiCall {
  output?: string;                        // default: echo of task text
  exitCode?: number;                      // default: 0
  stderr?: string;                        // default: empty
  delay?: number;                         // default: 0 (ms)
  jsonl?: object[];                       // default: none — replaces default event
  writeFiles?: Record<string, string>;    // default: none
}
```

All fields optional. Key-validated at `onCall` time — typos like `{ ouptut: "..." }` throw.

---

## `MockPi`

```typescript
interface MockPi {
  install(): void;            // create shim, prepend to PATH
  uninstall(): void;          // restore PATH, delete temp dir
  onCall(response: MockPiCall): void;   // queue one response
  reset(): void;              // clear queue and counter
  callCount(): number;        // number of times mock pi was invoked
  readonly dir: string;       // temp directory path
}
```

---

## `ToolBlockedError`

Exported for source compatibility with upstream consumers, but **not promised** by normal Pi 0.83 runs through `AgentSession`. The canonical block signal is the event records: `blocked: true`/`blockReason` on the `ToolCallRecord` and `isError: true` + result text on the `ToolResultRecord` — assert those instead.

```typescript
import {
  createTestSession, when, calls, says,
} from "@abdwhb-png/pi-test-harness";

const t = await createTestSession({ mockTools: { bash: "ok" } });
await t.run(when("Try write", [calls("bash", { command: "rm -rf /" }), says("Done.")]));

const call = t.events.toolCallsFor("bash")[0];
expect(call.blocked).toBe(true);
expect(call.blockReason).toMatch(/blocked/i);
const result = t.events.toolResultsFor("bash")[0];
expect(result.isError).toBe(true);
```

Do not rely on `instanceof ToolBlockedError` to detect a hook block from a normal Pi 0.83 run. See `mock-tools.md` for the event-assertion patterns.

---

## `safeRmSync(filePath)`

```typescript
function safeRmSync(filePath: string): void;
```

Removes a file, swallowing `EPERM` and `EBUSY` errors only. All other errors propagate.

Use it in `afterEach` on Windows when an extension opened a SQLite database in `session_start` (memory, brainiac, etc.) and `session.dispose()` doesn't release the file lock (because `session_shutdown` only fires on process exit).

```typescript
import { safeRmSync } from "@abdwhb-png/pi-test-harness";

let dbPath: string;

afterEach(() => {
  t?.dispose();                 // dispose first
  safeRmSync(dbPath);
  safeRmSync(dbPath + "-wal");
  safeRmSync(dbPath + "-shm");
});
```

For isolation across tests, give each one a unique DB path (typically `mkdtempSync` + test name). Files get cleaned by the OS at process exit; this is just about avoiding `EPERM` mid-suite.
