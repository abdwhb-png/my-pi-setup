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
sandbox facts and Safe Bash checks appear in one ephemeral model context.
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
- `cwd-only`: allow only when every resolvable delete target stays lexically inside the session working directory (`ctx.cwd`). An unresolvable target (variable, glob, backtick, bare `rm`) or any target outside `cwd` blocks with a reason naming the offending path. Supported for the `rm` and `file-delete-api` groups; other groups fail closed to `deny`.

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
