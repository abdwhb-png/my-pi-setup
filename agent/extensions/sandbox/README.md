# Sandbox

Sandbox runs shell commands and Think-in-Code through Zerobox on Linux and WSL. Its default shell policy exposes the project and the tool baseline, closes external network access and uses private temporary storage.

## Configuration

Use exactly two active configuration locations:

- `~/.pi/agent/sandbox.json`: global defaults and authorization ceilings.
- `<project>/.pi/sandbox.json`: optional project restrictions and explicit Docker activation.

Choose the execution mode with `/sandbox mode sandbox` or `/sandbox mode host`. Host mode requires a global ceiling that permits it and an explicit selection in the current session. The displayed profiles `default`, `custom` and `host` describe the result. Do not store a profile selector.

A change to either configuration file is checked before the next shell admission. Invalid configuration blocks new calls. Setup failures never switch automatically to host execution.

## Commands

| Command | Purpose |
| --- | --- |
| `/sandbox` | Show configured permissions and runtime status. |
| `/sandbox doctor` | Inspect the resolved policy and configuration provenance. |
| `/sandbox mode sandbox\|host` | Select the execution mode for this session. |
| `/sandbox migrate` | Preview and confirm migration to the two-file format. |
| `/sandbox recover` | Verify and recover an interrupted migration. |
| `/sandbox docker` | Show Docker policy and runtime status. |
| `/sandbox docker on\|off` | Save this project's activation choice within the global Docker ceiling. |
| `/sandbox docker break-glass [1m-30m]` | Confirm a temporary exec exception for one eligible container. |

Docker requires both global `docker.allowed: true` with an explicit policy and project `docker.enabled: true`. An absent project activation leaves Docker disabled.

Use ordinary shell commands. Native file tools, extensions and MCP tools execute outside this shell boundary. Think-in-Code keeps its strict environment and private temporary storage regardless of shell mode.

## Documentation

- [Modes and profiles](docs/shell-capabilities.md)
- [Configuration and precedence](docs/configuration.md)
- [Docker authority](docs/docker-authority.md)
- [Runtime and limits](docs/runtime.md)
- [Troubleshooting](docs/troubleshooting.md)

A personal installation requires a separately approved activation of the matching Pi code, Zerobox binary and migrated configuration. Start a new Pi session after activation.
