# ADR-002: CLIProxyAPI as Central Model Provider with Static Model Registry

## Status
Accepted

## Date
2025-06-29

## Context

Pi needs access to models from multiple AI providers: OpenCode Go (API key subscription), OpenRouter (API key), and Antigravity (OAuth subscription via Google). Without a central routing layer, each provider would need to be configured separately in Pi — with different auth flows, different API formats, and no failover between them.

Additionally, sub-agents (worker, scout, reviewer, etc.) need resilience: if one model is unavailable (rate-limited, quota exhausted, dead endpoint), a fallback should automatically take over. Changing models via `/model` in a session mutates `settings.json`, which could break sub-agent configurations if they depend on the default provider.

Model metadata (context window, max output tokens, pricing) is not available from all upstream APIs. OpenRouter exposes rich metadata via its `/v1/models` endpoint, but OpenCode Go and CPA (Antigravity) only return model IDs. Researching and hardcoding these values manually is tedious, especially as models are added or rotated.

## Decision

### 1. CLIProxyAPI (CPA) as central router

CLIProxyAPI runs as a Docker service at `/home/abdwhb/projects/shared-services/cliproxy/`. It exposes an OpenAI-compatible API on `localhost:8317`. All upstream providers are configured within CPA's `config.yaml` — Pi only knows about the single `cpa` provider in `models.json`.

```
Pi → CPA (localhost:8317) → OpenCode Go (round-robin, 2 API keys)
                           → OpenRouter (pool global)
                           → Antigravity (Google OAuth)
```

This keeps Pi's configuration minimal and makes CPA reusable by other tools (Claude Code, Codex CLI).

### 2. Provider isolation via alias namespacing

CPA routes models by matching the requested model name against configured aliases. Same alias across multiple providers = round-robin between them. Different alias = isolated routing.

| Group | CPA prefix | Alias pattern | Rotation scope |
|---|---|---|---|
| OpenCode Go (isolated) | `ocg` | `go-deepseek-v4-flash` | Between Go API keys only |
| Pool global (OpenRouter) | `or` | `deepseek/deepseek-v4-flash` | All providers with same alias |
| Antigravity | (none) | `claude-sonnet-4-6` | Single OAuth account |

Pi sends prefixed model IDs: `ocg/go-deepseek-v4-flash` → CPA strips `ocg/` → matches alias `go-deepseek-v4-flash` → routes exclusively to the OpenCode Go provider group. Unprefixed models (e.g. `deepseek/deepseek-v4-flash`) match the pool global and rotate across all providers that declare that alias.

### 3. models.json as authoritative model registry

Despite the appeal of dynamic model discovery from APIs, we use a static `models.json` for the following reasons:

- **OpenRouter** is the only upstream that exposes full metadata (context_window, pricing, max_completion_tokens). Neither OpenCode Go nor CPA expose context or pricing.
- **Antigravity** models have no discoverable metadata — model IDs are CPA-internal and context/pricing must be sourced from provider docs (Anthropic, Google).
- **Context windows and max tokens** are stable and rarely change — the research cost is paid once.
- **Pricing** from OpenCode Go is documented on a web page, not an API endpoint.
- A static registry guarantees Pi starts with a known-good model list regardless of upstream API availability.

The maintenance burden is mitigated by:
- Using CPA's `/v1/models` as a completeness check (models appearing there should be in models.json)
- Family-based defaults for Antigravity models (Claude=1M/64K, Gemini=1M/65K)
- Documenting pricing sources in CONTEXT.md

### 4. cpa/ provider prefix for sub-agent resilience

Sub-agents use an explicit provider prefix in their model configuration:

```json
"worker": {
  "model": "cpa/qwen/qwen3.6-plus-preview:free",
  "fallbackModels": ["cpa/deepseek/deepseek-v4-flash"]
}
```

The `cpa/` prefix locks the provider to CLIProxyAPI regardless of `defaultProvider` or `/model` changes during a session. This prevents `/model` from silently breaking sub-agent model assignments. The model ID after the prefix routes through CPA's alias matching to the appropriate group (pool global, in this case).

### 5. Config via template + .env

CPA's `config.yaml` is generated from `config.template.yaml` at container startup using `${VAR}` substitution (via `entrypoint.sh` calling `envsubst`). API keys live in `.env` (gitignored). This avoids hardcoding secrets in tracked configuration files while keeping the template readable and version-controlled.

```yaml
# config.template.yaml (committed)
api-key-entries:
  - api-key: "${OCG_KEY_ONE}"
  - api-key: "${OCG_KEY_TWO}"
```

```bash
# .env (gitignored)
OCG_KEY_ONE=sk-...
OCG_KEY_TWO=sk-...
```

## Alternatives Considered

### Per-provider Pi extensions with direct API access

Each provider would have its own Pi extension (similar to the Factory AI integration) with custom `streamSimple` implementations, OAuth flows, and model catalogs.

- **Pros**: No external proxy dependency, tighter integration with Pi's model registry and cost tracking, live model discovery from SDKs.
- **Cons**: No round-robin across providers, no failover, each extension must handle auth, streaming, and error handling independently. Sub-agent resilience would require implementing fallback logic in each extension. No model sharing across tools.
- **Rejected**: CPA's built-in round-robin, cooldown, and session affinity provide critical infrastructure that would be expensive to replicate per-provider.

### Dynamic model discovery from CPA's /v1/models

At startup, Pi would query `http://localhost:8317/v1/models` and register models dynamically via `pi.registerProvider()`.

- **Pros**: No hardcoded model list, new models appear automatically when added to CPA config.
- **Cons**: CPA's `/v1/models` only returns `{id, created, object, owned_by}` — no context, pricing, or max tokens. These would still need to be sourced from somewhere. OpenRouter's API provides rich data but would require a separate API key and HTTP call from Pi, adding coupling to OpenRouter's availability. Antigravity models have no metadata API at all.
- **Rejected (for now)**: Dynamic discovery of model IDs from CPA is a useful completeness check, but full metadata cannot be automated across all provider types. A hybrid could be revisited if CPA starts surfacing upstream metadata.

### Community dashboard (itsmylife44/cliproxyapi-dashboard)

A full-featured Next.js dashboard with 6 containers (Caddy, Dashboard, PostgreSQL, Redis, CPA, Docker Proxy).

- **Pros**: Rich UI, setup wizard, config sharing, Telegram alerts, usage analytics.
- **Cons**: 6 containers vs. 1 for the built-in CPAMC. PostgreSQL + Redis add significant operational overhead for a single-user local setup.
- **Rejected**: CPAMC (built-in, single-file SPA at `/management.html`) provides config editing, OAuth flows, log viewing, and quota management without additional infrastructure.

## Consequences

### Positive
- **Single configuration point**: Adding a new model means adding it to CPA config (for routing) and models.json (for metadata). No Pi extension code changes needed.
- **Reusable**: CPA serves Pi, Claude Code, and Codex CLI from the same Docker container with the same accounts and routing.
- **Sub-agent resilience**: `cpa/` prefix + pool global aliases provide automatic failover when a model is exhausted or unavailable.
- **Survivable**: `/model` changes in a session don't break sub-agent configurations.

### Negative
- **Static model registry maintenance**: models.json must be updated when models are added, removed, or when pricing changes. This is mitigated by the stability of context/pricing data and CPA's `/v1/models` as a completeness check.
- **Docker dependency**: Pi requires the CPA Docker container to be running. If Docker is down, all AI providers are unavailable.
- **Single point of failure**: If CPA goes down, all model access is lost. Mitigated by CPA's stability (single Go binary, low resource usage) and `restart: unless-stopped`.
- **CPAMC is basic**: The built-in management panel lacks the polish of the community dashboard (no setup wizard, no config sharing). Acceptable for single-user local use.

### Workarounds
- **Developer role bug**: CPA v7.2.46 doesn't normalize `developer` → `system` for OpenAI-compatible providers (PR #3898, fix in `dev` but untagged). Workaround: `payload.override` forcing `messages.0.role: "system"` for all models. Remove when fix is released.
- **OpenCode Go only supports OpenAI-compatible endpoint**: Anthropic-format models (MiniMax M3/M2.7, Qwen 3.7/3.6 via `/v1/messages`) are not routable through the `openai-compatibility` provider type. These models are excluded from the CPA config.
