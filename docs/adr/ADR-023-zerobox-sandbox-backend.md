# ADR-023: Zerobox sandbox backend for Pi

## Status

Accepted

> **Capability update (2026-09-06):**
> [ADR-025](./ADR-025-dynamic-deny-globs-and-docker-broker.md) supersedes this
> ADR's accepted fork release and its statements that dynamic deny globs and
> controlled Docker access are unsupported. Historical validation counts and
> rollback evidence below remain unchanged.

## Date

2026-09-05

## Context

[ADR-019](./ADR-019-think-in-code-native-extension.md) introduced an outer
Anthropic Sandbox Runtime (ASRT) boundary for Bash and the Think-in-Code
analysis workers. The pre-migration implementation coupled both consumers to
`SandboxManager`; the analysis host additionally parsed and rewrote private
Bubblewrap command text to remove `/tmp/claude`.

Pi needs a Linux-first backend with explicit argv, bounded setup supervision,
private temporary state, exact provenance, and no private command rewriting.
The migration must not weaken a filesystem or network guarantee that ASRT
actually enforces.

The runtime migration described below is implemented and accepted. ADR-019
remains the record for the unchanged Think-in-Code architecture, while this ADR
supersedes its ASRT-specific backend sections.

[ADR-024](./ADR-024-bash-execution-ownership-and-sandbox-runtime.md)
supersedes this ADR's Bash registration, local fallback, and separate broker
ownership. The Zerobox profiles, leases, isolation guarantees, worker
implementation, and managed binary decision remain accepted.

## Accepted fork release

The implementation pins this accepted source-first Zerobox release with an
immutable identity:

- version `0.3.3-fork.8` and tag `v0.3.3-fork.8`;
- fork commit `bcca4760e36c576f482385031c42a74ba69c374f`;
- upstream Zerobox `v0.3.3` at
  `9a7affd6c68fb2541c7c709559c40e08ba0a1872`;
- engine `rust-v0.131.0-alpha.22` at
  `9b8cf56cdefb09f54564ccc295fd42f6647f558f`;
- Linux x64 binary SHA-256
  `1623212b538f642c308250504c7a3ec6854471679e75dd4ff63b2d2bef43fcbb`;
- 20 ordered patches recorded in
  `agent/extensions/sandbox/runtime/zerobox-provenance.json`.

The release candidate passed format, strict Clippy for Zerobox and its Linux
sandbox, 104 Linux-sandbox unit tests, 118 Zerobox unit tests, 143 network-proxy
unit tests, the complete Rust workspace library gate, and all 119 integration
tests. Pi copies the verified binary to `~/.pi/bin/zerobox`; runtime resolution
never uses `PATH`, an npm package, or the development worktree.

## Decision

Generate one private Zerobox profile per prepared execution under `~/.pi/zbx/`,
without composing built-in profiles. Invoke only the public CLI with separate
`file`/`args`, `--strict-sandbox`, `--status-fd=3`, `-C`, a named private
profile, and `--` before the child argv.

Supervise protocol-v1 JSONL on FD 3. Setup is ready only after
`child_started`; `setup_error`, invalid or oversized JSONL, premature EOF, and
impossible event order fail closed. A target exit 125 remains distinct because
it follows `child_started`.

Use distinct `bash-general` and `analysis-strict` policies. They may share the
verified backend and probe, but never leases, child processes, or permissions.
Bash keeps one private lease per session. Each analysis request gets a fresh
lease. Children receive the real private `HOME` and `TMPDIR`; `ZEROBOX_HOME`
is launcher-only. Pi snapshots explicitly allowed target variables into the
private profile and launches Zerobox with only `ZEROBOX_HOME`. The fork stores
that target environment as `environment.json` inside a unique owner-only
directory. Bubblewrap reopens that directory read-only from a preserved file
descriptor after masking its denied parent, and Zerobox applies the snapshot
only in the final `execvpe`, after filesystem, network, and seccomp isolation.
A system Bubblewrap without `--ro-bind-fd` is rejected. Variables such as
`LD_PRELOAD`, `BASH_ENV`, and `NODE_OPTIONS` therefore cannot affect the
host-side Zerobox/helper chain. Bash grants the host-side managed TCP bridge read-only access
to `<lease>/zerobox-home/tmp/runs`; target writes remain denied, and the
`profiles` sibling remains covered by the stable lease-parent deny. Cleanup
waits 50 ms for late Bubblewrap mount housekeeping,
revalidates the owner marker, atomically detaches the lease path, and then
removes the detached tree. Stale recovery validates that its root is a private
directory rather than a symlink and removes only valid marked leases whose
owner PID is dead. Lifecycle transitions register unpublished candidates before
their first await; a concurrent disable or shutdown therefore cleans them or
publishes a cleanup error instead of losing a late failed cleanup.

Network is deny-by-default. Bash can allow explicit public domains or
endpoints. Loopback rules require a port, and `localhost`, `127.0.0.1`, and
`[::1]` are equivalent only at that port. Analysis has no network. Pi enables
no credential substitution, remote relay, generated CA, or TLS interception.
Proxy-routed children can create only the IP stream sockets needed by the TCP
bridge; IP datagram and raw sockets are denied by seccomp, including socket
types carrying `SOCK_CLOEXEC` or `SOCK_NONBLOCK` flags. `listen()` remains
denied in proxy-routed targets, so an ephemeral client bind cannot become an
inbound listener. The pre-created managed bridge runs outside the target
filter and exposes no listener descriptor in the target argv. Pi reserves all
six upper/lowercase `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY` variables from
the broker launcher environment, preventing Zerobox from delegating resolution
to an unchecked upstream proxy. Direct connections reclassify the final
resolved address at the transport boundary; controlled tests cover post-CNAME
private resolution and a public-to-private rebinding answer.

TypeScript 7.0.2 is the only TypeScript compiler in the `agent` package. The
sandbox package keeps TypeScript 6.0.3 for the QuickJS programmatic API and
`@typescript/native` aliased to TypeScript 7.0.2 for the native compiler. The
official `@typescript/typescript6` wrapper is not used because Bun 1.3.14
resolves its nested `@typescript/old` alias back to the wrapper and exposes an
empty API; executable QuickJS coverage guards this compatibility choice.
QuickJS keeps its 1 GiB guest heap ceiling. Its Bun/JSC worker has a separate
4 GiB virtual-address ceiling because a 2 GiB process ceiling intermittently
failed valid TypeScript transforms before the QuickJS limit was reached.

## Supported limits

Version 1 supports Linux only, exact read/write denies, outbound domain
allowlists, port-scoped loopback, complete network disable, private temp and
environment filtering, nested-user-namespace blocking, and process-tree
termination.

It does not support dynamic deny globs, inbound binding, arbitrary Unix
sockets, macOS, or Windows. Configurations requesting those capabilities fail
before publication. Both candidate profiles passed the Linux gate and the
extension now publishes Bash and analysis synchronously after both factories
are ready. ASRT has been removed from the sandbox package and lockfile.

The active ASRT deny-glob behavior was replayed on Linux with the tracked
[`legacy-asrt-deny-characterization.ts`](../../agent/extensions/sandbox/runtime/legacy-asrt-deny-characterization.ts)
script. Its immutable recorded output, host/kernel identity, ASRT 0.0.74
package and entrypoint hashes, and replay command live in
[`legacy-asrt-deny-characterization.json`](../../agent/extensions/sandbox/runtime/legacy-asrt-deny-characterization.json).
Each target was absent before and after command wrapping, and each case
included an ordinary sibling write as a control.
An exact `.env` deny blocked late creation while leaving the sibling writable.
By contrast, `.env.*`, `*.pem`, `*.key`, and `*/node_modules/*` all left their
matching late-created file writable, as well as the control. ASRT 0.0.74 also
reports in its Linux implementation that such `denyWrite` globs are skipped
because Bubblewrap requires concrete paths. These four active configuration
entries therefore were not effective Linux guarantees and can be removed
rather than approximated with a point-in-time expansion.

## Rollback

The tracked repository base before this migration is commit `5abbe19`, but the
worktree already contained uncommitted Think-in-Code and sandbox work. No
complete snapshot was captured before the first migration mutation, and the
original bytes of the dirty sandbox lockfile and several non-patch mutations
are absent from the session audit. Consequently `5abbe19` is not an exact ASRT
rollback and must not be restored over this worktree. A byte-exact historical
ASRT rollback cannot be claimed or reconstructed without a user-supplied
checkpoint.

On 2026-09-05, the user explicitly accepted this ADR and waived byte-exact ASRT
rollback as an acceptance prerequisite. This waiver does not create or imply a
historical checkpoint: the unavailable pre-migration bytes remain unavailable.

The previously accepted Zerobox binary and its matching provenance are retained
together under
`~/.local/state/pi/rollback/zerobox-fork.6-af290ad53ca67/`.
Its manifest records binary SHA-256
`af290ad53ca67ddf5cfadd1610cbf27ae4d6faadaf8db5ea696ac7e649fab574`
and provenance SHA-256
`401a2e6734e91936048a0baf08def697d2a19098df79949a9daf2ad20a3fe4fc`.
Those two files restore the prior managed Zerobox release only; they do not
restore ASRT source. Any source rollback must restore Bash and analysis
together from an independently verified checkpoint, never retain a mixed
backend state, and never use `git restore` against the dirty worktree. Only
Pi-owned leases with a valid marker under `~/.pi/zbx/` may be removed.

## Verification

Executable coverage verifies the accepted binary identity, both TypeScript
versions, QuickJS and Eryx execution, strict status-FD sequencing, private
leases, exact config capability rejection, Bash filesystem/environment/stdin
rules, analysis read isolation and network denial, port-scoped loopback,
nested redirect denial, DNS-to-private rejection, UDP/raw-socket denial,
managed bridge cleanup,
nested-namespace denial, process-tree timeout cleanup, and post-timeout reuse.
Lifecycle tests verify that neither broker exposes an enabled generation until
the managed backend probe and both service factories succeed.

The final Pi migration gate passes 207 tests with 875 assertions across 21
files, including ten real Linux contract cases with 63 assertions and no
security skips. The unchanged Think-in-Code consumer contract passes 21 tests
with 148 assertions across its parity and pipe-ID regression suites. The gate
leaves no lease or sandbox worker behind.

This ADR supersedes only the ASRT-backend sections of ADR-019. Think-in-Code's
public broker, fixed worker protocol, WASM runtimes, storage, redaction, and tool
contracts remain unchanged.

## Fork maintenance

For every fork update, record the new upstream and engine refs and immutable
commits, replay the ordered patch series, build a source-first release, and
publish a new provenance manifest and binary hash. Run the fork gate before the
Pi gate. Retain the previously accepted managed binary and its provenance until
the new Bash and analysis profiles have passed together so rollback can restore
both consumers as one generation.
