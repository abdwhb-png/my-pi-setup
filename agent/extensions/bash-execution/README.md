# Bash Execution

Use `bash`, `safe_bash`, and `!` through the selected shell profile. A fresh
installation selects `isolated`: Zerobox, no network, private `/tmp`. Select
`integrated` for explicit local capabilities or approve `host` for a local shell.
Read actual status, backend, shell profile, capability and temporary namespace
from execution provenance. Preserve raw output when adding metadata.

`bash-execution` is the only Pi extension entrypoint that owns the three Bash
surfaces:

- `bash`, implemented as the built-in Pi Bash tool with stdin, rewrite,
  rendering and compression support;
- the `user_bash` hook;
- `safe_bash`, installed from the local `safe-bash/` policy submodule.

The extension resolves operations through
`agent/extensions/_shared/sandbox-runtime/`. It owns one local process
supervisor for approved host operations. Resolve local authority first, then
select the backend. Engine failure never grants host execution.

| Selected shell route | Execution |
| --- | --- |
| `isolated`, ordinary `integrated` | Zerobox, with effective local grants and narrower preferences |
| Explicit `safe_bash.hostCapability` | Approved integration, literal argv, supervised host process |
| Approved `host` profile | Local shell, existing permission pipeline |
| Missing authorization or unavailable selected backend | Blocked, with no automatic fallback |

Use `!s <command>` to request sandbox execution explicitly. Think-in-Code keeps
its strict engine and private HOME and `/tmp` even when the shell profile is
`host`. Native file tools remain on the host outside this shell boundary.
See [profiles and capabilities](../sandbox/docs/shell-capabilities.md).

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
