# Bash Execution

`bash-execution` is the only Pi extension entrypoint that owns the three Bash
surfaces:

- `bash`, implemented as the built-in Pi Bash tool with stdin, rewrite,
  rendering and compression support;
- the `user_bash` hook;
- `safe_bash`, installed from the local `safe-bash/` policy submodule.

The extension resolves operations through
`agent/extensions/_shared/sandbox-runtime/`. It owns one local process
supervisor and uses that adapter only when Sandbox is explicitly disabled.

| Sandbox runtime state | `bash`, `user_bash`, `safe_bash` |
| --- | --- |
| `enabled` | Zerobox operations published by Sandbox |
| `disabled` | Local operations owned by Bash Execution |
| `uninitialized` | Blocked before spawn |
| `error` | Blocked with a bounded reason |

`sandbox/` owns Zerobox and publishes `pi.sandbox-runtime.v2`; it does not
register or import a Bash tool. Shared guard, rewrite, execution and supervision
primitives live in `_shared/command-execution/` and have no concrete extension
dependency.

Safe Bash keeps its public tools, commands, renderers, `replace`/`coexist`
modes, policy and private telemetry. See [safe-bash/README.md](safe-bash/README.md)
for its configuration and audit contract.

This ownership migration requires a complete Pi process restart. `/reload` is
not safe because old Jiti generations can retain obsolete global symbols and
entrypoint registrations.
