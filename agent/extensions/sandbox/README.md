# Sandbox

Sandbox is the Linux Zerobox runtime used by Bash and Think-in-Code. It keeps
filesystem, network, environment and Docker access explicit.

## Start here

1. Put ordinary Sandbox settings in `~/.pi/agent/settings.json` under
   `sandbox`, or in `<project>/.pi/settings.json` for one project.
2. Open Pi in the project and run `/sandbox doctor`.
3. Run `/sandbox on` when the status is correct.
4. If the project needs Docker, run `/sandbox docker grant` from that project.
   Choose a service and an access profile, review the change, then confirm it.

Docker is off by default. Its authority is kept separately in
`~/.pi/agent/sandbox.global.json`, never in project settings.

## Daily commands

| Command | Purpose |
| --- | --- |
| `/sandbox` | Show the effective Sandbox policy. |
| `/sandbox doctor` | Validate canonical configuration and show the next corrective command. |
| `/sandbox on` / `/sandbox off` | Enable or disable Sandbox for this session. |
| `/sandbox docker` | Show Docker authority, project preference and effective policy. |
| `/sandbox docker grant` | Create or replace this project's global targeted Docker grant. |
| `/sandbox docker off\|targeted\|full\|inherit` | Set a project-local narrowing of the global authority. |

## Documentation

- [Configuration](docs/configuration.md): ordinary Sandbox settings and precedence.
- [Docker authority](docs/docker-authority.md): guided and manual Docker grants.
- [Troubleshooting](docs/troubleshooting.md): errors and corrective actions.
- [Runtime](docs/runtime.md): isolation, temporary storage and operational limits.
