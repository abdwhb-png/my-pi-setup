# ADR-025: Enforce dynamic deny globs and broker Docker access

## Status

Accepted

## Date

2026-09-06

## Context

ADR-023 accepted a Zerobox backend with exact filesystem paths and no Docker
daemon access. Static deny expansion cannot protect files that appear after a
command starts. Mounting the Docker Engine socket would be worse: Docker's
[daemon security guidance](https://docs.docker.com/engine/security/) treats
daemon access as highly privileged, and an unrestricted client can create a
container that controls the host.

Pi also needs one global operator-controlled authority for Docker grants. A
repository may reduce that authority, but must never grant itself another
endpoint, target, operation, or unsafe-container exception.

## Decision

### Enforce deny globs through a private FUSE view

Zerobox exposes explicit `deny_read_glob(pattern)` and
`deny_write_glob(pattern)` APIs. Exact-path APIs never infer glob syntax. Pi
interprets glob metacharacters only in `filesystem.denyRead` and
`filesystem.denyWrite`, then sends exact paths and patterns through separate
profile fields.

Relative patterns without `/` match basenames at every project depth. Relative
patterns containing `/` are project-root anchored. `*`, `?`, `[]`, `{a,b}`,
and `**` use `globset` with a literal `/` separator. `~` and absolute patterns
are supported. A pattern whose safe static prefix collapses to `/` is rejected.
A matching directory denies its descendants.

`denyRead` blocks reads, useful metadata, directory discovery, and every
mutation. `denyWrite` preserves reads and blocks creation, writing, deletion,
renaming, linking, and metadata mutation. Denies override allows. Both the
requested path and a followed symlink's resolved path are checked. Existing
hardlinks intentionally remain name-based because a path policy cannot infer
all inode aliases without changing its model.

For a policy containing globs, Zerobox mounts an owner-only FUSE passthrough
under its private runtime root. Bubblewrap remounts that view at the relevant
lower path only in the target namespace. Policies without globs retain the
ordinary Bubblewrap path. Missing `/dev/fuse`, missing `fusermount3`, or any
mount failure blocks spawn without static fallback.

One managed-resource owner moves the FUSE sessions, network proxy, Docker
broker, setup channel, and private files from `PreparedCommand` to
`SandboxChild`. Drop, timeout, kill, setup failure, and normal wait therefore
release only that execution's resources. Runtime directories include their
owner PID. The janitor ignores live and unattributed directories, unmounts
dead-owner FUSE views deepest-first, and removes only owner-controlled trees.

### Broker Docker instead of mounting its socket

The real Engine socket is never visible inside Bubblewrap. Zerobox accepts an
effective per-execution `DockerAccessPolicy` with three modes:

- `Disabled` removes inherited Docker connection variables and starts no
  broker.
- `Targeted` snapshots allowed container IDs, filters Engine requests and
  discovery, and injects a private loopback `DOCKER_HOST`.
- `Full` relays the complete Engine protocol through the same private bridge.
  It is equivalent to host control and can bypass other Zerobox restrictions.

Only local Unix endpoints are supported, defaulting to
`unix:///var/run/docker.sock`; rootless Unix socket paths are configurable.
TCP, TLS, SSH, and Docker contexts are outside v1.

Target selectors are either an exact container name or exact standard Compose
labels `com.docker.compose.project` plus `com.docker.compose.service`. All
matching replicas present at preparation are pinned. Later recreation does not
inherit access. The complete default operation bundle is `ps`, `inspect`,
`logs`, `stats`, `exec`, `start`, `stop`, and `restart`; a grant may reduce it.
Compose commands often need container discovery as well as their primary
operation, so an underspecified subset can make that command unavailable.

Targeted discovery returns only pinned IDs. An unknown or unpinned target gets
404; a known target with a disallowed operation gets 403. The broker tracks
only exec IDs it creates, supports streaming logs/stats/exec and HTTP upgrade,
and rejects detached or privileged exec. Request framing is bounded and rejects
duplicate content lengths, transfer-encoded requests, pipelining, oversized
bodies, encoded separators, and malformed paths.

Privileged containers, host namespaces, host bind mounts, runtime sockets,
devices, dangerous added capabilities, and disabled seccomp/AppArmor/label
confinement are excluded by default. A target is admitted only when its global
grant explicitly sets `allowUnsafeTarget: true`. The broker never logs request
bodies, exec commands, variables, authentication headers, or log content.

Docker `exec` runs inside the selected container and therefore uses that
container's mounts, network, and secrets. Those are not constrained by the
filesystem or network policy of the shell that invokes the Docker CLI.

### Keep Docker authority outside repositories

Pi reads Docker grants only from the Git-ignored
`~/.pi/agent/sandbox.global.json`. The loader expands a leading `~`,
canonicalizes every configured project root at startup, rejects duplicate roots
and unknown fields, and requires an exact match with the current canonical
project root. No match means `Disabled`.

The project `sandbox.docker` layer may disable access, reduce `Full` to
`Targeted`, remove targets or operations, or force an unsafe exception off. It
cannot set an endpoint or add any authority. An escalation attempt invalidates
the Sandbox configuration and prevents publication.

Pi compiles only the effective decision into a per-execution profile created
with mode `0600`. Zerobox never sees grants for other projects. Bash,
`user_bash`, Safe Bash, and Think shell execution consume the same effective
runtime, while analysis is always `Disabled`. Safe Bash and Think command
policies remain independent and must separately authorize the `docker`
command.

The `/sandbox` status and footer show `Docker off`, `targeted`, or `full`, plus
unsafe/full warnings. They do not reveal endpoints, target names, or grant
contents. `/sandbox off` and `--no-sandbox` select local execution, so the
Zerobox Docker policy is inactive.

## Consequences

### Positive

- Denies remain effective for files created and renamed after spawn.
- Non-glob policies pay no FUSE lifecycle cost.
- Targeted Docker access exposes only pinned resources and operations.
- Repositories can reduce but never create Docker authority.
- Broker or bridge failure causes Docker calls to fail without revealing the
  host socket.

### Negative

- Dynamic globs require working FUSE support and `fusermount3`.
- Path policy cannot protect a denied inode through a differently named
  pre-existing hardlink.
- Targeted `exec` inherits the selected container's own authority.
- `Full` Docker access is intentionally equivalent to host control.
- Docker Compose compatibility depends on retaining every discovery and
  operation call used by the installed client version.

## Release and rollback

This decision advances the managed fork to `v0.3.3-fork.9`. Pi pins the final
source commit, upstream/engine commits, ordered patch hashes, and Linux x64
binary hash in `runtime/zerobox-provenance.json`. The prior accepted binary and
matching provenance remain together under the existing rollback directory
until the new release passes both Zerobox and real Pi gates.

Rollback replaces the binary and provenance as one unit and restarts Pi
completely. `/reload` is not a migration or rollback proof for a changed global
runtime contract.

## Verification

Executable coverage includes glob syntax and invalid patterns, late creation,
renaming, directory descendants, symlinks, the documented hardlink limit,
read-versus-write denies, mount failure, owner-scoped cleanup, target snapshot
resolution, replicas, unsafe targets, API versions, malformed framing,
operation subsets, exec IDs, streaming, Docker CLI and Compose operations,
and full-mode lifecycle using uniquely named disposable containers with no host
bind mount or network.

Pi coverage verifies absent grants, exact canonical matching, monotone project
narrowing, escalation failures, private profile fields, analysis isolation,
Docker environment removal, runtime states, and redacted status rendering. The
final acceptance record is added only after the pinned binary, complete suites,
real Pi process, and resource-leak checks pass.
