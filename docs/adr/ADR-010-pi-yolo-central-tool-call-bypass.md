# ADR-010: Centralized Pi YOLO tool-call bypass

## Status

Accepted

## Date

2026-07-30

## Context

Pi currently has multiple extensions that can block a `tool_call`, including
permission checks, safe-bash routing, slow-mode review, role restrictions, and
brainstorm-forcer phase control. A YOLO session must run autonomously without
requiring user interaction for those non-protected guards.

Pi dispatches `tool_call` handlers in extension load order. The first handler
that returns `{ block: true }` stops the dispatch. Therefore, an ordinary
extension loaded after a blocker cannot override or undo the block.

Modifying every blocking extension would duplicate policy, create an ongoing
maintenance burden, and fail to cover future blockers. Pi-subagents avoids
ambient blockers for child processes through `--no-extensions` and explicit
allowlists, but that does not solve a parent session started as `pi --yolo`.

The active CLI reports version `0.82.1`, while the resolved local
`@earendil-works/pi-coding-agent` package reports `0.81.1`. The design must not
base compatibility on either version number.

## Decision

### Patch the runner once, centrally

Create one local `pi-yolo` extension that installs an idempotent wrapper around
the public `ExtensionRunner.prototype.emitToolCall` export. The wrapper is the
single central enforcement point for YOLO bypass. No individual blocking
extension is modified.

When YOLO is disabled, the wrapper delegates directly to Pi's original method.
When enabled, it reproduces Pi's handler loop but skips the `tool_call`
handlers belonging to unprotected extensions before they execute. Skipped
handlers cannot open a prompt or return a block. The actual tool execution
pipeline and `event.input` remain unchanged.

For handlers that are allowed to run, normal Pi behavior remains intact:
handler order is preserved and the first `{ block: true }` still stops the
dispatch.

### Define explicit protected exceptions

The extension loads a global and project-local configuration:

- `~/.pi/agent/pi-yolo.json`
- `<cwd>/.pi/pi-yolo.json`

```json
{
  "protectedTools": [],
  "protectedExtensions": []
}
```

Both lists accept exact matches and `*` globs.

- If a tool matches `protectedTools`, every `tool_call` handler executes
  normally for that call.
- If an extension matches `protectedExtensions`, its handler executes normally
  for every call.
- Extension matching supports a full extension path and path segments, such as
  `brainstorm-forcer` or `*pi-permission-system*`.

The defaults intentionally protect nothing. `brainstorm-forcer` can be made
strict for a specific user or project by adding it to `protectedExtensions`.

Existing configuration files are strict trust-boundary input: each must be a
JSON object and every declared protection list must contain only non-empty
strings. Invalid JSON, roots, or entries disable YOLO for that session and
produce an explicit diagnostic; they never silently erase protections.

### Own the general YOLO interface

`pi-yolo` exclusively registers:

- `--yolo`
- `/yolo on`
- `/yolo off`
- `/yolo status`

The active state is session-only. It does not edit permission-system policy
files and therefore cannot leave a persistent yolo setting, race with another
session, or need rollback on shutdown. A `/yolo off` override remains effective
through `/reload`, even when the session began with `--yolo`; a new, resumed,
or forked session clears that override and again follows its CLI flag.

`pi-permission-system-addons` relinquishes the `--yolo` flag and `/yolo`
command. It provides `--yolo-permission` and `/yolo-permission on|off|status`
instead; no action is implicit and `toggle` is unsupported. That specialized
mode preserves its existing `ask → allow` behavior independently of central
YOLO bypass.

### Feature-detect runtime compatibility

The patch must verify runtime capabilities instead of asserting a Pi version:

- a runtime `ExtensionRunner` constructor read from the module namespace;
- callable `emitToolCall` and `createContext` prototype methods;
- an iterable extension collection with handler maps at first dispatch.

If verification fails, YOLO is disabled and the user receives an explicit
diagnostic. The extension must not claim success or deliver a partial bypass.

Use `Symbol.for(...)` state on `globalThis` to record the original method,
active policy, and installation state. Reloading extensions must update policy
without stacking wrappers.

## Alternatives Considered

### Modify every blocker

Rejected. Each extension would require a new local condition, third-party
extensions would remain uncovered, and future handlers would repeat the same
work.

### Add a native Pi-core hook

Architecturally cleaner, but rejected for this change. It would require
maintaining a Pi fork or upstream patch. The requested solution is an extension
patch with an explicit compatibility boundary.

### Launch `pi --no-extensions`

Rejected for the parent session. It removes useful extensions together with
blockers and only mirrors the child-process isolation strategy already used by
pi-subagents.

### Let `pi-permission-system` own all YOLO behavior

Rejected. It can only control its own permission decisions and cannot bypass
other extension handlers.

## Consequences

### Positive

- One extension owns all YOLO bypass policy.
- Existing and future non-protected `tool_call` blockers are bypassed without
  edits to their implementations.
- Protected tools and workflow extensions retain their normal safety behavior.
- The mechanism has no persistent policy mutation.

### Negative

- The wrapper depends on the runner's currently private extension collection.
- Non-protected handlers are skipped entirely, including any useful
  non-blocking side effect they might have. Such extensions must be declared in
  `protectedExtensions`.

### Risks and mitigation

A Pi runtime change may invalidate the wrapper. Capability detection fails
closed with a clear diagnostic. Tests exercise observable dispatch behavior and
idempotence against the package resolved at runtime, not against a guessed
version.

## Verification

Test coverage must prove:

1. exact and glob matching for protected tools and extensions;
2. global/project configuration resolution and malformed input handling;
3. unchanged Pi dispatch when YOLO is off;
4. skipped unprotected handlers when YOLO is on;
5. normal execution and possible blocking for protected tools/extensions;
6. preserved order and first-block behavior among protected handlers;
7. idempotent patch installation across reloads;
8. explicit refusal when required runtime capabilities are absent;
9. non-conflicting `--yolo` and `--yolo-permission` registrations.

Final verification includes focused Bun tests, LSP diagnostics, typecheck,
lint, and the full suite. The installed `pi-test-harness` 0.6.1 imports the
removed `pi-ai` export `getModel`, so runner behavior is tested directly through
the public `ExtensionRunner` rather than by mocking that incompatible package.
The runner tests cover one bypassed fixture blocker and one protected fixture
blocker without requiring a model request.
