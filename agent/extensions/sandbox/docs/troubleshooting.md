# Troubleshooting

Run `/sandbox doctor` and `/sandbox capabilities` in the project first. They
inspect configuration and authority without writing it. Doctor separates the
shell diagnostic from canonical Docker configuration.

## Shell profiles and local authority

| Diagnostic | Action |
| --- | --- |
| `migration-required` | Run `/sandbox capabilities migrate` interactively and review the displayed openings once. |
| `machine-mismatch` | Review foreign grants with migration. Do not copy a machine identity to activate them. |
| `authorization-required` | Inspect `/sandbox capabilities`; ask the user for the named grant if needed. Never retry through another host route. |
| `invalid-authority` | Inspect file owner, regular-file status, symlinks and permissions from a trusted host context. Do not overwrite it from the model. |
| `integration-unavailable` | Repair the named installed host tool, then grant its installed path again. |
| `unsupported-command` | Use the adapter's documented literal argv. Unsupported managers and shell compositions require a separately approved route. |
| Shell policy changed | Refresh the requested profile through `/sandbox profile ...`; the rejected call did not execute. |
| SFW nonzero exit | Keep its raw error and exit code. Stop. Do not call an unwrapped package manager. |
| A temporary file is invisible | Compare namespaces. Use a project artifact shared with native file tools. |

Read the [capability contract](shell-capabilities.md) before changing isolation.
Native file tools remain on the host. A successfully spawned CLI does not prove
that a GUI opened or that a remote service completed its operation.

| Message | Meaning and action |
| --- | --- |
| `targets is required for mode "targeted"` | Run `/sandbox docker grant`, or add an explicit target manually. |
| `Untrusted global Docker authority file` | Make the authority a regular owner-owned `0600` file, not a symlink. |
| `Project attempted to enable Docker` | Add the authority globally with `/sandbox docker grant`; project settings can only narrow it. |
| Docker service cannot be selected | Run the command from the Compose project or use the manual container-name fallback. |
| `Target access: blocked by the broker for this grant` | Review the reported host access with `/sandbox docker grant` and explicitly confirm an exception if appropriate. |
| `Docker target ...: absent` | No current container matches the selector on the configured Docker endpoint. Check the Compose project and service names. |
| `Docker target inspection unavailable` | The configuration was parsed, but live access could not be checked. Check the Docker daemon, CLI and Sandbox runtime, then rerun doctor. |
| Sandbox configuration failed | Read the field path in the message, correct that canonical file, then run `/sandbox doctor` again. |
| `Docker operation is not granted` | Inspect effective operations in `/sandbox`. Administration adds persistent `exec` only when the target has no host-access exception. |
| `Docker target is not authorized` | Check the exact container name or Compose project/service selector. The container may also have disappeared. |
| `Docker exec option forbidden` | Targeted exec refuses privileged/detached execution and non-empty detach keys, even with Administration. |
| `Docker exec is restricted to read-only inspection` | This target has a persistent host-access exception. Use exactly `test -r PATH`, `stat -- PATH` or `ls -la -- PATH` below a declared bind destination, or explicitly run `/sandbox docker break-glass`. |
| `Break-glass exec expired` | The exact-container grant reached its selected expiration. Any command still using the old runtime was interrupted and was not replayed. The agent receives this state automatically. Confirm a new break-glass grant only if arbitrary exec is still required. |
| `saved; activation failed` | The authority file was saved, but no new runtime was activated. Correct the reported cause, then run `/sandbox on`. |
| `Active Docker differs from the current configuration` | The files and running permissions differ. If `/sandbox` shows a session-only break-glass grant, the difference is intentional until it expires. Otherwise run `/sandbox on`. |
| `reconfiguration did not finish in time` | The pending command was not executed. After recovery, submit it again if still needed. |
| `execution was interrupted by reconfiguration` | An engaged process was stopped and was not replayed. Inspect its effects before deciding to retry. |

If a new Docker grant is saved while Sandbox is active, Sandbox reloads the
authority for the running session automatically.
New Bash, safe_bash and Think calls wait at most 30 seconds during this change,
within their original timeout. Cancellation, disablement, activation failure
or session replacement ends the wait without executing the pending command.

`docker ps` can return an empty list with exit code 0 when all matching
containers are excluded. A valid `targeted` grant alone does not establish
container access; use the target lines in `/sandbox doctor`.

`/sandbox docker break-glass` lasts five minutes by default. Pass a whole-minute
duration from `1m` through `30m` when needed, for example
`/sandbox docker break-glass 15m`.

Development Bash resolves `~` to your normal home directory. Its filesystem
restrictions still apply: a home-relative path outside the configured write
roots remains unwritable. Think retains a private HOME and private `/tmp`.

Sandbox Bash enables `pipefail`: `bun test ... | tail -n 20` now returns a
failure when Bun fails. Commands that intentionally tolerate an earlier pipe
failure can explicitly use `set +o pipefail`. This also affects pipelines whose
consumer exits early, such as `head`.
