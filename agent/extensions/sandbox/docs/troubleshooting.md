# Troubleshooting

Run `/sandbox doctor` in the project first. It reads only canonical settings
and `~/.pi/agent/sandbox.global.json`; it never writes configuration.

| Message | Meaning and action |
| --- | --- |
| `targets is required for mode "targeted"` | Run `/sandbox docker grant`, or add an explicit target manually. |
| `Untrusted global Docker authority file` | Make the authority a regular owner-owned `0600` file, not a symlink. |
| `Project attempted to enable Docker` | Add the authority globally with `/sandbox docker grant`; project settings can only narrow it. |
| Docker service cannot be selected | Run the command from the Compose project or use the manual container-name fallback. |
| `Docker target ...: excluded` | The grant matches, but the broker excludes the container. Run `/sandbox docker grant` to review its host access and explicitly confirm an exception if appropriate. |
| `Docker target ...: absent` | No current container matches the selector on the configured Docker endpoint. Check the Compose project and service names. |
| `Docker target inspection unavailable` | The configuration was parsed, but live access could not be checked. Check the Docker daemon, CLI and Sandbox runtime, then rerun doctor. |
| Sandbox configuration failed | Read the field path in the message, correct that canonical file, then run `/sandbox doctor` again. |

If a new Docker grant is saved while Sandbox is active, Sandbox reloads the
authority for the running session automatically.

`docker ps` can return an empty list with exit code 0 when all matching
containers are excluded. A valid `targeted` grant alone does not establish
container access; use the target lines in `/sandbox doctor`.

Development Bash resolves `~` to your normal home directory. Its filesystem
restrictions still apply: a home-relative path outside the configured write
roots remains unwritable. Think retains a private HOME and private `/tmp`.

Sandbox Bash enables `pipefail`: `bun test ... | tail -n 20` now returns a
failure when Bun fails. Commands that intentionally tolerate an earlier pipe
failure can explicitly use `set +o pipefail`. This also affects pipelines whose
consumer exits early, such as `head`.
