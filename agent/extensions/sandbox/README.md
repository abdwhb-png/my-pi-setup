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
        "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg"],
        "allowWrite": ["."],
        "denyWrite": [".env"]
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

Version 1 is Linux-only. It supports exact filesystem paths, public-domain
outbound allowlists, port-scoped loopback, deny-all networking, private temp,
environment filtering, nested-user-namespace blocking, and process-tree
termination. Managed networking rejects UDP and raw IP sockets at seccomp and
keeps host Unix sockets inaccessible. Dynamic filesystem globs, inbound
binding, arbitrary Unix
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
