# Troubleshooting

Run `/sandbox` and `/sandbox doctor` in the project to inspect the resolved policy and runtime state. Correct the reported file or field before retrying an operation.

### Unexposed paths in shell errors

After an admitted shell process exits with a nonzero code, `bash`, `safe_bash`, and `!s` can append a `Sandbox: <path> is outside the admitted read scope.` diagnostic to an absolute-path Bash `cd` or Node `Cannot find module` error. The original output and exit code are preserved. This reports a permission boundary, not proof that the path exists on the host or that the sandbox caused every error in the command.

The diagnostic requires a validated admission report and confirmed process startup for that execution. It is absent for host execution, setup/protocol failures, older or missing admission contexts, successful commands, and paths covered by admitted mounts or aliases. Relative, ambiguous, and unsupported error formats remain unchanged. The diagnostic scans only the final 64 KiB of output and reports at most three paths. It does not inspect host files, grant access, retry commands, or add persistent model instructions.

For a project path outside its global ceiling, fix the configuration error explicitly: remove the requested grant or authorize a covering path in the global configuration before selecting it in the project. Global grants are inherited by projects that do not restrict them.

### Missing shared libraries and misleading binding errors

Under the same admission, startup and nonzero-exit conditions, the shared shell execution layer recognizes complete Linux loader errors such as `Error: librt.so.1: cannot open shared object file: No such file or directory` and `tool: error while loading shared libraries: librt.so.1: cannot open shared object file: No such file or directory`. It appends `Sandbox: the dynamic loader could not find librt.so.1.` and explains that the library may be absent or outside the execution's read permissions. A library name alone does not identify its host path or prove a permission denial.

When the output also contains `Cannot find module` or `Cannot find native binding`, the diagnostic explains that these accompanying errors do not establish that the package is missing. Native loaders can accumulate failures from alternative locations and print generic reinstall advice even when the installed module cannot load a required library. Review the authorized installation's dependencies before changing permissions or reinstalling packages.

This handling is generic to recognized loader errors, preserves the original output and exit code, and reports at most three distinct library names. It uses the same bounded output tail as path diagnostics. It does not inspect host files, execute diagnostic probes, grant permissions, retry commands, or modify third-party packages. Unsupported and ambiguous error formats remain unchanged.

| Diagnostic or symptom | Action |
| --- | --- |
| Migration required | Run `/sandbox migrate` interactively and review the proposed global ceiling and both destination files. |
| Interrupted migration | Run `/sandbox recover`. A conflicting edit keeps admissions blocked until verified recovery is possible. |
| Global document belongs to another machine | Review its provenance. Do not copy a machine identity merely to activate foreign grants. |
| Untrusted configuration file | Check owner, regular-file status and group/other write permissions. Symlink configuration files are refused. |
| Unknown or reserved field | Use the v2 schema. Remove project fields reserved for global authority. False or inactive values do not exempt a field from validation. |
| Host mode outside the global ceiling | Inspect global `host.allowed`. Host execution also needs an explicit `/sandbox mode host` selection in the current session. |
| Shell policy changed during preparation | The pending command was not dispatched. Inspect the current mode and configuration before submitting it again. |
| Sandbox mode was not applied | The requested transition failed, was superseded, or belonged to a session that ended. Read the accompanying cause. Waiting shell commands did not fall back to the old mode. |
| Tool not found or unreadable | Run `/sandbox doctor <executable>` and check configured PATH and the canonical executable target's read grant. A PATH entry alone grants no read permission. |
| Selected installation is unavailable or redirected | Inspect the global installation root. It must be a directory at its declared canonical path; preview can rewrite a root to its canonical path before it is saved. |
| Project installation name is rejected | Declare that name globally first. A project can select global names only and cannot add or reorder roots. |
| Tool dependency is outside an authorized root | Authorize the dependency's bounded root separately or use a compatible private runtime. Do not widen a PATH entry or use host mode as a fallback. |
| Git metadata is not writable | Inspect explicit `.git` denials and any external Git directory. A writable project includes local Git metadata. |
| Filesystem deny targets logical private HOME | The internal HOME mount cannot enforce this deny. Correct the conflicting policy; the runtime will not silently ignore it. |
| A temporary file is invisible | Compare the host, Bash and Think namespaces. Store a shared artifact in the project. |
| Pipeline reports failure despite successful final stage | Bash uses `pipefail`. Inspect the earlier command's error. |
| Zerobox setup or provenance failure | Keep the setup diagnostic separate from a command exit. Repair the matching candidate installation; do not bypass through host mode. |
| Admission report missing, malformed, oversized, or digest-mismatched | Treat the runtime as unadmitted. FD 4 reports are capped at 1 MiB and must match the V2 `sandbox_admitted` status digest before `child_started`. |
| Private loopback connection failed: loopback proxy refused CONNECT | The proxy denied the connection. Inspect the exact host/port grant and any matching denial. |
| Zerobox private loopback stream interrupted (..., after CONNECT) | The tunnel was established, then a proxy-side error, timeout or other relay failure occurred. Inspect the command's output and exit code. Local client disconnects are handled as cancellation and do not generate this diagnostic. |
| Reconfiguration wait expired | The pending command did not execute. Its original timeout includes the wait. |
| Execution interrupted by reconfiguration | Inspect any effects already produced. The runtime did not replay the command. |
| A removed grant stopped an existing command | This is intentional revocation. The watcher polls every second and interrupts affected descendants before a replacement runtime accepts work. |

Bridge diagnostics use Zerobox's stderr, which `safe_bash` includes in tool output. A shell pipeline such as `2>&1 | tail` filters the command's output, but not the bridge's own stderr. A client may intentionally close TCP with a reset after completing its application exchange. Zerobox treats that local disconnect as cancellation, preserves the first transport failure before cleanup, and leaves the command's exit status unchanged. The relay cannot certify application-level completeness.

## Execution environments

Resolve executable names and check tool availability in the environment that will execute the command. A launcher may send arguments to a different runtime with its own HOME, PATH and filesystem. A command missing there does not establish that the tool is missing in the caller's environment, or that an access grant is needed.

Defer variable and path expansion intended for the target environment to that environment's shell. For example, use `launcher run sh -c '"$HOME/bin/tool" "$@"' sh argument` when the target HOME is required. Double quotes around `$HOME` in the caller still expand it before the launcher receives the argument. Keep values intentionally taken from the caller explicit. Do not automatically rewrite command arguments or substitute host paths.

## Docker

Docker needs global `allowed: true` with an explicit policy and project `enabled: true`. A missing activation at either level keeps it disabled. Use `/sandbox docker on` to save project activation within the global ceiling.

| Diagnostic or symptom | Meaning |
| --- | --- |
| Docker enabled but no containers are available | Declare targets in the project's `.pi/sandbox.json`. Global authorization alone selects no target. |
| Project attempts to set endpoint, mode or unsafe exception | These fields belong only in the global document. Select project targets and operations within the global operation limits. |
| Docker operation not granted | The effective target operation list does not authorize it. |
| Docker target not authorized | Check the exact container name or Compose project/service selector and live target eligibility. |
| Empty successful `docker ps` | The broker may have excluded every container. This is not proof of usable target access. |
| Target has host access | Inspect mounts and privileges. A global unsafe-target exception is separate from arbitrary exec permission. |
| Exec restricted to read-only inspection | Use only the exact allowed bind probes, or obtain the distinct temporary break-glass authorization. |
| Break-glass expired | The exact-container exception expired and operations using that expired runtime were interrupted. |
| Saved configuration but failed runtime activation | New admissions remain blocked. Correct the activation failure before retrying. |

A CLI's successful exit does not prove a GUI opened or a remote service completed an action. Preserve command output, exit status and observed runtime provenance separately. See [Docker authority](docker-authority.md) and [Runtime](runtime.md).
