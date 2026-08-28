# safe-bash

`safe_bash` wraps Pi's Bash execution with best-effort dangerous-command detection. It blocks known destructive patterns before execution and records local, redacted attempt telemetry for later review.

It is not a security sandbox. Pattern matching cannot prove a command harmless, and processes running as the same OS user can modify local telemetry.

## Deletion API guard

Danger group `file-delete-api` blocks direct filesystem deletion APIs inside interpreter one-liners, including:

- Python `shutil.rmtree`, `Path.unlink`/`rmdir`, and `os.remove`/`unlink`/`rmdir`;
- Node `fs.rm`/`rmSync`, `unlink`/`unlinkSync`, and `rmdir`/`rmdirSync`;
- Perl `unlink`/`rmdir`;
- Ruby `FileUtils.rm_rf`, `File.delete`/`unlink`, and `Dir.rmdir`.

Ordinary scripts and read-only interpreter one-liners remain allowed unless another danger group matches. Existing `safeBash.mode`, `allowedShellCommands`, and `allowDangerous` behavior is unchanged.

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
