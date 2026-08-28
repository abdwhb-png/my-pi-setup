# safe-bash

`safe_bash` adds dangerous-command policy before using the sandbox extension's shared Bash execution path. It records local, redacted attempt telemetry for later review.

With sandbox enabled, both `bash` and `safe_bash` use OS-level isolation. `/sandbox off` or `--no-sandbox` explicitly selects local execution for both tools. Missing, uninitialized, or failed sandbox execution state blocks both tools instead of falling back locally.

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

Every matching group is evaluated, so allowing one group cannot bypass another matching group's `ask` or `deny` policy.

`allowDangerous` is removed and ignored. `safeBash.mode` remains unchanged: `replace` removes raw `bash`, while `coexist` exposes both tools.

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
