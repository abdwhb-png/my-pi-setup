# save-tokens × AXI — Design « Socle déterministe »

Date : 2026-07-22
Statut : validé (brainstorming session)
Référence : [AXI — Agent eXperience Interface](https://github.com/kunchenguid/axi)

## Contexte

`save-tokens` est un middleware de pipeline `tool_result` (télémétrie → compresseur local Edgee → caveman → ponytail → télémétrie). AXI définit 10 principes d'ergonomie pour des CLI agent-facing. Les deux ne se recouvrent pas totalement : AXI conçoit des CLI que l'agent invoque, save-tokens réécrit les résultats de tools existants. Cette analyse a trié les principes transposables des non-pertinents.

## Bilan principe par principe

| Principe AXI | Verdict | Justification |
|---|---|---|
| §3 Troncature de contenu | **Fort levier** | La note d'archive n'apparaît que sur la route cap ; la taille totale de l'original est dans `details.compression`, invisible pour le LLM ; l'escape hatch n'est pas une commande actionnable. |
| §4 Agrégats pré-calculés | **Fort levier** | Le coût token le plus cher est l'appel de suivi. Aucun agrégat aujourd'hui. |
| §6 Erreurs structurées | **Levier moyen** | `event.isError` court-circuite toute compression : les stack traces volumineuses ne sont jamais cappées. |
| §1 TOON | **À expérimenter (itération 2)** | Pertinent uniquement pour sorties tabulaires (ls/find/grep). Risque de parsing fragile ; à trancher par télémétrie. |
| §7 Contexte ambiant | **Petit levier (transposé)** | Injecter la convention d'archive au démarrage rend l'escape hatch fiable (~30 tokens/session). |
| §5 États vides définitifs | **Contrainte de non-régression** | Les vrais états vides viennent des tools ; garantir que la compression ne les rend jamais ambigus. |
| §2 Schémas minimaux | Non pertinent | On subit les sorties des tools pi. Seule trace : les agrégats §4 restent à 3-4 champs. |
| §8 Contenu d'abord | Non pertinent | Concerne la vue no-args d'un CLI ; `/compressor-stats` est une surface humaine TUI. |
| §9 Divulgation contextuelle | Déjà couvert | La règle « omit when self-contained » est déjà respectée (pas de suggestion hors troncature). |
| §10 Aide cohérente | Non pertinent | Surfaces humaines TUI. |

## Approche retenue : Socle déterministe

100 % programmatique (conforme à l'invariant anti-spéculation LLM), testable en TDD pur, sans risque pour la route Edgee existante. La route TOON (§1) est reportée en itération 2, arbitrée par les données de télémétrie.

## Implantation

Tout reste dans `agent/extensions/save-tokens/`. Aucune nouvelle extension.

### 1. §3 — Escape hatch unifié (`tool-results/core.ts`)

- Extraire un helper `buildEscapeHatchNote(originalLength, archivePath)` produisant :
  `\n\n... (compressed, {N} chars total) — run read {path} for full output`
- Utilisé par **les deux** routes : `maybeCreateArchivedCap` ET la route Edgee (qui aujourd'hui n'expose pas la taille originale au LLM).
- Remplace la note actuelle `Full original tool result saved: <path>`.

### 2. §4 — Agrégats programmatiques (nouveau `tool-results/aggregates.ts`)

- `buildAggregateHeader(toolName, input, text): string | null`, pur et déterministe :
  - `grep` → lignes de match + fichiers distincts (parsés depuis la sortie)
  - `ls` / `find` → nombre d'entrées
  - `bash` / `safe_bash` → `lines: N` (l'exit code n'est pas disponible dans le texte)
  - `read` → `chars` / `lines` totaux
- Préfixé au résultat compressé. Maximum 3-4 champs (§2).
- Flag config `compressor.aggregates: boolean` (défaut `true`).

### 3. §6 — Cap des erreurs volumineuses (`tool-results/core.ts`)

- Remplacer `if (event.isError) return;` par : si erreur ET taille > seuil du groupe → head/tail cap + archive. Jamais d'appel Edgee sur les erreurs.
- Le head/tail cap est idéal pour les stack traces : début = message, fin = frame applicative.
- Flag config `compressor.capErrors: boolean` (défaut `true`).

### 4. §7 transposé — Convention d'archive au démarrage (`local-tool-result-compressor.ts`)

- Handler `before_agent_start` appendant 1-2 lignes au `systemPrompt` (pattern vérifié dans `caveman.ts:590-595`) :
  convention « les tool results peuvent être compressés ; l'original est archivé ; `read <archivePath>` pour le récupérer ».
- Actif seulement si `enabled && archiveOriginal`.

### 5. §5 — Garde-fou (tests uniquement)

- Assertions : sorties vides ou sous `minBytesByGroup` passent intactes ; le cap ne produit jamais une sortie ambiguë vis-à-vis d'un état vide.

## Gestion d'erreurs

Toute la logique nouvelle est déterministe. Toute défaillance retombe sur le comportement actuel (`return undefined` = résultat intact), identique au fallback Edgee existant.

## Tests

- TDD `bun:test` (red → green → refactor), suite lancée avec `agent/` comme cwd (`bun test --isolate`).
- Nouveaux tests : `tool-results/aggregates.test.ts` (extension en forme répertoire, cohabitation sûre), extensions de `local-tool-result-compressor.test.ts` et `config.test.ts` (nouveaux flags).

## Mesure de succès (itération 2)

Via la télémétrie existante :
- Compter les invocations `read` sur des chemins d'archive (adoption de l'escape hatch).
- Évolution du nombre d'appels de suivi après un résultat compressé (effet des agrégats).
- Ces données arbitreront l'opportunité de la route TOON (§1) pour ls/find/grep.

## Hors périmètre

- Route TOON (itération 2, sous condition télémétrie).
- Refonte des commandes TUI (`/compressor-stats`, télémétrie) : surfaces humaines, hors champ AXI.
- Idempotence / exit codes (§6 partiel) : sans objet pour un middleware.
