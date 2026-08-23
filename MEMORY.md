# Context

- The project was migrated from `@mariozechner/pi-coding-agent` to `@earendil-works/pi-coding-agent` in June 2026.
- `@mariozechner/pi-coding-agent` is deprecated. All imports in the `~/.pi/agent` source files now use `@earendil-works/pi-coding-agent`.
- `~/projects/shared-services/cliproxy` keeps runtime source of truth at root `docker-compose.yml`; root `docker-compose.override.yml` forces local image `cliproxy-local:dev` built from `./CLIProxyAPI` with `pull_policy: never`.
- `~/projects/shared-services/edgee-compressor-service` already uses root compose as source of truth; service now explicitly uses local image `edgee-compressor-service-local:dev` with `pull_policy: never` and local build from root `Dockerfile`.
- gpt-5.5 in Codex is capped at 400K total (272K input + 128K output), per upstream limitation (openai/codex#19464). Pi's CPA model enrichment sets `contextWindow: 272_000` for gpt-5.5. The API version supports 1M but Codex subscription is still limited as of 2026-07. Use gpt-5.4 for 1M context needs.

## Pi sandbox & Docker access (corrected July 2026)

**Root cause (verified empirically):** `@anthropic-ai/sandbox-runtime` (v0.0.65) always runs `bwrap --unshare-net` when `network.allowedDomains` is non-empty. This creates an isolated network namespace with its **own empty loopback**, so any TCP endpoint bound on the host loopback (`tcp://127.0.0.1:2375` socat bridge, etc.) is unreachable from inside the sandbox (`Connection refused`).

**What `allowAllUnixSockets: true` actually does:** only skips the seccomp-BPF filter that blocks the `socket(AF_UNIX, ...)` syscall (`linux-sandbox-utils.js:1113`). It does **not** affect TCP or bypass `--unshare-net`.

**Working path (verified):** docker CLI talking to `/var/run/docker.sock` directly — the default when `DOCKER_HOST` is unset. AF_UNIX pathname sockets are filesystem-visible via `--ro-bind / /` and are not network-namespace-scoped, so they survive `--unshare-net`. Requirements: `allowAllUnixSockets: true` in `sandbox.json` + user in `docker` group.

**Non-working paths:** any TCP endpoint — all killed by `--unshare-net`'s independent loopback. A TCP bridge is only useful when the sandbox is OFF.

**Decisions applied:**

- No `DOCKER_HOST` env var exported anywhere (removed from `~/.profile` and `~/.zprofile`; `~/.bashrc:181` already commented out). Docker falls back to default `unix:///var/run/docker.sock`.
- `docker-socat-bridge.service` disabled, unit file removed, port 2375 freed.
- `allowAllUnixSockets: true` kept in `~/.pi/agent/sandbox.json`.

**Lesson:** do not add an env var to work around a sandbox you do not understand. Trace the isolation primitive (`bwrap --unshare-net` → independent loopback) before proposing a bridge.

## LSP Type Dedup: pi-fancy-footer

- **Problem**: LSP diagnostics showed `ExtensionAPI` type mismatch for all `createWidget(pi, ...)` calls across extensions. Two copies of `@earendil-works/pi-coding-agent` existed: agent's at `agent/node_modules/` and pi-fancy-footer's at `pi-fancy-footer/node_modules/`. tsconfig path mapping `pi-fancy-footer/api` → workspace source caused tsserver to resolve imports from pi-fancy-footer source through its local `node_modules`, producing a structurally-identical but nominally-different `ExtensionAPI` type.
- **Fix**: Deleted `pi-fancy-footer/node_modules/@earendil-works/` (the package is already declared as `peerDependencies`). After deletion, tsserver module resolution falls through to the agent's single copy. All LSP diagnostics clean.
- **Lesson**: peerDependencies alone doesn't prevent bun from installing local copies. Check `node_modules/` for duplicates when you see nominal type mismatches between two copies of the same package.
- Some external packages (e.g. `pi-roles`) may still declare peerDependencies on the `@mariozechner/*` scope — these are third-party packages, not ours to fix.
- Important workflow lesson from the `pi-roles` fork: for local path E2E tests, `pi install /local/path` may update `settings.json` but still fail to provide bare-import resolution for sibling extensions importing package subpaths like `pi-roles/protocol`. Before trusting a local E2E result, verify `~/.pi/agent/node_modules/<pkg>` is not a stale shim pointing to an old git checkout and, if needed, create a clean symlink to the local fork so the real `pi` command exercises the intended code.
- We implemented a custom Pi package finalizer because Pi package installs (especially git/local path) did not reliably guarantee two things this harness needs: (1) built artifacts like `dist/index.js` / `dist/protocol.js` after install, and (2) bare-import resolution for sibling extensions (`import "pi-roles/protocol"`). The fix lives in the harness, not in Bun global installation.
- Architectural decisions for the package finalizer: (1) use a Pi extension + minimal wrapper instead of patching global Bun or upstream Pi core; (2) keep startup fast with a persistent cache and only repair configured packages; (3) reserve expensive rebuilds for invalid/missing artifacts or post-mutation wrapper runs (`install/remove/uninstall/update`); (4) create symlinks for package-name resolution rather than fragile re-export shim files; (5) do not automatically replace an existing non-shim package directory in `node_modules` to avoid clobbering user-managed dependencies — only stale generated shims and mismatched symlinks are replaced automatically.
- Hypa versioning policy: `@hypabolic/pi-hypa` and `@hypabolic/hypa` may ship at different versions. If the Pi package lags behind the Hypa engine, prefer upgrading `@hypabolic/hypa` separately and pointing `HYPA_BIN` to that binary path instead of assuming the Pi package version must match the engine version.

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

| Champ             | Où vérifier                                                             | Ne pas deviner       |
| ----------------- | ----------------------------------------------------------------------- | -------------------- |
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

| What                    | Where                                   |
| ----------------------- | --------------------------------------- |
| Docker Compose + config | `~/projects/shared-services/cliproxy/`  |
| CPA API key for Pi      | `auth.json` → `cliproxy` entry          |
| Pi provider + models    | `models.json` → `cpa` provider          |
| Management UI (CPAMC)   | `http://localhost:8317/management.html` |

### Provider isolation via aliases

CPA routes models based on alias matching. Same alias = round-robin across providers. Different alias = isolation.

| Group                    | Prefix | Alias pattern                | Rotation                      |
| ------------------------ | ------ | ---------------------------- | ----------------------------- |
| OpenCode Go (isolé)      | `ocg`  | `go-deepseek-v4-flash`       | Between Go API keys only      |
| Pool global (OpenRouter) | `or`   | `deepseek/deepseek-v4-flash` | All providers with same alias |

Pi sends prefixed model IDs: `ocg/go-deepseek-v4-flash` → CPA strips `ocg/` → matches alias `go-deepseek-v4-flash` → routes to OpenCode Go provider.

### Sub-agent model strategy (July 2026)

#### Mental model — proportionnalité coût ↔ complexité

`settings.json` est la **propriété exclusive de l'utilisateur** : il peut attribuer les modèles comme il le veut, où il le veut, à tout moment. Les tables de cette section ne sont **pas une source de vérité** à re-synchroniser : ce sont des instantanés de référence (juillet 2026), un point de départ possible, pas une norme. Si `settings.json` diverge de la mémoire, c'est `settings.json` qui a raison — la mémoire documente un principe, pas l'état courant de la config.

Le seul principe structurant est la **proportionnalité** : tâche cheap → modèle cheap, tâche complexe → modèle performant.

- **Tâches cheaps, répétitives, à faible enjeu** (code simple, lecture de fichiers, recherches ciblées, exécution) → **modèles cheaps** (ex. `deepseek-v4-flash`). Inutile d'y brûler des tokens chers.
- **Tâches complexes, d'orchestration, de planification ou de review importante** (plans multi-étapes, décisions stratégiques, revue critique, arbitrages) → **modèles plus performants** (ex. `deepseek-v4-pro`, `glm-5.2`). La qualité de l'output justifie le coût.

Pour classer un subagent, se poser la question : « qu'est-ce qu'il produit et quel est l'impact d'une erreur ? » — pas « quel modèle était listé dans la mémoire ». Les 3 tiers ci-dessous ne font que catégoriser cette complexité, ils ne figent aucune affectation.

| Tier       | Type de tâche                         | Exemples de subagents                               | Profil de modèle                        |
| ---------- | ------------------------------------- | --------------------------------------------------- | --------------------------------------- |
| **Low**    | Simple, répétitif, faible enjeu       | worker, delegate, scout, task-doer, context-builder | Cheap (ex. `deepseek-v4-flash`)         |
| **Medium** | Analyse, recherche, planification     | researcher, planner, sdd-orchestrator               | Milieu de gamme (ex. `deepseek-v4-pro`) |
| **High**   | Review critique, décision stratégique | reviewer, oracle                                    | Haut de gamme (ex. `glm-5.2`)           |

> ⚠️ **Instantané, pas norme** : les affectations ci-dessous (juillet 2026) sont une configuration passée, fournie comme point de départ. L'utilisateur est libre — et même encouragé — d'en diverger selon ses besoins du moment.

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
| **reviewer**     | `cpa/zai-coding/glm-5.2`       | `cpa/ocg/go-glm-5.2`                    | `cpa/ocg/go-deepseek-v4-pro` (paid)          |
| **oracle**       | `cpa/ocg/go-glm-5.2`           | `cpa/ocg/go-deepseek-v4-pro`            | `cpa/deepseek/deepseek-v4-pro` (paid)        |

#### Pourquoi ce schéma

- **OpenCode Go est toujours disponible** : 2 API keys en round-robin, pas de rate-limiting gratuit
- **Les modèles free OpenRouter sont instables** : souvent down ou saturés → relégués en FB2 uniquement
- **Les modèles pool payés sont fiables et moins chers** : `deepseek-v4-flash` à $0.10/$0.20 est encore moins cher que l'ocg equivalent
- **Mix provider = résilience** : primary Go, FB1 OpenRouter → deux infrastructures distinctes
- **Coût maîtrisé** : les low complexity tournent à $0.14/$0.28 max, les medium/high ont des fallbacks moins chers que leur primary

#### Règle pour (ré)attribuer un subagent

1. Estimer la complexité réelle de sa tâche (simple/répétitif → cheap ; complexe/orchestration/review → performant)
2. Choisir librement le modèle et le provider — l'instantané n'est qu'une suggestion
3. `settings.json` → `subagents.agentOverrides` est la **seule source de vérité opérationnelle**
4. Ne pas mettre à jour MEMORY.md pour refléter chaque changement : la mémoire documente le principe, pas l'état courant
5. Astuce technique : le préfixe `cpa/` verrouille le provider et survit aux changements de modèle courant (`/model`)

#### Sub-agent resilience (technique)

Astuce technique, pas doctrinale : sub-agents utilisent le préfixe `cpa/` dans `settings.json` pour survivre aux changements de modèle courant :

```json
"worker": { "model": "cpa/ocg/go-deepseek-v4-flash" }
```

`cpa/` verrouille le provider ; l'ID de modèle détermine le routage CPA (ocg/ → Go, pas de préfixe → pool global). C'est un détail d'implémentation, pas une obligation d'utiliser tel ou tel modèle.

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
  - api-key: "${OCG_KEY_ONE}" # from .env
  - api-key: "${OCG_KEY_TWO}"
models:
  - name: "deepseek-v4-pro" # upstream name
    alias: "go-deepseek-v4-pro" # client-visible alias
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

## Herdr Pi launches

- For every Pi session launched through Herdr, use `pi --dangerously-skip-permissions` and launch the session without `ask_user_question`. These are separate requirements: the flag (renamed from `--yolo`, see ADR-013) auto-approves permissions and bypasses unprotected extension blockers but does not itself remove the tool; its absence must be enforced by the separate launch instruction or tool-registration policy.
