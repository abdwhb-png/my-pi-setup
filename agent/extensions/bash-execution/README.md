# Bash Execution

Use `bash`, `safe_bash`, and `!` through the selected execution mode. A fresh
installation selects `sandbox`: Zerobox with its private shell runtime, no network, private `/tmp`, and no inherited host environment or PATH. Configure
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
`host`. Native file tools, extensions, MCP tools, and browser executors remain outside this shell boundary.
See [profiles and capabilities](../sandbox/docs/shell-capabilities.md).

`sandbox/` owns Zerobox and publishes `pi.sandbox-runtime.v2`; it does not
register or import a Bash tool. Shared guard, rewrite, execution and supervision
primitives live in `_shared/command-execution/` and have no concrete extension
dependency.

Safe Bash keeps its public tools, commands, renderers, `replace`/`coexist`
modes, policy and private telemetry. See [safe-bash/README.md](safe-bash/README.md)
for its configuration and audit contract.

The sandbox route starts `/__zerobox/runtime/bin/bash`. Its private distribution includes Bash, coreutils, findutils, grep, sed, gawk, diffutils, tar and gzip. It deliberately does not supply Git, `rg`, `jq`, package managers, editors, or other development tools. A project can select a global local installation to expose its authorized roots read-only and add its declared command directories before the private runtime PATH. This does not change the execution mode or grant host fallback.

## Shared context and guidance

Both tools use `_shared/shell-presentation/` for stable descriptions, snippets
and common guidelines. Their routing and environment remain shared, with
per-tool `bashRewrites` and additional Safe Bash checks. Tool availability
(`replace/coexist`) is separate from execution mode (`sandbox/host`).

Before each provider request, the `before_provider_request` hooks assemble one
`<pi-shell-context>` block in a temporary copy of the system instructions.
It contains current availability, execution facts and active Safe Bash checks.
It adds no user message and changes neither session history nor the base prompt. Configuration
changes appear as pending until the next shell admission proves the runtime admitted them. Execution context V3 is created from that admission receipt; V1 and V2 context describes historical or planned policy and is not proof of mounted permissions.
Standard prompts receive `promptGuidelines`; custom prompts receive the same
rules through the existing provider catalog, filtered to available tools.

Use `/reload` or a new Pi session to load these extension changes. See the
[design and validation record](../../../docs/brainstorming/2026-09-12-shared-shell-context-design.md)
and [runtime context contract](../sandbox/docs/runtime.md#model-context).
