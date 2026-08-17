# Save Tokens Compression

`save-tokens` selects one local compression backend. Headroom is default; no
automatic fallback switches to Edgee.

## Configuration

Set `saveTokens.compressor.backend` in `~/.pi/agent/settings.json` or
`<project>/.pi/settings.json`. Project settings deep-merge over global settings.

```json
{
  "saveTokens": {
    "compressor": {
      "backend": "headroom",
      "archiveOriginal": true,
      "backends": {
        "headroom": {
          "baseUrl": "http://127.0.0.1:8787",
          "timeoutMs": 1000
        },
        "edgee": {
          "baseUrl": "http://127.0.0.1:8320",
          "timeoutMs": 800
        }
      }
    }
  }
}
```

Supported environment overrides:

- `HEADROOM_COMPRESSOR_BASE_URL`
- `HEADROOM_COMPRESSOR_TIMEOUT_MS`
- `EDGEE_COMPRESSOR_BASE_URL`
- `EDGEE_COMPRESSOR_TIMEOUT_MS`

Backend selection and connection settings are resolved during extension setup.
After changing settings or these environment variables, run `/reload` or
restart Pi. Starting a new session alone does not rebuild the backend registry.

## Tool Policy

`find` output bypasses semantic backends because plain path listings can be
misclassified as prose and lose exact paths. Listings that fit the deterministic
cap budget remain intact. Larger listings use a deterministic head/tail cap and
archive the complete original before replacement.

The deterministic cap is expressed as an **estimated-token budget**
(`capFallbackTokens`, default `2700`), not a character count. The estimator is
Unicode-safe: it prices dense CJK/Kana/Hangul scripts at 1.5 code points per
token, astral emoji at one token each, and everything else at 3 code points per
token, iterating by code point so surrogate pairs are never split.
`maxFallbackBytes` (default `48000`) is a secondary hard guard on the rendered
result's UTF-8 byte length. Configure either under `saveTokens.compressor`.

## Switching Backends

From `~/projects/shared-services/compression`, stop the current Compose profile,
start the selected one, update `saveTokens.compressor.backend`, then run
`/reload`:

```sh
docker compose --profile headroom --profile edgee down
docker compose --profile headroom up -d --wait
# or: docker compose --profile edgee up -d --wait
```

Pi never builds, starts, or switches Docker services. See the compression
service README for image builds, health checks, egress verification, and gates.

## Failure And Local Data

Compression is fail-open: invalid config, timeout, unavailable service, or
invalid response preserves the original tool result. No automatic inter-engine
fallback occurs. Configured caps may replace a large failed result only after
archiving the original and embedding its recovery path.

Original results are stored under `~/.pi/agent/tool-result-archive` by default.
Compression telemetry is local under
`~/.pi/agent/save-tokens-telemetry`. Both directories can contain sensitive
content; protect them and keep retention settings appropriate. Telemetry write
failures do not block tool execution.