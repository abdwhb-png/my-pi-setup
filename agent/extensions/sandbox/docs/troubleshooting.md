# Troubleshooting

Run `/sandbox` and `/sandbox doctor` in the project to inspect the resolved policy and runtime state. Correct the reported file or field before retrying an operation.

| Diagnostic or symptom | Action |
| --- | --- |
| Migration required | Run `/sandbox migrate` interactively and review the proposed global ceiling and both destination files. |
| Interrupted migration | Run `/sandbox recover`. A conflicting edit keeps admissions blocked until verified recovery is possible. |
| Global document belongs to another machine | Review its provenance. Do not copy a machine identity merely to activate foreign grants. |
| Untrusted configuration file | Check owner, regular-file status and group/other write permissions. Symlink configuration files are refused. |
| Unknown or reserved field | Use the v2 schema. Remove project fields reserved for global authority. False or inactive values do not exempt a field from validation. |
| Host mode outside the global ceiling | Inspect global `host.allowed`. Host execution also needs an explicit `/sandbox mode host` selection in the current session. |
| Shell policy changed during preparation | The pending command was not dispatched. Inspect the current mode and configuration before submitting it again. |
| Tool not found or unreadable | Run `/sandbox doctor <executable>` and check configured PATH and the canonical executable target's read grant. A PATH entry alone grants no read permission. |
| Git metadata is not writable | Inspect explicit `.git` denials and any external Git directory. A writable project includes local Git metadata. |
| Filesystem deny targets logical private HOME | The internal HOME mount cannot enforce this deny. Correct the conflicting policy; the runtime will not silently ignore it. |
| A temporary file is invisible | Compare the host, Bash and Think namespaces. Store a shared artifact in the project. |
| Pipeline reports failure despite successful final stage | Bash uses `pipefail`. Inspect the earlier command's error. |
| Zerobox setup or provenance failure | Keep the setup diagnostic separate from a command exit. Repair the matching candidate installation; do not bypass through host mode. |
| Reconfiguration wait expired | The pending command did not execute. Its original timeout includes the wait. |
| Execution interrupted by reconfiguration | Inspect any effects already produced. The runtime did not replay the command. |

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
