# Sandbox

Sandbox runs shell commands and Think-in-Code through Zerobox on Linux and WSL2 x86_64. The shell starts with a private runtime, the configured project permissions, closed external network access, and private temporary storage. It does not inherit host directories, environment variables, or PATH entries.

## Configuration

Use exactly two active configuration locations:

- `~/.pi/agent/config/sandbox.json`: global defaults and authorization ceilings.
- `<project>/.pi/config/sandbox.json`: optional project restrictions and explicit Docker activation.

Choose the execution mode with `/sandbox mode sandbox` or `/sandbox mode host`. Host mode requires global `host.allowed: true` and an explicit selection in the current session. The displayed profiles `default`, `custom` and `host` describe the result. Do not store a profile selector.

A change to either configuration file is checked before each model request and shell admission. The model sees valid changes as pending until the next shell call admits the replacement. Invalid configuration blocks new calls. Setup failures never switch automatically to host execution. While processes remain active, the watcher also polls once per second: a removed grant interrupts every existing descendant that retained it before the replacement is used; additive changes let existing work drain.

## Preparation and deadlines

The shell timeout covers configuration preparation, replacement admission, spawn setup and execution in one monotonic budget. An unchanged sandbox command resolves configuration during preparation and checks it again immediately before spawn. No configuration result is reused across commands, and a policy change during asynchronous setup blocks dispatch. Host dispatch also checks its current authorization immediately before spawn.

Concurrent requests for the same session, project, mode and configuration share one replacement. Cancelling one caller stops that command without cancelling a startup another caller may need. A different configuration, a new owner or session shutdown supersedes the candidate. Startup and service shutdown each have a separate 30-second ceiling. Timed-out cleanup stays owned for retry and cannot publish a replacement. Version, strict-mode and feature probes run asynchronously with cancellation. Every replacement still verifies all runtime file hashes. Permission removal revokes the old generation before replacement, and cleanup failures remain visible and retained for retry.

Execution provenance includes `timingsMs` for preparation, configuration, verification, shutdown, admission and execution when those phases ran. Preparation is the total before command dispatch and includes nested replacement work. Verification and shutdown timings describe a replacement this command awaited, rather than an earlier cached startup. A timeout can report partial phase timings. These fields contain durations, not commands or environment values.

## Commands

| Command                                       | Purpose                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `/sandbox`                                    | Show status and an action selector.                                                                                                         |
| `/sandbox status`                             | Inspect configured permissions and runtime status.                                                                                          |
| `/sandbox mode`                               | Select sandbox or host, with an explanation if host is unavailable.                                                                         |
| `/sandbox installations`                      | Inspect, add, edit, revoke or select local installations with a preview before saving.                                                      |
| `/sandbox doctor [executable]`                | Inspect policy and optionally resolve an executable without running it.                                                                     |
| `/sandbox mode sandbox\|host`                 | Select the execution mode for this session.                                                                                                 |
| `/sandbox migrate`                            | Preview and confirm migration to the two-file format.                                                                                       |
| `/sandbox recover`                            | Verify and recover an interrupted migration.                                                                                                |
| `/sandbox docker`                             | Show Docker policy and runtime status.                                                                                                      |
| `/sandbox docker on\|off`                     | Save this project's activation choice within the global Docker ceiling.                                                                     |
| `/sandbox docker configure` | Discover existing services, review access, and manage remembered permissions. |
| `/sandbox docker break-glass [1m-<ceiling>m]` | Confirm a temporary exec exception for one eligible container. The duration ceiling defaults to 30 minutes and is configurable per machine. |

In the TUI, `/sandbox` opens a framed panel with horizontal **Status**, **Permissions**, **Doctor** and **Docker** tabs. Left/Right or Tab/Shift-Tab changes section; Up/Down selects an action and Enter opens it. Escape returns from details, then closes the panel. Within details, Up/Down, PageUp/PageDown and Home/End scroll. Narrow terminals show the active tab compactly. Host-mode and full-Docker warnings remain visible. RPC, JSON and print sessions retain plain-text reports and standard prompts.

The Docker section offers service configuration and permission management directly. Configuration discovers existing services, explains mounts and privileges, and requires confirmation before saving. Static client exposure, broker eligibility and executed commands remain separate evidence. Labels and values use shared theme colors; Doctor inspects metadata without executing commands or changing permissions.

Docker requires both global `docker.allowed: true` with an explicit policy and project `docker.enabled: true`. An absent project activation leaves Docker disabled.

Use ordinary shell commands. Native file tools, extensions, MCP tools, and browser executors execute outside this shell boundary. Think-in-Code keeps its strict environment and private temporary storage regardless of shell mode.

## Local installations

Declare machine-local installations only in `~/.pi/agent/config/sandbox.json` under `environment.installations`. An installation maps a name to one or more canonical host roots and optional command directories relative to each root. Add an optional `files` list to authorize exact files relative to a root without exposing the containing directory. Selecting its name in `<project>/.pi/config/sandbox.json` adds the declared resources read-only and their command directories to PATH once, in global declaration order. A project can select or narrow global names, but cannot introduce a root. An omitted project selection inherits all global installations. An empty list selects none. No separate profile activation is required.

A declared installation adds its whole root read-only when `files` is absent, or only its selected regular files when `files` is present, including when it has no command directory. Legacy `environment.path` entries only change command lookup. The runtime revalidates roots and command-directory targets before admission. Filesystem isolation blocks access to undeclared external dependencies. Use `/sandbox installations` to preview canonical roots before saving; a redirected root must be authorized by its canonical location. See [Configuration](docs/configuration.md#local-installations).

## Documentation

- [Modes and profiles](docs/shell-capabilities.md)
- [Configuration and precedence](docs/configuration.md)
- [Docker authority](docs/docker-authority.md)
- [Runtime and limits](docs/runtime.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Shared shell context design and validation](../../../docs/brainstorming/2026-09-12-shared-shell-context-design.md)

A release installs the runtime bundle atomically and pins its real release path for the lifetime of the runtime. See [qualification and activation](docs/runtime.md#qualification-and-activation) for the tested release and evidence. The widget shows the selected mode, derived profile, engine state and Docker authorization separately from client exposure. Docker client inspection stays pending before admission. After admission it can show `CLI unavailable`, `Compose unavailable`, or that both are exposed. Exposure is a static scope check, not proof of client execution or daemon readiness. Run `/sandbox doctor` for paths, dependencies and planned or admitted scope details.
