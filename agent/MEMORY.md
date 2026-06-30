# Context

- The project was migrated from `@mariozechner/pi-coding-agent` to `@earendil-works/pi-coding-agent` in June 2026.
- `@mariozechner/pi-coding-agent` is deprecated. All imports in the `~/.pi/agent` source files now use `@earendil-works/pi-coding-agent`.
- Some external packages (e.g. `pi-roles`) may still declare peerDependencies on the `@mariozechner/*` scope — these are third-party packages, not ours to fix.
- Important workflow lesson from the `pi-roles` fork: for local path E2E tests, `pi install /local/path` may update `settings.json` but still fail to provide bare-import resolution for sibling extensions importing package subpaths like `pi-roles/protocol`. Before trusting a local E2E result, verify `~/.pi/agent/node_modules/<pkg>` is not a stale shim pointing to an old git checkout and, if needed, create a clean symlink to the local fork so the real `pi` command exercises the intended code.


## Règles de configuration des modèles

### 🔴 RÈGLE IMPÉRATIVE : Vérification factuelle des specs

À chaque fois qu'un modèle est ajouté ou configuré dans `models.json`, tu **dois** vérifier ses spécifications en te basant sur la **documentation officielle du provider**. Ne jamais deviner, estimer, ou copier les specs d'un autre modèle.

**Procédure obligatoire :**

1. **Identifier le provider réel** du modèle (Anthropic, Google, OpenAI, DeepSeek, etc.)
2. **Consulter la documentation officielle** :
   - Anthropic → `https://platform.claude.com/docs/en/about-claude/models/overview`
   - Google Gemini → `https://ai.google.dev/gemini-api/docs`
   - OpenAI → `https://platform.openai.com/docs`
   - DeepSeek → `https://api-docs.deepseek.com/`
   - OpenRouter → `https://openrouter.ai/docs`
   - OpenCode Go → prix sur leur page officielle, specs via le provider upstream
3. **Utiliser Context7** (`context7_query-docs`) pour interroger la doc officielle
4. **Croiser avec des sources externes** si nécessaire (articles, benchmarks)
5. **Ne remplir que les champs vérifiés** : `contextWindow`, `maxTokens`, `cost` (input/output/cacheRead/cacheWrite), `reasoning`, `input`

**Champs à vérifier systématiquement :**

| Champ             | Où vérifier                                                             | Ne pas deviner      |
| ----------------- | ----------------------------------------------------------------------- | ------------------- |
| `contextWindow`   | Page "Models overview" du provider                                      | ❌                   |
| `maxTokens`       | Specs API du modèle spécifique                                          | ❌                   |
| `cost.input`      | Page "Pricing" du provider                                              | ❌                   |
| `cost.output`     | Page "Pricing" du provider                                              | ❌                   |
| `cost.cacheRead`  | Page "Pricing" (si dispo)                                               | ✅ (0 si pas d'info) |
| `cost.cacheWrite` | Page "Pricing" (si dispo)                                               | ✅ (0 si pas d'info) |
| `reasoning`       | Doc du modèle (thinking support)                                        | ❌                   |
| `input`           | Doc du modèle (text/image/audio) → toujours `["text"]` dans models.json | ❌                   |

### Exemples de ce qu'il ne faut PAS faire

- ❌ Mettre 200K de contexte pour Claude Sonnet 4.6 parce que « les Claude ont 200K » → la spec officielle dit 1M
- ❌ Estimer les max tokens d'un modèle Gemini à 8192 → la spec officielle dit 65536
- ❌ Copier les specs d'un modèle vers un autre modèle « similaire »
- ❌ Mettre `"input": ["text", "image"]` → le schéma models.json n'accepte que `["text"]`

### Exemple de vérification correcte

```
Modèle: claude-sonnet-4-6
→ Context7: /websites/platform_claude_en
→ Query: "Claude Sonnet 4.6 context window max output"
→ Résultat: 1M context, 64K max output (source: Anthropic Models Overview)
→ models.json: contextWindow=1000000, maxTokens=64000 ✓
```
  
## CLIProxyAPI Integration (June 2026)

### Architecture

CLIProxyAPI acts as a **central AI proxy** running in Docker, shared across Pi, Claude Code, Codex CLI, and other tools. Pi connects to it as an OpenAI-compatible provider — no custom extension needed.

```
Pi (models.json: provider "cpa")
  → http://localhost:8317/v1 (OpenAI-compatible)
    → CLIProxyAPI Docker container
      → OpenCode Go (round-robin: 2 API keys)
      → OpenRouter (pool global)
      → Codex OAuth, Antigravity OAuth (via auths/)
```

### Files & locations

| What                    | Where                                             |
| ----------------------- | ------------------------------------------------- |
| Docker Compose + config | `/home/abdwhb/projects/shared-services/cliproxy/` |
| CPA API key for Pi      | `auth.json` → `cliproxy` entry                    |
| Pi provider + models    | `models.json` → `cpa` provider                    |
| Management UI (CPAMC)   | `http://localhost:8317/management.html`           |

### Provider isolation via aliases

CPA routes models based on alias matching. Same alias = round-robin across providers. Different alias = isolation.

| Group                    | Prefix | Alias pattern                | Rotation                      |
| ------------------------ | ------ | ---------------------------- | ----------------------------- |
| OpenCode Go (isolé)      | `ocg`  | `go-deepseek-v4-flash`       | Between Go API keys only      |
| Pool global (OpenRouter) | `or`   | `deepseek/deepseek-v4-flash` | All providers with same alias |

Pi sends prefixed model IDs: `ocg/go-deepseek-v4-flash` → CPA strips `ocg/` → matches alias `go-deepseek-v4-flash` → routes to OpenCode Go provider.

### Sub-agent model strategy (July 2026)

#### Mental model

Les subagents sont classés en 3 tiers de complexité. Le choix du modèle suit deux priorités : **disponibilité d'abord, coût ensuite**.

| Tier       | Subagents                                           | Besoin                               | Modèle primaire            | Coût (in/out) |
| ---------- | --------------------------------------------------- | ------------------------------------ | -------------------------- | ------------- |
| **Low**    | worker, delegate, scout, task-doer, context-builder | Tâches simples, code, lecture        | `ocg/go-deepseek-v4-flash` | $0.14/$0.28   |
| **Medium** | researcher, planner, sdd-orchestrator               | Analyse, recherche, planification    | `ocg/go-deepseek-v4-pro`   | $1.74/$3.48   |
| **High**   | reviewer, oracle                                    | Revue critique, décision stratégique | `ocg/go-glm-5.2`           | $1.40/$4.40   |

#### Stratégie de fallback

Chaque subagent a 2 fallbacks. Le principe général : **ocg → pool payé → pool free**.

- **Fallback 1** : pool global payé — provider différent (OpenRouter), fiable, coût minimal
- **Fallback 2** : pool global gratuit — dernier recours, peut être indisponible

**Exception haute complexité** (reviewer, oracle) : le FB1 reste en ocg (`ocg/go-deepseek-v4-pro`) pour garantir une disponibilité maximale avant de tomber sur le pool payé. Ces 2 agents n'ont **aucun fallback free** — 3 niveaux tous fiables.

#### Table complète

| Subagent         | Primary                        | Fallback 1                              | Fallback 2                                   |
| ---------------- | ------------------------------ | --------------------------------------- | -------------------------------------------- |
| worker           | `cpa/ocg/go-deepseek-v4-flash` | `cpa/deepseek/deepseek-v4-flash` (paid) | `cpa/qwen/qwen3.6-plus-preview:free`         |
| delegate         | `cpa/ocg/go-deepseek-v4-flash` | `cpa/deepseek/deepseek-v4-flash` (paid) | `cpa/qwen/qwen3.6-plus-preview:free`         |
| scout            | `cpa/ocg/go-deepseek-v4-flash` | `cpa/deepseek/deepseek-v4-flash` (paid) | `cpa/qwen/qwen3.6-plus-preview:free`         |
| task-doer        | `cpa/ocg/go-deepseek-v4-flash` | `cpa/deepseek/deepseek-v4-flash` (paid) | `cpa/qwen/qwen3.6-plus-preview:free`         |
| context-builder  | `cpa/ocg/go-deepseek-v4-flash` | `cpa/deepseek/deepseek-v4-flash` (paid) | `cpa/qwen/qwen3.6-plus-preview:free`         |
| researcher       | `cpa/ocg/go-deepseek-v4-pro`   | `cpa/deepseek/deepseek-v4-pro` (paid)   | `cpa/nvidia/nemotron-3-super-120b-a12b:free` |
| planner          | `cpa/ocg/go-deepseek-v4-pro`   | `cpa/deepseek/deepseek-v4-pro` (paid)   | `cpa/nvidia/nemotron-3-super-120b-a12b:free` |
| sdd-orchestrator | `cpa/ocg/go-deepseek-v4-pro`   | `cpa/deepseek/deepseek-v4-pro` (paid)   | `cpa/nvidia/nemotron-3-super-120b-a12b:free` |
| **reviewer**     | `cpa/ocg/go-glm-5.2`           | `cpa/ocg/go-deepseek-v4-pro`            | `cpa/deepseek/deepseek-v4-pro` (paid)        |
| **oracle**       | `cpa/ocg/go-glm-5.2`           | `cpa/ocg/go-deepseek-v4-pro`            | `cpa/deepseek/deepseek-v4-pro` (paid)        |

#### Pourquoi ce schéma

- **OpenCode Go est toujours disponible** : 2 API keys en round-robin, pas de rate-limiting gratuit
- **Les modèles free OpenRouter sont instables** : souvent down ou saturés → relégués en FB2 uniquement
- **Les modèles pool payés sont fiables et moins chers** : `deepseek-v4-flash` à $0.10/$0.20 est encore moins cher que l'ocg equivalent
- **Mix provider = résilience** : primary Go, FB1 OpenRouter → deux infrastructures distinctes
- **Coût maîtrisé** : les low complexity tournent à $0.14/$0.28 max, les medium/high ont des fallbacks moins chers que leur primary

#### Règle pour ajouter un nouveau subagent

1. Déterminer son tier (low/medium/high) selon la complexité de sa tâche
2. Lui assigner le primary et les fallbacks correspondant à son tier
3. Reviewer et oracle utilisent le pattern haute complexité (fb1 ocg, fb2 paid, pas de free)
4. Toujours utiliser le préfixe `cpa/` pour verrouiller le provider
5. Enregistrer la décision ici et dans `settings.json` → `subagents.agentOverrides`

#### Sub-agent resilience

Sub-agents use `cpa/` provider prefix in settings.json to survive `/model` changes:
```json
"worker": { "model": "cpa/ocg/go-deepseek-v4-flash" }
```
`cpa/` locks the provider; the model ID determines CPA routing (ocg/ → Go, no prefix → pool global).

### Decisions

- **Service partagé, pas interne Pi**: CLIProxyAPI in `~/projects/shared-services/`, not `~/.pi/`. Reusable by other tools.
- **Config via template + .env**: `config.template.yaml` with `${VAR}` placeholders, substituted by `entrypoint.sh` at container start. API keys in `.env` (gitignored).
- **CPAMC intégré, pas le dashboard communautaire**: Built-in `/management.html` — zero extra containers vs. Next.js dashboard (6 containers).
- **Developer role workaround**: CLIProxyAPI v7.2.46 doesn't include PR#3898 (developer→system normalization). Fixed via `payload.override` forcing `messages.0.role: "system"`.
- **OpenCode Go models limited**: Only OpenAI-compatible endpoint models work (`/v1/chat/completions`). Anthropic-format models (MiniMax, Qwen via `/v1/messages`) not supported through this provider type.
- **Cost tracking**: Models in `models.json` use pricing from official provider docs (OpenCode Go pricing page, OpenRouter documented rates).
- **Default model**: `cpa/ocg/go-deepseek-v4-pro` — isolated Go model, survives `/model` changes.

### CPA config template pattern

```yaml
# config.template.yaml
api-key-entries:
  - api-key: "${OCG_KEY_ONE}"    # from .env
  - api-key: "${OCG_KEY_TWO}"
models:
  - name: "deepseek-v4-pro"      # upstream name
    alias: "go-deepseek-v4-pro"  # client-visible alias
```

```bash
# .env (gitignored)
OCG_KEY_ONE=sk-...
OCG_KEY_TWO=sk-...
OR_API_KEY=sk-or-v1-...
```

### Quirks & gotchas

- **Docker image**: `eceasy/cli-proxy-api:latest` (NOT `routerforme/...`)
- **CPAMC needs `allow-remote: true`**: Docker host IP (172.x) is seen as remote
- **No env var substitution natively**: requires `envsubst`/`sed` in entrypoint
- **CPAMC log viewer**: needs `logging-to-file: true`
- **Models must be explicitly declared**: no auto-discovery from upstream
- **`/v1/models` auth required**: needs `api-keys` configured
- **`payload.override` avec wildcard `*` casse Antigravity ET Codex**: Le translator reçoit le champ `messages` (OpenAI) injecté par l'override et le passe tel quel à l'API upstream qui le rejette. Antigravity → 400 INVALID_ARGUMENT (Google protobuf), Codex → "Unsupported parameter: messages". **Solution**: toujours filtrer par `protocol: "openai"` uniquement — jamais `*` sans filtre, jamais `codex` ou `antigravity` avec `messages.*`.
