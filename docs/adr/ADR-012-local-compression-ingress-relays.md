# ADR-012: Local compression ingress relays

## Status

Accepted

## Date

2026-08-17

## Context

Headroom and Edgee process tool results that may contain source code, logs,
credentials, and other sensitive local data. Both engines therefore need a
topology-enforced egress block, not only application offline flags.

Docker networks marked `internal: true` provide that engine boundary, but
Docker Desktop 4.86.0 with Docker 29.7.2 did not create usable host port
bindings for containers attached only to such a network. A successful response
from an expected localhost port is insufficient evidence: Docker runtime
bindings must also be inspected because another host process may own the port.

## Decision

Keep each compression engine only on the internal `compression` network and
publish no engine port. Add one dedicated fixed-target relay per backend:

- `headroom-relay`: `127.0.0.1:8787` to `headroom:8787/v1/compress`;
- `edgee-relay`: `127.0.0.1:8320` to `edgee:8320/compress`.

Each relay is dual-homed on its backend-specific ordinary ingress bridge and
the internal engine network. Relays accept only their expected method/path,
construct upstream requests from constants, discard client forwarding headers,
bound request and response bodies, and use a total upstream deadline. Engine
services remain read-only, drop all capabilities, and enable
`no-new-privileges`.

The `egress-canary` is verification infrastructure only. It runs under the
`verification` profile and is started only around its test.

## Alternatives Considered

### Publish engine ports directly

Rejected. Host publication conflicts with the required internal-only engine
network on the verified Docker Desktop runtime.

### Dual-home engines

Rejected. Connecting an engine to an ordinary bridge restores an egress path
and removes the topology-enforced confidentiality boundary.

### Use one configurable generic relay

Rejected. Configurable upstream hosts, paths, or schemes increase SSRF risk and
the audit surface. Two small fixed relays are easier to prove.

### Add automatic fallback between engines

Rejected. It makes data flow depend on availability and can activate a backend
the operator did not select.

## Consequences

- Pi URLs remain `http://127.0.0.1:8787` and
  `http://127.0.0.1:8320`.
- Engines have no default route and no host bindings.
- Relays are trusted components. Their ingress bridges may egress, so relay
  code and dependencies require security review.
- Runtime verification must inspect bindings/routes, test engine egress, and
  prove cleanup after every run.
- Docker image changes require rebuild before runtime validation.

## Residual Risks

- A relay vulnerability can expose the ordinary ingress network.
- Host-local processes can call loopback endpoints.
- Edgee uses a vendored public compressor version that no longer receives
  upstream maintenance in the current Edgee tree.
- Local archives and telemetry may retain sensitive data despite zero remote
  egress.

## Verification

- Compose tests enforce internal engines and dedicated ingress relays.
- Relay tests cover fixed targets, rejected methods, JSON/body limits, header
  stripping, redirects, response limits, structured errors, and total timeout.
- Managed E2E checks runtime bindings, missing engine default routes, failed
  public egress probes, loopback compression, canary isolation, and empty
  Compose state after cleanup.