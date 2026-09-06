# sandbox

Linux OS-level Zerobox runtime for Bash consumers and Think-in-Code analysis.
The extension invokes the provenance-pinned Zerobox fork at
`~/.pi/bin/zerobox`; it never resolves a sandbox binary from `PATH` or a
development checkout.

Sandbox registers no `bash`, `safe_bash`, or `user_bash` surface. The
`bash-execution` extension owns those Pi interfaces and consumes the runtime
contract published here.

## Lifecycle and fail-closed publication

The extension owns one tagged process-global Sandbox runtime at
`Symbol.for("pi.sandbox-runtime.v2")`. On enable it
validates configuration, probes the managed binary, creates the Bash session
lease, constructs the analysis service, and then publishes both services in
one synchronous assignment. During transitions the runtime is `uninitialized`;
initialization failures publish a bounded `error` state. Owner tokens prevent a
stale reloaded instance from publishing or releasing the current runtime.
Sandbox never supplies a local fallback.

Bash has one private lease per session. Each analysis request has a new lease.
Leases live below `~/.pi/zbx/`, use owner-only permissions, contain an explicit
owner marker, and are the only paths eligible for stale cleanup. The launcher
uses protocol-v1 JSONL on FD 3: only `child_started` makes a process ready;
setup errors, corrupt status, premature EOF, and impossible ordering fail
closed. `HOME` and `TMPDIR` point into the lease and `ZEROBOX_HOME` remains a
launcher-only variable. The host-side managed TCP bridge receives read-only
access to the dedicated `zerobox-home/tmp/runs` subtree; target writes,
profiles, and all other lease control data remain denied.

## Commands and persistence

| Command        | Description                                   |
| -------------- | --------------------------------------------- |
| `/sandbox`     | Show current status and configuration         |
| `/sandbox on`  | Enable the Sandbox runtime for this session   |
| `/sandbox off` | Publish an explicit disabled runtime state    |

The Sandbox runtime is disabled by default. The effective `enabled` value uses, in
descending priority: `--no-sandbox`, `PI_SANDBOX_SESSION_STATUS`, the session's
`sandbox-state.<sessionKey>.json`, project config, global config, then the built-in
default. Static security fields continue to come from project/global config. The
former directory-wide `sandbox-state.json` is intentionally ignored because Pi
stores multiple sessions in one directory and the legacy state cannot be
attributed safely. `sessionKey` is the SHA-256 digest of Pi's public session ID.

## Supported configuration

```json
{
    "enabled": true,
    "network": {
        "allowedDomains": ["github.com", "*.github.com", "localhost:8317"],
        "deniedDomains": []
    },
    "filesystem": {
        "allowRead": [],
        "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "**/*.pem"],
        "allowWrite": ["."],
        "denyWrite": [".env", "generated/**"]
    },
    "environment": {
        "allowedVariables": [],
        "deniedVariables": [],
        "variables": {}
    }
}
```

Project settings override global settings. The preferred locations are the
`sandbox` keys in `<cwd>/.pi/settings.json` and
`~/.pi/agent/settings.json`; legacy `sandbox.json` files remain readable.

Only `filesystem.denyRead` and `filesystem.denyWrite` accept globs. A relative
pattern without `/`, such as `*.pem`, matches basenames at every depth under
the project root. A relative pattern containing `/` is anchored to that root.
`*`, `?`, character classes, brace alternatives, and `**` use `globset`
semantics with `/` as the separator. `~` and absolute patterns remain valid,
but a pattern whose safe static prefix is only `/` is rejected.

When a deny list contains a glob, Zerobox creates a private FUSE passthrough
view and bind-mounts it only inside the command namespace. This catches files
created or renamed after spawn. `denyRead` hides matching entries and blocks
all mutations; `denyWrite` keeps reads available but blocks creation, writes,
deletion, renames, links, and metadata changes. Requested and resolved symlink
paths are both checked. Existing hardlink aliases retain path-by-name
semantics. Missing `/dev/fuse`, `fusermount3`, or a failed mount blocks the
spawn; Zerobox never falls back to a static expansion. Policies without globs
keep the ordinary Bubblewrap path and do not mount FUSE.

## Docker authority

Docker access is disabled unless the canonical project root has an exact grant
in the Git-ignored `~/.pi/agent/sandbox.global.json` authority file:

```json
{
    "docker": {
        "grants": [
            {
                "projectRoot": "~/projects/app",
                "mode": "targeted",
                "endpoint": "unix:///var/run/docker.sock",
                "targets": [
                    {
                        "selector": {
                            "type": "compose-service",
                            "project": "app",
                            "service": "api"
                        },
                        "operations": ["logs", "inspect"],
                        "allowUnsafeTarget": false
                    }
                ]
            }
        ]
    }
}
```

The authority file accepts only local Unix endpoints. `projectRoot` expands a
leading `~`, resolves symlinks, and must match the current canonical project
root exactly. Duplicate roots, unknown fields, ambiguous targets, and
group/world-writable or symlinked authority files fail closed. An absent grant
means `Docker off`.

A project `sandbox.docker` value may only disable or narrow its global grant.
It can reduce `full` to `targeted`, remove targets or operations, and force
`allowUnsafeTarget` to `false`. It cannot add an endpoint, target, operation,
or unsafe exception. Any attempted escalation invalidates the complete Sandbox
configuration.

Targeted mode resolves exact container names or the standard Compose project
and service labels once before spawn, then pins the matching container IDs for
that execution. It supports `ps`, `inspect`, `logs`, `stats`, `exec`, `start`,
`stop`, and `restart`; an omitted operation list grants this complete bundle.
Discovery is filtered to pinned IDs, unknown targets return 404, forbidden
operations return 403, and only broker-created exec IDs can be used. Detached
or privileged exec is rejected.

Targets with host namespaces, privileged mode, host bind mounts, runtime
sockets, devices, dangerous added capabilities, or disabled confinement are
excluded. Only `allowUnsafeTarget: true` in the global authority file can admit
one, and the widget and `/sandbox` show a warning without exposing endpoints or
target names. Compose commands may require discovery plus the operation they
perform; reducing the bundle too far can therefore make the corresponding
Compose command unavailable.

The host Docker socket is never mounted in the sandbox. Zerobox brokers it over
a private owner-only Unix socket and a loopback bridge exposed as
`DOCKER_HOST=tcp://127.0.0.1:<private-port>` inside the namespace. Inherited
Docker connection variables are removed first. `full` mode forwards the whole
Engine API and is explicitly equivalent to host control; it can bypass other
filesystem and network restrictions through Docker. `exec` necessarily uses
the selected container's own mounts, network, and secrets, outside the command
sandbox policy. See Docker's [daemon security guidance](https://docs.docker.com/engine/security/).

With `/sandbox off` or `--no-sandbox`, command execution is local and the
Zerobox Docker policy is inactive. A Docker grant never authorizes the
`docker` shell command in Safe Bash or Think-in-Code; their independent command
policies must allow it separately. Analysis workers always receive Docker
mode `disabled`.

Version 1 is Linux-only. It supports exact filesystem paths, dynamic deny
globs, public-domain outbound allowlists, port-scoped loopback, deny-all
networking, optional brokered Docker access, private temp, environment
filtering, nested-user-namespace blocking, and process-tree termination.
Managed networking rejects UDP and raw IP sockets at seccomp and keeps host
Unix sockets inaccessible. Inbound binding, arbitrary target-visible Unix
sockets, ASRT-only fields, macOS, and Windows are rejected before publication.

## Strict analysis service

The model selects only a language and program. The host selects a fixed
QuickJS or Node/Eryx worker, invokes it as structured `file`/`args` through
Zerobox, and sends model data over a private FIFO only after the status channel
confirms `child_started`. The analysis policy has no project mount, no inherited
environment, no network, and no writable path outside its lease. Linux
`prlimit`, parent wall-time/output limits, process-group cleanup, and the inner
WASM runtime provide independent limits.

## Exact dependencies

The sandbox package keeps both requested compiler generations:

- `typescript@6.0.3` for the QuickJS programmatic transform API;
- `@typescript/native` as `npm:typescript@7.0.2` for the TypeScript 7 native
  compiler.

The `agent` package itself contains only `typescript@7.0.2`.
`@sebastianwessel/quickjs@3.1.0`,
`@jitl/quickjs-ng-wasmfile-release-sync@0.32.0`, and
`@bsull/eryx@0.6.0` are exact-pinned. ASRT is not installed.

Operational requirements are Linux, `/usr/bin/mkfifo`, `/usr/bin/prlimit`, and
`/usr/bin/node` with JSPI support. The managed Zerobox version, hash, source
commit, engine commit, and ordered patch hashes are recorded in
`runtime/zerobox-provenance.json` and verified by executable tests.
