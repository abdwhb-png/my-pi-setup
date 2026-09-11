# Shell modes and resource configuration

Select an execution mode independently of the descriptive profile.

| Profile | Mode | Meaning |
| --- | --- | --- |
| P1 — Default sandbox | `sandbox` | Use Zerobox with the project and tool baseline, closed network and private temporary files. |
| P2 — Custom sandbox | `sandbox` | Apply the authorized resource configuration, including additional restrictions. |
| P3 — Explicit host | `host` | Run through the local process supervisor after explicit session selection within the global authorization. |

P1 and P2 use the same backend. The effective configuration determines `default` or `custom`; do not enable a second profile after editing a valid resource grant. Returning to the baseline produces `default` again. P1/P2/P3 are documentation references, not configuration fields. D1–D12 identify architectural decisions in the implementation plan.

## Configuration ownership

Use `~/.pi/agent/sandbox.json` for global defaults and ceilings. Place project restrictions in `<project>/.pi/sandbox.json`. Do not keep a global registry of projects or configure additional capability files.

An absent project field inherits the global setting. An empty list closes that resource list. Restrictions take precedence over grants. Configure PATH and filesystem reads separately: finding a program through PATH does not grant access to its executable, symlink target, configuration or cache.

For example, when a system command resolves to a Linux executable outside the tool baseline, grant that precise executable path in the global configuration. Keep the original command. Do not add a product adapter or grant an entire parent directory just to reach one executable.

Docker uses a separate rule inside these same files: global `docker.allowed` authorizes its policy ceiling, while project `docker.enabled` opts in. Missing booleans mean disabled. Preserve the broker and its operation/target limits. A generic socket grant must not replace Docker authority.

See [configuration](configuration.md) for the active schema and [Docker authority](docker-authority.md) for its limits.

## Select and inspect

Use `/sandbox` for status and actions, `/sandbox mode` to select a mode, or `/sandbox status` for a text report. Run `/sandbox doctor [executable]` to inspect the effective configuration and optionally resolve an executable without launching it.

Run `/sandbox mode host` to select host execution for the current session. The global configuration must authorize it with `host.allowed: true`. A global host ceiling alone does not select host execution, and a project file cannot make that selection. Run `/sandbox mode sandbox` to return to the authorized sandbox configuration. Session selections do not carry into another session.

Use ordinary commands through `bash` or `safe_bash`. No tool parameter selects an editor, package manager or development service. A legacy `hostCapability` parameter produces a migration diagnostic before launch.

Use `! <command>` or `!! <command>` with the selected mode. Use `!s <command>` or `!!s <command>` to request the sandbox. The double exclamation form keeps output outside model context. An empty `!s` request fails explicitly.

## Admission and results

Reload configuration before admitting a command. Invalid configuration blocks new admissions. A valid external change rebuilds the required runtime; operations already admitted drain using their original resources. A setup failure never selects a different backend.

Keep execution evidence separate from labels. Record `mode` and `shellProfile` alongside the observed `status`, `backend` and temporary namespace. Preserve an unknown result when no execution evidence exists. The model context reports the final tool result separately from process provenance: a process can exit successfully while a later validation makes the tool fail. When reading historical `integrated` results, use their observed backend to distinguish an old sandbox execution from an old specialized host execution.

This is a shell boundary. Native file tools, extensions and MCP tools execute outside it. Think-in-Code retains its strict environment and private HOME and temporary files regardless of the shell mode.

## Migration

Run `/sandbox migrate` to review the source files, proposed global ceiling and project configuration before publication. Preserve byte-exact archives and unrelated Pi settings. Do not combine old per-project Docker grants into a broader global policy.

Run `/sandbox recover` after an interrupted migration. Recovery verifies the recorded files before completing or restoring the transaction. Keep admissions blocked when a conflicting edit prevents safe recovery.

The former `isolated`/`integrated` selectors, product grants, `sandbox.global.json`, `sandbox.capabilities.json` and `settings.json` sandbox sections are historical migration inputs. They are not active configuration sources.
