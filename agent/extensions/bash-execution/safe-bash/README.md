# safe-bash

`safe_bash` is the policy submodule of the `bash-execution` extension. It adds
dangerous-command policy before resolving Bash operations through the shared
Sandbox runtime contract and records local, redacted attempt telemetry for
later review. It exports installation functions and is not a Pi extension
entrypoint.

Select Zerobox with `/sandbox mode sandbox`, or select globally authorized host
execution with `/sandbox mode host`. Use ordinary commands through the same
route as `bash`. Legacy `hostCapability` parameters are rejected before launch.
Keep the `command` argument on the `pi-permission-system` Bash surface and apply
every Safe Bash guard before dispatch. Preserve the strict Think environment
independently of shell mode. See [the mode contract](../../sandbox/docs/shell-capabilities.md).

In sandbox mode, Safe Bash receives the same private `/__zerobox/runtime` shell as `bash`; it does not inherit host PATH or environment values. A selected global installation can add only its authorized read-only roots and declared command directories. Safe Bash checks remain in front of this route and do not become installation permissions.

Both shell tools share stable presentation and execution guidance. Current
sandbox facts and Safe Bash checks appear in a temporary system-prompt block
for each provider request, without adding a conversation message.
Per-tool rewrites and additional Safe Bash checks remain independent. See the
[design and validation record](../../../../docs/brainstorming/2026-09-12-shared-shell-context-design.md).

Pattern matching cannot prove a command harmless, and processes running as the same OS user can modify local telemetry.

## Deletion API guard

Danger group `file-delete-api` blocks direct filesystem deletion APIs inside interpreter one-liners, including:

- Python `shutil.rmtree`, `Path.unlink`/`rmdir`, and `os.remove`/`unlink`/`rmdir`;
- Node `fs.rm`/`rmSync`, `unlink`/`unlinkSync`, and `rmdir`/`rmdirSync`;
- Perl `unlink`/`rmdir`;
- Ruby `FileUtils.rm_rf`, `File.delete`/`unlink`, and `Dir.rmdir`.

Python deletion calls supplied through heredoc stdin are also detected. Ordinary scripts and read-only interpreter one-liners remain allowed unless another danger group matches.

## chmod scope guard

Danger group `chmod` matches every `chmod` invocation and decides by resolved target and mode rather than by syntax. The group defaults to `cwd-only` via the shared `DEFAULT_DANGER_GROUP_POLICY`, so in-cwd benign modes run and everything else blocks:

- **inside `cwd`**: allowed when the mode is benign (`755`, `644`, `+x`, `u+rwx,g-w`).
- **outside `cwd`**: blocked, including relative spellings that escape (`chmod +x ../other/tool`) and `~` targets.
- **protected root**: blocked even when `cwd` is inside it. Defaults are `~/.pi` plus `/etc`, `/usr`, `/bin`, `/sbin`, `/lib`, `/boot`, `/var`.
- **symlink target**: blocked. `chmod` follows a symlink argument and changes the mode of the file it points at, so a link is never a project-scoped permission change.
- **catastrophic mode**: blocked anywhere — other-write (`777`, `666`, `o+w`, `a+w`), setuid/setgid (`4755`, `u+s`).
- **unresolvable**: blocked, with a reason naming the failure. Variables, globs, and backticks cannot be resolved statically, and `chmod --reference=…` copies bits that are not visible here.

Mode and target are parsed, not pattern-matched, so symbolic modes, `-R`, `--` separators, `0o755`, and relative paths cannot spell around the check.

Resolution limits, stated so they are not mistaken for guarantees:

- Only the final target component is inspected. A symlinked **parent** directory is not resolved, so `chmod 755 linkdir/file` stays lexically inside `cwd` even when `linkdir` points elsewhere.
- Containment is lexical (`resolvePath`), not `realpath`.
- A path the guard cannot `stat` keeps the lexical verdict: `chmod` could not act on it either.

The asymmetry with `rm` is deliberate: `rm` unlinks a symlink rather than following it, so `inspectDeleteScope` stays purely lexical.

Example: from `~/.pi`, `chmod +x bin/pi-fork` and `chmod 755 /home/<user>/.pi/bin/pi-fork` are both blocked because the target resolves under a protected root.

## Guard policy

Configure each danger group under `safeBash.guardPolicy`:

```json
{
    "safeBash": {
        "guardPolicy": {
            "sudo": "allow",
            "rm": "ask",
            "file-delete-api": "deny"
        }
    }
}
```

Actions:

- `deny`: block. This is the default for missing groups.
- `ask`: interactive choice to allow once, allow the exact normalized command for the session, deny, or deny with a reason. Non-interactive sessions deny.
- `allow`: execute without prompting while preserving telemetry guard evidence.
- `cwd-only`: allow only when the command's resolvable targets stay lexically inside the session working directory (`ctx.cwd`) and avoid the chmod-specific checks above. An unresolvable target (variable, glob, backtick, bare `rm`) or any target outside `cwd` blocks with a reason naming the offending path. Supported for `rm`, `file-delete-api`, and `chmod`; other groups fail closed to `unknown`.

`chmod` ships with `cwd-only` as its code default, taken from the shared `DEFAULT_DANGER_GROUP_POLICY` in [`_shared/command-execution/policy.ts`](../_shared/command-execution/policy.ts)<!-- markdown-links: missing /home/abdwhb/.pi/agent/extensions/bash-execution/_shared/command-execution/policy.ts -->. `think-in-code` starts from the same constant for its own `commandPolicy.guardPolicy`, so a scope-decided group is never blanket-denied by one consumer and scoped by another. Setting `safeBash.guardPolicy.chmod` to `deny` blocks every `chmod` invocation, and `allow` skips the scope checks entirely.

Every matching group is evaluated, so allowing one group cannot bypass another matching group's `ask` or `deny` policy.

The description and `promptSnippet` stay stable. Before each model request, the shared context reports current tool availability (`replace/coexist`), per-group `allow`/`ask`/`cwd-only`/`deny(default)`, `AllowedShell` native-redirect exceptions, and `native-redirect` status. These facts appear only while `safe_bash` is active. Use `/safe-bash reload` to reload its guard configuration and `/safe-bash status` to inspect the same summary. Selecting tool availability does not change sandbox/host execution mode.

`allowDangerous` is removed and ignored. `safeBash.mode` remains unchanged: `replace` removes raw `bash`, while `coexist` exposes both tools.

### Global default with project override

Setting `cwd-only` in the global `settings.json` makes in-cwd deletes the default for every project; a project `settings.json` under the same `safeBash.guardPolicy` key overrides it per group (project settings win over global):

```json
{
    "safeBash": {
        "guardPolicy": {
            "sudo": "allow",
            "rm": "cwd-only",
            "file-delete-api": "cwd-only"
        }
    }
}
```

## Allowed shell commands

Configure under `safeBash.allowedShellCommands`:

```json
{
    "safeBash": {
        "allowedShellCommands": ["grep", "find"]
    }
}
```

Purpose: bypass **native-tool redirection only**. `isDangerous()` and every guard group still run on these commands, so this is not a guard allow.

Accepted values are a closed set — the shell commands that have a native Pi tool equivalent: `grep`, `rg`, `find`, `fd`, `ls`, `ack`, `ag`. They map to the native tools `grep`, `find`, and `ls`. The type is `AllowedShellCommand[]`, defined once in [`_shared/command-execution/guard.ts`](../_shared/command-execution/guard.ts) next to the redirect map.

Matching is by first word of the normalized command, exact match: no prefixes, no arguments, no case folding, and no leading `sudo`. `"grep -r"`, `"Grep"`, and `"sudo grep"` never match this list. Only the listed commands are redirected in the first place, so a command such as `sudo grep …` passes through whether or not it appears here. Entries outside the set are dropped during config normalization, so a typo silently removes the bypass rather than widening it.

The list applies only while native-tool redirection is enforced (standard profile). In relaxed profiles redirection is already off and the list has no effect.

Verify with `/safe-bash status`, or read the `AllowedShell (native-redirect exceptions): bypass=[…]` line in the temporary system-prompt block.

## Telemetry configuration

Configure under `safeBash.telemetry` in global or project `settings.json`:

```json
{
    "safeBash": {
        "telemetry": {
            "enabled": true,
            "directory": "~/.pi/agent/safe-bash-telemetry",
            "retentionDays": 30,
            "captureCommand": true,
            "maxCommandLength": 10000,
            "auditDays": 30,
            "auditLimit": 100
        }
    }
}
```

All fields are optional. Positive integer bounds reject zero, negative, fractional, `NaN`, and infinite values.

## Storage and privacy

Telemetry is local JSONL:

```text
~/.pi/agent/safe-bash-telemetry/
└── YYYY-MM-DD/
    └── <session-id>.jsonl
```

- Root and date directories use mode `0700`; files use `0600`.
- Writes are append-only and ordered per session.
- Retention cleanup touches only expired `YYYY-MM-DD` directories and skips symlinks.
- Commands and errors pass through shared secret redaction and length bounds before storage.
- Storage failures never change command blocking or execution. Interactive sessions receive one warning per telemetry recorder.
- Command text may still contain sensitive data that best-effort redaction misses. Treat directory as sensitive.

Each event records schema version, event ID, time, session/tool-call IDs, project path, sequence, decision, outcome, command length, optional redacted command, and optional matched group/pattern/reason.

## Audit command

```text
/safe-bash-audit
/safe-bash-audit days=7 limit=25
```

Defaults to current project, last 30 days, maximum 100 events. Hard limits are 365 days and 500 events.

Command reads only current project's redacted telemetry, ranks blocked and suspicious attempts first, then sends bounded evidence to active LLM. All tool calls are blocked for that analysis turn. Prompt requires recommendation-only analysis:

- cite telemetry event IDs;
- distinguish confirmed blocks from suspected bypasses;
- recommend precise guard patterns and regression tests;
- state false-positive risk or insufficient evidence;
- do not edit files or execute commands.

Audit never changes guard rules automatically.
