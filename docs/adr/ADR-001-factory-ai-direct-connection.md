# ADR-001: Factory AI Direct Connection Architecture

## Status
Accepted

## Date
2025-07-16

## Context

The Factory AI provider in Pi currently uses `@factory/droid-sdk`'s local subprocess
mode: `createSession()` spawns the `droid` CLI binary and communicates over a local
WebSocket (`ws://127.0.0.1:<port>`). This is considered a "non-direct" connection
because it depends on an external binary rather than making direct HTTP calls.

The goal is to make Factory AI a "direct strict connection" provider — one that
communicates directly with Factory's servers over the network, without any local
binary dependency.

Research into Factory's API surface revealed two network-accessible backends:

1. **Official relay**: `wss://relay.factory.ai` — WebSocket + JSON-RPC 2.0, the
   same protocol the SDK uses locally. This is Factory's supported remote endpoint.
2. **Google Cloud backend**: `cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`
   — HTTP POST with Gemini-shaped request bodies and standard SSE streaming. This
   is the backend the `droid` binary itself talks to (discovered via CLIProxyAPI's
   Antigravity executor).

Both bypass the local binary. Both require Google OAuth tokens (obtained during
`/login factory-ai`). But they differ in protocol, stability guarantees, and
implementation complexity.

**Related**: `pi-plans/factory-ai-provider-integration.md` (original integration plan),
`agent/extensions/ai-providers/` (current implementation).

## Decision

**Use a dual-transport architecture: primary relay via WebSocket, with HTTP+SSE fallback.**

`streamSimple` tries the official relay (`wss://relay.factory.ai`) first. If the
relay is unreachable (connection error, timeout), it falls back to direct HTTP+SSE
to Google Cloud (`cloudcode-pa.googleapis.com`). Both paths produce the same Pi
`AssistantMessageEventStream` output.

Auth: `/login factory-ai` now captures **both** the Factory API key (for the relay)
and the raw Google OAuth access/refresh tokens (for the cloudcode fallback). Token
refresh is handled separately for each path.

```
streamSimple(model, context, options)
  │
  ├── PRIMARY: connectDaemon({ apiKey, machine: remoteConfig })
  │     └── wss://relay.factory.ai (WebSocket + JSON-RPC 2.0)
  │           └── DaemonSession.stream() → Pi events
  │
  └── FALLBACK (on connection error):
        fetch(cloudcode-pa.googleapis.com, { method: "POST", ... })
          └── HTTP + SSE (Gemini-shaped request/response)
                └── Parse SSE → Pi events
```

## Alternatives Considered

### A. Subprocess only (current approach)
Keep using the local `droid` binary. Rejected because it's not a direct connection —
the binary is an external dependency, and Pi's provider model favors direct HTTP.

### B. Official relay only (no fallback)
Connect to `wss://relay.factory.ai` directly, dropping the local binary. Rejected
because a single point of failure — if Factory's relay is down or unreachable,
Factory AI is completely unavailable.

### C. HTTP+SSE only (no relay)
Use only `cloudcode-pa.googleapis.com` with Gemini-shaped requests. Rejected
because this is Google's internal backend, not Factory's documented public API.
Factory could change or restrict access without notice. However, it's valuable as
a fallback when the relay is unreachable.

### D. Dual transport (chosen)
Combines B and C. Relay-first for official support, SSE fallback for resilience.
The trade-off is more code (two transport implementations, dual token management),
but gains resilience against relay outages and backend migration risk.

## Consequences

### Positive
- **No local binary dependency**: Factory AI works without the `droid` CLI installed
- **Resilience**: Relay outage doesn't block Factory AI — SSE fallback takes over
- **Official path**: Primary path uses Factory's supported remote endpoint
- **Proven fallback**: CLIProxyAPI has used the cloudcode SSE path in production

### Negative
- **Dual auth**: Must store and refresh both Factory API key and Google OAuth tokens
- **Two transport implementations**: `streamViaRelay()` and `streamViaCloudCode()`
  in `sdk-bridge.ts`, plus a new `gemini-translator.ts` for SSE parsing
- **Fallback latency**: Connection timeout before fallback kicks in
- **Cloudcode fragility**: The Google Cloud endpoint could change without notice
  (mitigated by being fallback-only)

### Files affected
- `shared/oauth.ts` — dual token capture + refresh
- `shared/sdk-bridge.ts` — split into relay path and cloudcode path
- `shared/gemini-translator.ts` — new: Pi ↔ Gemini format translation + SSE parsing
- `providers/factory-ai.ts` — wire Google token to streamSimple
- `providers/factory-models.ts` — unchanged (model discovery stays SDK-based)

### Risks
- Factory may deprecate or secure the `cloudcode-pa.googleapis.com` endpoint
- Google OAuth token refresh adds complexity (tokens expire in ~1 hour)
- Two code paths to maintain and debug
