# sandbox

OS-level sandboxing for Bash commands using a sandbox runtime library.
Enforces filesystem and network restrictions at the OS level
(sandbox-exec on macOS, bubblewrap on Linux). The extension owns the
broad Bash sandbox broker and the strict analysis-sandbox broker used
by Think-in-Code.

The extension owns two process-global brokers:

1. **Bash execution broker** (`Symbol.for("pi.sandbox-bash-execution.v1")`),
   shared by `bash`, `safe_bash`, and interactive user Bash. Enabled
   state uses sandbox operations. Explicit disabled state uses local
   operations. Missing, uninitialized, unsupported, or failed state
   blocks execution instead of silently falling back locally.
2. **Strict analysis broker**
   (`agent/extensions/_shared/analysis/sandbox-analysis-broker.ts`),
   used by `think_execute`, `think_execute_file`, and
   `think_batch_execute`. Different policy: empty allowed domains, no
   project cwd mount, empty environment, no writable path.

The two brokers never share policy. The Bash broker intentionally
allows selected network destinations, local binding, and all Unix
sockets; reusing it for the analyzer would expose the analyzer to the
public network and the host's Docker socket.

The Bash broker is **disabled by default**. Enable with `/sandbox on`
or set `"sandbox.enabled": true` in settings. The strict analysis
broker is owned by Think-in-Code and follows its own lifecycle; it
fails closed when the runtime is missing or `--no-sandbox` is in
effect.

## Commands

| Command        | Description                           |
| -------------- | ------------------------------------- |
| `/sandbox`     | Show current status and configuration |
| `/sandbox on`  | Enable sandboxing for this session    |
| `/sandbox off` | Disable sandboxing for this session   |

When you run `/sandbox on` or `/sandbox off`, the new status is
persisted to `<sessionDir>/sandbox-state.json` so it survives a reload
of the same session. The Bash broker is **disabled by default** for
new sessions. Enable it explicitly per session, or set
`"sandbox.enabled": true` in settings.

## Per-session persistence and subagent propagation

The sandbox status is resolved at `session_start` using this priority
chain (highest wins):

1. `--no-sandbox` CLI flag — explicit disable for this run
2. `PI_SANDBOX_SESSION_STATUS` env var — `enabled` or `disabled`
3. `<sessionDir>/sandbox-state.json` — last toggle in this session
4. `<cwd>/.pi/settings.json` or `<cwd>/.pi/sandbox.json` — project config
5. `~/.pi/agent/settings.json` or `~/.pi/agent/sandbox.json` — global config
6. Built-in default (`enabled: false`)

When a parent process toggles `/sandbox on|off`, the extension also
sets `PI_SANDBOX_SESSION_STATUS` in the live process environment.
Subagent child Pi processes inherit that env at spawn, so they pick
up the parent's status on their own `session_start`. The persisted
`sandbox-state.json` is the durable record across restarts.

Only the `enabled` flag is overridden by these layers. The merged
`network` and `filesystem` config always comes from the static
settings files — security-relevant fields stay project-controlled.

## Security warning

Disabling the sandbox is a security risk (bash runs with full system
access). The extension surfaces this in two ways:

- **Footer widget** is always visible. `on` shows `🛡️ sandbox: on` in
  accent color; `off` shows `⚠ sandbox: off` in warning color so a
  disabled sandbox is never silent.
- **`session_start` notification** is emitted with level `warning` when
  the resolved status comes from any explicit layer (env, session
  file, project, global, `--no-sandbox`) and `enabled` is false.
  Default-off (no override, no config) stays quiet — there is nothing
  to warn about.
- **`/sandbox off`** emits a warning notify before applying the
  toggle, since the new state will persist for the session.

## Configuration

Configs are merged (project overrides global):

- `~/.pi/agent/settings.json` under `sandbox` (global)
- `<cwd>/.pi/settings.json` under `sandbox` (project-local)

```json
{
    "network": {
        "allowedDomains": [
            "github.com",
            "*.github.com",
            "lfs.github.com",
            "api.github.com",
            "npmjs.org",
            "*.npmjs.org"
        ],
        "deniedDomains": ["malicious.com"],
        "allowUnixSockets": ["/var/run/docker.sock"],
        "allowLocalBinding": false
    },
    "filesystem": {
        "denyRead": ["~/.ssh"],
        "allowRead": [],
        "allowWrite": [".", "src/", "test/", "/tmp"],
        "denyWrite": [".env", "config/production.json"]
    },
    "ignoreViolations": {
        "*": ["/usr/bin", "/System"],
        "git push": ["/usr/bin/nc"],
        "npm": ["/private/tmp"]
    },
    "enableWeakerNestedSandbox": false,
    "enableWeakerNetworkIsolation": false,
    "allowAppleEvents": false
}
```

Legacy compatibility is still kept for:

- `~/.pi/agent/sandbox.json`
- `<cwd>/.pi/sandbox.json`

Set `"sandbox.enabled": true` in settings to auto-enable on session
start.

## Flags

| Flag           | Description                                 |
| -------------- | ------------------------------------------- |
| `--no-sandbox` | Force disable sandboxing (overrides config) |

## Strict analysis broker (Think-in-Code)

The analysis broker is initialized with a fixed, downward-only policy:

```jsonc
{
    "network": {
        "allowedDomains": [],
        "strictAllowlist": true,
        "allowLocalBinding": false,
        "allowAllUnixSockets": false
    },
    "filesystem": {
        "allowWrite": [],
        "allowRead": [
            // Outer runtime libraries and sandbox package assets only.
            // The project cwd is NEVER mounted.
        ]
    }
}
```

The host initializes its own process-local `SandboxManager` with an
empty environment, no credentials, no writable path, and read access
only to required system runtime files and the sandbox package assets.
Linux `prlimit` enforces CPU/address-space limits; the parent wall
timer kills the whole process group. Inner QuickJS/Eryx limits and
output byte counting provide independent enforcement.

### Fixed worker dispatch

The model cannot select a binary, entrypoint, environment variable,
shell fragment, working directory, or filesystem path on the
analyzer. Only two fixed worker IDs exist: `quickjs` (JavaScript and
TypeScript via `@sebastianwessel/quickjs`) and `python` (Python via
`@bsull/eryx` in a dedicated Node JSPI worker). Process-group
cleanup, concurrency semaphore of two, hard limit clamps, protocol
validation, and bounded capture are enforced by the analysis broker.

`--no-sandbox`, missing bubblewrap/prlimit/Node JSPI, host crash,
protocol corruption, or runtime initialization failure publishes an
unavailable/error broker state. No unsandboxed fallback exists.

## Exact dependencies

Pinned at exact versions in `agent/extensions/sandbox/package.json`:

- `@anthropic-ai/sandbox-runtime@0.0.74` — outer Linux isolation
  (bubblewrap + seccomp-BPF). Exact-pinned after an upstream review
  accepted its sub-seven-day release age and proxy/abort/attribution
  fixes.
- `@sebastianwessel/quickjs@3.1.0` — JavaScript/TypeScript analyzer.
- `@bsull/eryx@0.6.0` — Python analyzer.

Other runtime requirements:

- Linux: `bubblewrap`, `socat`, `ripgrep`, `prlimit`
- `/usr/bin/node` with `--experimental-wasm-jspi` for the Python
  analyzer (Eryx documents JSPI but not Bun support)
- macOS: uses built-in sandbox-exec

The dependency-contract test in
`agent/extensions/sandbox/dependency-contract.test.ts` runs an
executable smoke at install time. A missing capability publishes an
unavailable broker state and fail-closes the analysis service.

## No-network analyzer policy

The analyzer network access is **always disabled**:

- `allowedDomains: []`
- `strictAllowlist: true`
- `allowLocalBinding: false`
- `allowAllUnixSockets: false`
- Outer sandbox runs with an empty environment and no writable path.

There is no `think_fetch_and_index`. Existing web and MCP tools retain
fetching. The Bash broker's network policy is intentionally separate
and is not reused by the analyzer.

## Attribution

Based on [pi-mono example extension](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/).
