# Sandbox runtime

Sandbox uses the provenance-pinned Zerobox binary at `~/.pi/bin/zerobox`.
Bash and Think collection use separate private leases below `~/.pi/zbx/`.
Analysis receives a new private lease for each request. Leases have owner-only
permissions and are the only paths eligible for stale cleanup.

`bash-general` uses private `/tmp` by default. An explicit local `tmp` grant
with the integrated profile permits host `/tmp`, subject to narrower preferences.
`think-strict` and `analysis-strict` use separate private `/tmp` namespaces, so
Think collection and analysis cannot read host or sibling temporary files.

`bash-general` sets HOME to the host user's home for normal `~/...` expansion.
It keeps the configured filesystem restrictions and does not add home-directory
write access. XDG, Bun and npm caches remain writable inside the private lease.
Docker configuration stays in the private lease so a host CLI
context cannot override the broker. Both strict Think profiles retain private
HOME directories. Sandbox Bash enables `pipefail` so the reported process status
includes failures before the final command in a pipeline.

For a targeted Docker grant with a host-access exception, the broker removes
arbitrary persistent `exec` and recognizes only fixed read-only bind probes. A
break-glass grant is held in the session runtime, binds to one exact container
ID and is never loaded from persistent authority. It defaults to five minutes
and accepts a user-selected duration from one through thirty minutes. Its expiry
replaces the runtime so commands still using the old grant are interrupted.

The runtime fails closed when its binary, policy, setup protocol, FUSE deny
views, or required Linux facilities are unavailable. It does not fall back to
local execution. Docker uses a brokered private connection; the host Docker
socket is never mounted inside the Sandbox.

The shared runtime distinguishes `uninitialized`, `reconfiguring`, `enabled`,
`disabled` and `error`. An enabled snapshot includes the active Docker summary.
Bash, safe_bash and Think resolve their execution service when dispatched;
an adapter created before a reload does not retain the old service.

During reconfiguration, new requests wait at most 30 seconds and keep their
original total deadline and cancellation signal. Session replacement invalidates
waiting requests. Only successful publication allows a pending request to run,
once. Shell profile and capability changes publish policy immediately and retain
old runtimes until admitted operations finish. Recheck authority and the runtime
policy fingerprint before dispatch. A queued call cannot use a stale wider
policy. Session replacement and Docker grant transitions retain their explicit
interrupting behavior. Never replay interrupted commands automatically.
The agent receives break-glass activation and expiration feedback,
using steering during an active turn and the next context otherwise. A failed
or disabled runtime gives no local fallback to requests waiting for Sandbox.

Local Zerobox builds record the base source commit, source diff SHA-256 and
binary SHA-256 in `runtime/zerobox-provenance.json`. The base release version
alone does not identify a locally patched binary. Rebuild and update provenance
together. Restart Pi completely for the shell capability contract so every
entrypoint uses the same schema and shared registry generation.

Linux is required. The runtime also requires `mkfifo`, `prlimit`, Node with
JSPI support for the Python analyzer, and the managed Zerobox binary.
