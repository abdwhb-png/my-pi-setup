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

Python deletion calls supplied through heredoc stdin are also detected. `node -e`/`--eval` and `bun -e`/`--eval` one-liners are covered by the same pattern, including a bare destructured call (`await rm(dir, { recursive: true })`), not only a dotted one (`fs.rmSync(...)`). Ordinary scripts and read-only interpreter one-liners remain allowed unless another danger group matches.

## Command-position matching

`rm` and `shutdown` match an invocation at a command position, not the bare word. The bare word also appears as an identifier or string literal in interpreter one-liners and heredocs, which produced confirmed false positives in the audit (`53ab0c7f`: the `rm` in `import { mkdtemp, rm } from "node:fs/promises"`; `9697380d`: the string literal `'shutdown'` in a Python `replace()` call).

Still matched: `rm file`, `cd x && rm file`, `sudo rm file`, `command rm file`, `env FOO=1 rm file`, `git rm file`, `xargs rm`, `find . -exec rm {} +`, `shutdown -h now`, `reboot`, `sudo reboot`, `systemctl poweroff`.

`git rm` is matched on purpose and routed through the `cwd-only` scope check, because it deletes the working-tree file. With `rm: cwd-only` an in-cwd `git rm` is therefore allowed; `deny` still blocks it.

`xargs rm` and `find -exec rm` match the group but expose no `rm` segment to the scope parser, so they fail closed with a `no-invocation` verdict.

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

## Scopable groups

A scope permission (`cwd-only` / `sandbox-only`) needs a path to decide on, so it applies only to groups that have filesystem targets. The canonical map is `SCOPE_RULES` in [`_shared/command-execution/guard.ts`](../../_shared/command-execution/guard.ts), read through `isScopableGroup`:

- `rm` — `delete` rule over `rm` / `git rm` operands.
- `file-delete-api` — `api-delete` rule over path literals in interpreter delete calls.
- `chmod` — `mode` rule over targets plus the mode rules above.
- `chown` — `owner` rule over every operand after the owner spec.
- `dd` — `of-device` rule over the `of=` write destination.

The other groups have no path operand, so a scope permission on them is **rejected at config load**, named in `/safe-bash status`, and never silently denies: `sudo`, `mkfs`, `raw-disk-write`, `forkbomb`, `remote-shell`, `reverse-shell`, `exec-injection`, `shutdown`, `init`, `kill`, `cryptominer`. They stay with `allow`, `ask`, or `deny`.

Scoped `chown` rejects symlinks in any existing target path component because `chown` follows them by default. `-R` / `--recursive` and link-traversal flags (`-H`, `-L`) fail closed: the guard cannot inspect every descendant. `chown --reference=…` also fails closed because it copies ownership from another file. `dd` is scoped on `of=` only; `if=` is a read.

## Guard policy

Configure each danger group under `safeBash.guardPolicy`:

```json
{
    "safeBash": {
        "guardPolicy": {
            "sudo": "deny",
            "rm": "allow",
            "file-delete-api": "ask"
        }
    }
}
```

Actions:

- `deny`: block. This is the default for missing groups.
- `ask`: interactive choice to allow once, allow the exact normalized command for the session, deny, or deny with a reason. Non-interactive sessions deny.
- `allow`: execute without prompting while preserving telemetry guard evidence.
- `cwd-only`: allow only when the command's resolvable targets stay lexically inside the session working directory (`ctx.cwd`). Supported for the scopable groups above; other groups are rejected at config load.
- `sandbox-only`: allow only when the shell is in **sandbox mode** _and_ every resolved target is inside the sandbox's granted write roots. It denies in host mode even for granted targets, and denies when the sandbox facts are unavailable. Implemented in `evaluateScopePolicies` with the same parser as `cwd-only`; the roots come from the live shell policy via `resolveWritableRoots`. `<sandbox-home>` / `<sandbox-tmp>` grant tokens are dropped, since a host path can never sit inside a sandbox-private mount.

Combine the two with the object form, which admits a command when **any** member does. Members must be scope policies, non-empty, and duplicate-free:

```json
{
    "safeBash": {
        "guardPolicy": { "rm": { "anyOf": ["cwd-only", "sandbox-only"] } }
    }
}
```

A rejection is recorded in `guardPolicyNotes` and rendered by `/safe-bash status`, so a dropped entry is visible instead of a silent deny.

Denial reasons name the class, so the agent can act on the block instead of retrying a variant spelling:

- `outside`: names the offending resolved path.
- `unresolvable`: names the raw operand that could not be resolved (variable, glob, backtick), or reports that the invocation has no resolvable target.
- `no-invocation`: the group matched a form the parser cannot read as an invocation (`xargs rm`, `find -exec rm`, or a mention inside a string).
- `protected` / `catastrophic-mode`: chmod-specific, see above. `symlink` also applies to scoped `chown` targets and their parent directories.

`chmod` ships with `cwd-only` as its code default, taken from the shared `DEFAULT_DANGER_GROUP_POLICY` in [`_shared/command-execution/policy.ts`](../../_shared/command-execution/policy.ts). `think-in-code` starts from the same constant for its own `commandPolicy.guardPolicy`, so a scope-decided group is never blanket-denied by one consumer and scoped by another. Setting `safeBash.guardPolicy.chmod` to `deny` blocks every `chmod` invocation, and `allow` skips the scope checks entirely.

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

Accepted values are a closed set — the shell commands that have a native Pi tool equivalent: `grep`, `rg`, `find`, `fd`, `ls`, `ack`, `ag`. They map to the native tools `grep`, `find`, and `ls`. The type is `AllowedShellCommand[]`, defined once in [`_shared/command-execution/guard.ts`](../../_shared/command-execution/guard.ts) next to the redirect map.

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

Blocked events additionally record the guard evidence needed to adjudicate them after the fact: `policy` (the effective policy for the matched group), `scopeVerdict` (what a scope check decided), `scopeMember` (which member of an `anyOf` decided), `targets` (up to 8 resolved targets, redacted), and `repeatOfEventId` (the earlier blocked event that hit the same resolved target set). Without `policy` and `scopeVerdict` an `rm` block cannot be attributed to `deny` or to a `cwd-only` fail-closed; the audit window that motivated these fields had 13 such unattributable events. The fields are additive, so `SAFE_BASH_TELEMETRY_SCHEMA_VERSION` stays at 2.

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
