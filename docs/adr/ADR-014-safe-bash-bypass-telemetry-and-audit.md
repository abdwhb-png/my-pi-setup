# ADR-014: Safe-bash bypass telemetry and recommendation audit

> **Ownership update (2026-09-05)**: [ADR-024](./ADR-024-bash-execution-ownership-and-sandbox-runtime.md)
> supersedes the shared-service ownership and mixed Think telemetry portions.
> Safe Bash retains its guard policy, `safe_bash` events, and
> `/safe-bash-audit`; Think now owns a separate policy and journal.

## Status

Accepted

## Date

2026-08-25

## Context

`safe_bash` blocked a direct `rm` command, after which the model retried deletion through a Python one-liner using `shutil.rmtree` and `Path.unlink`. Existing `exec-injection` checks covered interpreter calls that launch shell processes, such as `os.system` and Node `child_process.exec`, but not direct filesystem APIs.

Adding the observed signatures fixes one bypass family but does not reveal later evasions. Useful evidence must survive the session and be reviewable without silently teaching the model to rewrite its own guard. Command text can contain secrets, so raw unrestricted logging is unacceptable.

Original scope did not alter Bash availability, `safeBash.mode`, `allowDangerous`, or `pi-dangerous-mode` policy. A later amendment below replaces `allowDangerous` and unifies Bash execution with the sandbox extension.

## Decision

### Add structured danger inspection

Shared Bash guard exposes a structured match containing group ID, label, pattern ID, normalized command, and existing block message. `isDangerous()` remains a compatibility wrapper.

New `file-delete-api` group blocks direct deletion APIs in Python, Node, Perl, and Ruby one-liners, including Python heredoc stdin. Read-only one-liners and ordinary script execution remain unchanged. The group participates in `guardPolicy` semantics described below.

### Add per-group guard policy and shared sandbox execution

`safeBash.guardPolicy` maps danger-group IDs to `deny`, `ask`, or `allow`. Missing groups default to `deny`. Every matching group is evaluated, so one `allow` cannot bypass another matching group's policy. Interactive `ask` supports allow once, allow the exact normalized command for the session, deny, and deny with a reason. Non-interactive `ask` denies. `allowDangerous` is removed and ignored.

The sandbox extension owns a process-global execution broker used by registered `bash`, `safe_bash`, and interactive user Bash. Enabled state creates sandboxed operations. Explicit `/sandbox off` or `--no-sandbox` state creates local operations. Missing, uninitialized, unsupported, and failed states fail closed. Owner tokens prevent stale extension instances from overwriting or clearing current broker state.

`safeBash.mode` remains independent: `replace` disables raw `bash`; `coexist` exposes both tools through the shared execution broker.

### Record local redacted attempt telemetry

`safe_bash` records one outcome event for each guarded, redirected, successful, failed, or aborted attempt after session telemetry initializes. Events use versioned JSONL and include correlation IDs, project path, sequence, decision, outcome, command length, optional redacted command, and optional guard evidence.

Storage defaults:

- `~/.pi/agent/safe-bash-telemetry/YYYY-MM-DD/<session-id>.jsonl`;
- `0700` directories and `0600` files;
- 30-day retention;
- ordered append per session;
- symlink-safe reads and cleanup;
- bounded command and error strings;
- shared deterministic secret redaction;
- no network egress.

Telemetry is fail-open. Write, flush, or retention errors cannot change command enforcement or execution. Interactive sessions receive a bounded warning.

### Add `/safe-bash-audit`

`/safe-bash-audit [days=N] [limit=N]` reads current project's recent telemetry. Defaults are 30 days and 100 events, with hard caps of 365 days and 500 events.

Evidence ranking prioritizes blocked events, interpreter/deletion-looking allowed events, and attempts immediately following blocks. Every command is redacted again and display-bounded before entering model context. Prompt requires event citations, separation of confirmed blocks from suspected bypasses, precise pattern and regression-test recommendations, false-positive analysis, and explicit reporting of insufficient evidence.

Audit is recommendation-only. It must not edit files, execute commands, or modify guard rules automatically.

## Alternatives Considered

### Block every interpreter one-liner

Rejected. It would prevent legitimate read-only inspection and project tooling, creating broad false positives.

### Store only hashes and extracted features

Rejected for this local opt-out-capable telemetry. Hashes correlate repeats but omit syntax needed to recommend precise guard improvements. Redacted bounded command capture provides more diagnostic value.

### Store unredacted commands

Rejected. Shell commands commonly contain credentials, tokens, cookies, URLs, and private paths. Best-effort redaction does not eliminate sensitivity, but unrestricted raw capture is worse.

### Let audit update rules automatically

Rejected. Model-generated patterns can overblock valid work or create new gaps. A human must review recommendations and accompanying regression tests.

### Claim pattern matching as a security boundary

Rejected. Alternate tools, encodings, binaries, scripts, and runtime behavior can bypass lexical checks. Shared OS-level isolation now reduces impact for Bash execution, but guard matching remains policy and telemetry, not a security boundary.

## Consequences

### Positive

- Supplied Python deletion bypass is blocked before execution.
- Guard matches provide stable structured evidence for telemetry and tests.
- Future suspicious retries remain available for bounded, project-scoped review.
- Audit recommendations cite evidence and cannot silently mutate policy.
- `safeBash.mode` and dangerous-mode configuration remain untouched.
- Both Bash tools share sandbox state and fail closed when that state is unavailable.
- Guard exceptions become explicit `ask`, `deny`, or `allow` policy.

### Negative

- Local command telemetry remains sensitive despite redaction.
- Same-user processes can tamper with the archive.
- Pattern coverage requires maintenance and can produce false positives.
- `allow` remains a deliberate bypass of one lexical guard group, though sandbox execution still applies when enabled.
- `coexist` intentionally exposes sandboxed but unguarded raw `bash`.
- Recording after execution means a process crash can lose an allowed attempt's outcome event.

## Verification

1. RED test reproduces supplied `shutil.rmtree` and `Path.unlink` bypass.
2. Guard tests cover Python, Node, Perl, and Ruby deletion APIs plus benign read-only one-liners.
3. Storage tests cover ordering, permissions, project/date filtering, malformed lines, retention, and symlink skipping.
4. Recorder tests cover redaction, structured block evidence, policy blocks, and fail-open writes.
5. Audit tests cover bounded argument parsing, evidence ordering, recommendation-only prompt, project filtering, and no-data behavior.
6. Extension integration test proves blocked and successful commands emit telemetry without changing execution behavior.
7. Guard-policy tests cover default deny, allow, interactive ask choices, exact-command session approval, and non-interactive denial.
8. Broker tests cover enabled, explicit disabled, uninitialized, error, and stale-owner states.
9. Sandbox and safe-bash integration tests prove both tools use shared execution and unavailable state fails closed.
10. Final gates run focused and full Bun tests, LSP diagnostics, typecheck, lint, format check, and parse check.
