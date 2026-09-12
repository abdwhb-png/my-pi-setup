# Sandbox

Sandbox runs shell commands and Think-in-Code through Zerobox on Linux and WSL2 x86_64. The shell starts with a private runtime, the configured project permissions, closed external network access, and private temporary storage. It does not inherit host directories, environment variables, or PATH entries.

## Configuration

Use exactly two active configuration locations:

- `~/.pi/agent/sandbox.json`: global defaults and authorization ceilings.
- `<project>/.pi/sandbox.json`: optional project restrictions and explicit Docker activation.

Choose the execution mode with `/sandbox mode sandbox` or `/sandbox mode host`. Host mode requires global `host.allowed: true` and an explicit selection in the current session. The displayed profiles `default`, `custom` and `host` describe the result. Do not store a profile selector.

A change to either configuration file is checked before each model request and shell admission. The model sees valid changes as pending until the next shell call admits the replacement. Invalid configuration blocks new calls. Setup failures never switch automatically to host execution. While processes remain active, the watcher also polls once per second: a removed grant interrupts every existing descendant that retained it before the replacement is used; additive changes let existing work drain.

## Commands

| Command | Purpose |
| --- | --- |
| `/sandbox` | Show status and an action selector. |
| `/sandbox status` | Print configured permissions and runtime status. |
| `/sandbox mode` | Select sandbox or host, with an explanation if host is unavailable. |
| `/sandbox installations` | Inspect, add, edit, revoke or select local installations with a preview before saving. |
| `/sandbox doctor [executable]` | Inspect policy and optionally resolve an executable without running it. |
| `/sandbox mode sandbox\|host` | Select the execution mode for this session. |
| `/sandbox migrate` | Preview and confirm migration to the two-file format. |
| `/sandbox recover` | Verify and recover an interrupted migration. |
| `/sandbox docker` | Show Docker policy and runtime status. |
| `/sandbox docker on\|off` | Save this project's activation choice within the global Docker ceiling. |
| `/sandbox docker break-glass [1m-30m]` | Confirm a temporary exec exception for one eligible container. |

Docker requires both global `docker.allowed: true` with an explicit policy and project `docker.enabled: true`. An absent project activation leaves Docker disabled.

Use ordinary shell commands. Native file tools, extensions, MCP tools, and browser executors execute outside this shell boundary. Think-in-Code keeps its strict environment and private temporary storage regardless of shell mode.

## Local installations

Declare machine-local installations only in `~/.pi/agent/sandbox.json` under `environment.installations`. An installation maps a name to one or more canonical host roots and optional command directories relative to each root. Selecting its name in `<project>/.pi/sandbox.json` adds those roots read-only and their command directories to PATH once, in global declaration order. A project can select or narrow global names, but cannot introduce a root. An omitted project selection inherits all global installations. An empty list selects none. No separate profile activation is required.

A declared installation adds its root read-only, including when it has no command directory. Legacy `environment.path` entries only change command lookup. The runtime revalidates roots and command-directory targets before admission. Filesystem isolation blocks access to undeclared external dependencies. Use `/sandbox installations` to preview canonical roots before saving; a redirected root must be authorized by its canonical location. See [Configuration](docs/configuration.md#local-installations).

## Documentation

- [Modes and profiles](docs/shell-capabilities.md)
- [Configuration and precedence](docs/configuration.md)
- [Docker authority](docs/docker-authority.md)
- [Runtime and limits](docs/runtime.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Shared shell context design and validation](../../../docs/brainstorming/2026-09-12-shared-shell-context-design.md)

The private-runtime architecture remains separately qualified before any personal activation. A release installs the runtime bundle atomically and pins its real release path for the lifetime of the runtime. The widget shows the selected mode, derived profile, engine state and Docker access.
