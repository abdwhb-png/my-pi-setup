# ADR-024: Unify Bash execution ownership and the Sandbox runtime contract

## Status

Accepted

## Date

2026-09-05

## Context

Bash behavior was split across the Sandbox and Safe Bash extension entrypoints.
Sandbox registered `bash` and `user_bash`, selected the local fallback, owned
Zerobox processes, and published Bash and analysis through separate brokers.
Safe Bash published a second global execution service that Think-in-Code used,
which also made Think inherit Safe Bash policy and telemetry ownership.

Pi evaluates extension entrypoints through separate Jiti module graphs. A
module singleton cannot coordinate these owners safely, and separately
published Bash and analysis services can expose a mixed generation during
reload or failed initialization.

## Decision

### Give one extension all Pi Bash surfaces

`agent/extensions/bash-execution/index.ts` is the only Pi entrypoint that
registers `bash`, `safe_bash`, and the `user_bash` hook. Its `safe-bash/`
submodule installs behavior into that owner and is not an autonomous extension.

When Sandbox is explicitly disabled, `bash-execution` chooses a local adapter.
Uninitialized and errored Sandbox states fail closed. Safe Bash keeps its
public names, renderers, compression, `replace`/`coexist` modes,
`/safe-bash`, and `/safe-bash-audit`.

### Publish one tagged Sandbox runtime atomically

`agent/extensions/_shared/sandbox-runtime/` publishes a single process-global
contract through `Symbol.for("pi.sandbox-runtime.v2")`:

```ts
type SandboxRuntimeSnapshot =
    | { state: "uninitialized" }
    | { state: "disabled" }
    | { state: "error" }
    | {
          state: "enabled";
          createBashOperations(options: SandboxBashOperationOptions): BashOperations;
          analysis: AnalysisSandboxPort;
      };
```

`claimSandboxRuntime`, `publishSandboxRuntime`, `getSandboxRuntime`, and
`releaseSandboxRuntime` use an owner token. A stale extension instance cannot
publish over or release the current instance. `enabled` publishes Bash and
analysis in one assignment. Error diagnostics remain private and bounded at
the public failure boundary.

Sandbox owns Zerobox configuration, probes, leases, analysis workers, runtime
state, `/sandbox`, `--no-sandbox`, and its widget. It registers no Bash tool or
hook and provides no local adapter.

### Share mechanism, inject policy

`agent/extensions/_shared/command-execution/` owns command inspection,
authorization flow, rewrites, execution, failure normalization, and process
supervision. Its factory receives policy, approvals, rewrite rules, telemetry,
and an operation resolver explicitly; it imports no concrete extension.

Safe Bash instantiates it with `safe_bash`. Think-in-Code instantiates it with
`think_execute | think_batch_execute`. Process tracking belongs to explicit
`createBashProcessSupervisor()` instances: Sandbox owns the Zerobox supervisor
and Bash Execution owns the local supervisor.

### Keep Think policy and telemetry independent

Think-in-Code loads only `thinkInCode.commandPolicy`; it never falls back to
`safeBash`. Missing danger groups deny. Its per-project redacted JSONL journal
lives under
`~/.pi/agent/think-in-code/projects/<project-hash>/telemetry/`, with `0700`
directories, `0600` files, 30-day retention, and a 10,000-character command
ceiling.

`/think-audit` reads only the current project, at most 30 days, 100 events, and
50,000 evidence characters. Its recommendation turn blocks every tool call.
Logging failures never affect command authorization and warn at most once per
session.

Safe Bash accepts historical schema-v1 records as `safe_bash` but ignores old
Think records. The one-time maintenance script removes only historical
`think_execute` and `think_batch_execute` lines from the Safe Bash journal,
with dry-run as the default and explicit `--apply` mutation.

### Make a clean cutover

The old Safe execution, Bash, and analysis brokers have no compatibility shim.
The new entrypoints and process-global symbol require a complete Pi restart;
`/reload` is not a migration mechanism for this change.

## Dependency direction

```text
bash-execution ─┬─> _shared/command-execution
                └─> _shared/sandbox-runtime

think-in-code ──┬─> _shared/command-execution
                └─> _shared/sandbox-runtime (contract only)

sandbox ────────┬─> _shared/sandbox-runtime (publisher)
                └─> _shared/command-execution (process primitives)
```

Think-in-Code never imports Safe Bash or the Sandbox implementation.
`_shared/command-execution` never imports any of the three extensions.

## Consequences

### Positive

- Every Pi Bash surface has one discoverable owner.
- Sandbox publication cannot expose mismatched Bash and analysis generations.
- Local fallback policy is explicit and cannot leak into Think-in-Code.
- Safe Bash and Think policy, approvals, telemetry, and audits evolve
  independently while reusing the same execution mechanism.
- Each extension cleans up only the processes it created.

### Negative

- A full restart is required at cutover and after changes to the global runtime
  contract.
- Two policy configurations must be maintained deliberately.
- Existing external imports of the deleted brokers break immediately.

## Superseded decisions

This ADR supersedes only the ownership portions of ADR-005, ADR-014, ADR-019,
and ADR-023. Their behavior, safety, storage, and historical validation records
remain evidence for the systems they describe.

## Verification

Validation evidence is recorded in
`docs/verification/bash-execution-architecture-2026-09-05.md`.
