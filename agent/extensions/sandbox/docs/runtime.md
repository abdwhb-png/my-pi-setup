# Sandbox runtime

Sandbox uses the provenance-pinned Zerobox binary at `~/.pi/bin/zerobox`.
Bash and Think collection use separate private leases below `~/.pi/zbx/`.
Analysis receives a new private lease for each request. Leases have owner-only
permissions and are the only paths eligible for stale cleanup.

`bash-general` uses host `/tmp` subject to the configured filesystem policy.
`think-strict` and `analysis-strict` use separate private `/tmp` namespaces, so
Think collection and analysis cannot read host or sibling temporary files.

`bash-general` sets HOME to the host user's home for normal `~/...` expansion.
It keeps the configured filesystem restrictions and does not add home-directory
write access. XDG, Bun and npm caches remain writable inside the private lease.
Docker configuration stays in the private lease so a host CLI
context cannot override the broker. Both strict Think profiles retain private
HOME directories. Sandbox Bash enables `pipefail` so the reported process status
includes failures before the final command in a pipeline.

The runtime fails closed when its binary, policy, setup protocol, FUSE deny
views, or required Linux facilities are unavailable. It does not fall back to
local execution. Docker uses a brokered private connection; the host Docker
socket is never mounted inside the Sandbox.

Linux is required. The runtime also requires `mkfifo`, `prlimit`, Node with
JSPI support for the Python analyzer, and the managed Zerobox binary.
