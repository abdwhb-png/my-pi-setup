# Sandbox runtime

Sandbox uses the provenance-pinned Zerobox binary at `~/.pi/bin/zerobox`.
Bash and Think collection use separate private leases below `~/.pi/zbx/`.
Analysis receives a new private lease for each request. Leases have owner-only
permissions and are the only paths eligible for stale cleanup.

`bash-general` uses host `/tmp` subject to the configured filesystem policy.
`think-strict` and `analysis-strict` use separate private `/tmp` namespaces, so
Think collection and analysis cannot read host or sibling temporary files.

The runtime fails closed when its binary, policy, setup protocol, FUSE deny
views, or required Linux facilities are unavailable. It does not fall back to
local execution. Docker uses a brokered private connection; the host Docker
socket is never mounted inside the Sandbox.

Linux is required. The runtime also requires `mkfifo`, `prlimit`, Node with
JSPI support for the Python analyzer, and the managed Zerobox binary.
