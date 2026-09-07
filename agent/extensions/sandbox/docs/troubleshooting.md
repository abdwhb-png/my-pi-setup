# Troubleshooting

Run `/sandbox doctor` in the project first. It reads only canonical settings
and `~/.pi/agent/sandbox.global.json`; it never writes configuration.

| Message | Meaning and action |
| --- | --- |
| `targets is required for mode "targeted"` | Run `/sandbox docker grant`, or add an explicit target manually. |
| `Untrusted global Docker authority file` | Make the authority a regular owner-owned `0600` file, not a symlink. |
| `Project attempted to enable Docker` | Add the authority globally with `/sandbox docker grant`; project settings can only narrow it. |
| Docker service cannot be selected | Run the command from the Compose project or use the manual container-name fallback. |
| Sandbox configuration failed | Read the field path in the message, correct that canonical file, then run `/sandbox doctor` again. |

If a new Docker grant is saved while Sandbox is active, Sandbox reloads the
authority for the running session automatically.
