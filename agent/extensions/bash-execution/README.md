# Bash Execution

Use `bash`, `safe_bash`, and `!` through the selected execution mode. A fresh
installation selects `sandbox`: Zerobox, no network, private `/tmp`. Configure
explicit resource openings within the authorization ceilings, or select `host`
for a local shell when globally authorized. Treat `default`, `custom` and `host`
as derived profiles, not configuration selectors.
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
| `sandbox` mode (`default` or `custom` profile) | Zerobox with the effective resource configuration |
| Explicitly selected, globally authorized `host` mode | Local shell, existing permission pipeline |
| Missing authorization or unavailable selected backend | Blocked, with no automatic fallback |

Select the mode with `/sandbox mode sandbox` or `/sandbox mode host`. Use
ordinary commands. Legacy `hostCapability` parameters are rejected before launch.

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

## Shared context and guidance

Both tools use `_shared/shell-presentation/` for stable descriptions, snippets
and common guidelines. Their routing and environment remain shared, with
per-tool `bashRewrites` and additional Safe Bash checks. Tool availability
(`replace/coexist`) is separate from execution mode (`sandbox/host`).

Before each model request, the `context` hooks assemble one ephemeral
`pi.shell-context.v2` message. It contains current availability, execution facts
and active Safe Bash checks. It is not saved in session history. Configuration
changes appear as pending until the next shell admission prepares the runtime.
Standard prompts receive `promptGuidelines`; custom prompts receive the same
rules through the existing provider catalog, filtered to available tools.

Use `/reload` or a new Pi session to load these extension changes. See the
[design and validation record](../../../docs/brainstorming/2026-09-12-shared-shell-context-design.md)
and [runtime context contract](../sandbox/docs/runtime.md#model-context).
