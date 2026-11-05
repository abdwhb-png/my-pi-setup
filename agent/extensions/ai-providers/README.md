# AI providers configuration

This repository extension registers CPA through Pi's public provider API. Its configuration is `~/.pi/agent/config/ai-providers.json`; a trusted project's `.pi/config/ai-providers.json` overrides it. Provider properties merge individually, and project model rules append to global rules. Project configuration requires saved trust. Reload Pi after changing configuration; restart it after changing launch environment variables.

```json
{
  "providers": {
    "cpa": {
      "enabled": true,
      "baseUrl": "http://localhost:8317/v1",
      "refreshTtlMs": 30000,
      "silentCatalogDiff": false
    }
  },
  "maxVisibleRows": 20,
  "modelRules": []
}
```

| Setting | Meaning and default |
| --- | --- |
| `providers.cpa.enabled` | Register CPA, `true` by default. |
| `providers.cpa.baseUrl` | CPA OpenAI-compatible API root, default `http://localhost:8317/v1`. Nonempty `CLIPROXY_BASE_URL` takes precedence. The URL must use HTTP(S), with no embedded credentials, query or fragment. |
| `providers.cpa.refreshTtlMs` | Positive integer catalog verification TTL in milliseconds, default `30000`. `/cpa-refresh` bypasses the TTL. |
| `providers.cpa.silentCatalogDiff` | Suppress catalog drift notices, default `false`. Availability and authentication failures remain observable. |
| `maxVisibleRows` | Positive integer maximum rows in `/providers`, default `20`. |
| `modelRules` | Ordered metadata overrides, default `[]`. Pattern rules apply before exact IDs; later matching rules take precedence. |

Configure `CLIPROXY_API_KEY` through the destination's secure environment or `.env` channel. Credentials, OAuth data and machine connections are excluded from releases. Provider declarations do not disable Pi's built-in providers. CPA is the only provider currently registered by this extension.

The [complete example](../../config/ai-providers.example.json) shows every effective configuration setting and every supported standard metadata field. Its models, endpoints, limits and prices are fictional examples, not model specifications. Verify real model capabilities and pricing before using an override.

A rule requires `match.id` (supports `*` and `?`). Optional `match.provider`, `match.ownedBy`, and additional scalar discovery attributes narrow the match. `metadata` supports `api`, `name`, `baseUrl`, `contextWindow`, `maxTokens`, `reasoning`, `input`, `cost`, `thinkingLevelMap`, `compat`, `samplingParams`, and `headers`. `cost` includes `input`, `output`, `cacheRead`, `cacheWrite`, and optional `tiers` with `inputTokensAbove` thresholds. Input modalities must include `text`; image-capable models may also include `image`. Rules containing fields that the rules engine would discard are rejected instead of silently losing those fields. Provider-specific JSON metadata remains subject to the existing rules engine and the selected Pi provider API.

## Converting existing configuration

The old root-level `cpa` object, boolean provider entries and unused `widgets` setting are rejected. Move the root CPA fields into `providers.cpa`, replace `providers.cpa: true` with `providers.cpa: { "enabled": true }` (likewise for `false`), and remove `widgets`. Preserve your existing values and model rules. Errors identify the field without printing its value. There is no compatibility reader or automatic rewrite of another machine's files.

## Portable updates

Edit these settings in their normal destination file. `pi-setup` preserves machine differences from the previously delivered defaults during update and rollback; incompatible changes stop the operation. An exported `CLIPROXY_BASE_URL` still has runtime precedence. See the [installation guide](../../../docs/portable-setup.md).
