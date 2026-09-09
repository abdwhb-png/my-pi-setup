# Validation du refactor des politiques d’outils

Date : 2026-09-09. Référence avant refactor : `579a045d90c1119fe3906e96ccb2e2f78fb5c39b`.

## Résultat focalisé

**1 244 succès, 1 ignoré, 0 échec**, dans 95 fichiers.

Après les dernières retouches Google et reload du plafond CLI :
**116 succès, 0 échec**, dans 10 fichiers (coordinateur, propriétaire,
fournisseurs, wrapper et parcours de rôles). Ce sous-ensemble recoupe la passe
ci-dessus et ne doit pas être additionné comme autant de tests distincts.

Commande exécutée depuis `~/.pi/agent` :

```sh
bun test --isolate --timeout 15000 \
  bin/pi-wrapper-lib.test.ts \
  extensions/_shared/tool-policy extensions/_shared/tool-groups \
  extensions/_shared/command-execution/policy-isolation.test.ts \
  extensions/__tests__/context.test.ts \
  extensions/__tests__/context-provider.test.ts \
  extensions/__tests__/context-hooks.runtime.test.ts \
  extensions/tool-groups extensions/pi-roles extensions/pi-herdr \
  extensions/bash-execution/safe-bash \
  extensions/bash-execution/provenance.integration.test.ts \
  extensions/think-in-code extensions/ssh-tools extensions/pi-overrides \
  extensions/pi-skill-loader extensions/brainstorm-forcer/index.test.ts \
  extensions/sdd-orchestrator/sdd-orchestrator.test.ts
```

Le délai de 15 secondes évite un timeout sous charge dans le test existant
Think-in-Code de 64 Mio. Avec le délai par défaut de 5 secondes, la première
passe focalisée avait 1 240 succès, 1 ignoré et ce seul timeout. Ce même test
a ensuite passé seul, sans modification, en 1,25 seconde.

Le test ignoré est l’activation manuelle Herdr à la frontière runtime.
Les tests déterministes de contribution, révocation, plafonds et gates Herdr
ont été exécutés. Ne pas interpréter ce résultat comme une validation live de Herdr.

## Preuves ciblées

- Régression originale reproduite en RED : `debug → pi-agent` avec Herdr
  avant le propriétaire perdait `edit`, puis Pi répondait `Tool edit not found`.
  La même frontière Pi passe maintenant dans trois ordres de chargement.
- `/role`, `switch_role`, `apply-patches` et approbation de plan passent jusqu’au
  véritable constructeur OpenAI, avec transport simulé et hooks réels.
- Les dix constructeurs fournisseurs installés ont été exécutés avec leurs
  transports HTTP/SDK simulés. Le payload transporté égale le payload annoté.
- Les vrais hooks GLM/Codex passent avant et après `context`, avec plusieurs
  requêtes, liste vide, changement de modèle et prompt Pi par défaut.
- Les tests couvrent les plafonds CLI/child, listes explicites vides, alias,
  restauration de disponibilité, activations et révocations, exclusivité des
  workflows, sessions, callbacks obsolètes et invalidations réentrantes.
- Une inspection observe immédiatement les mutations O3, sans recalcul ni
  écriture. Le test a échoué avant cette correction puis passé.
- Un reload du propriétaire conserve le plafond CLI consommé au lancement.
  Le test a reproduit sa perte en RED, puis passé après conservation de cet
  état dans le registre global, sans fuite de la variable aux processus enfants.
- Le test d’architecture confirme un seul propriétaire de `setActiveTools`
  dans les extensions intégrées : `tool-groups/index.ts`.

## Diagnostics

- `bun run fmt:files:check` : réussi sur les fichiers concernés non ignorés
  par la configuration existante. Celle-ci exclut notamment les tests et `bin/`.
- `git diff --check` : réussi.
- `bun run lint` : 71 erreurs, toutes également présentes à HEAD après
  normalisation des numéros de ligne. Des avertissements non bloquants restent,
  notamment sur le scope des fonctions, les copies immuables et les fixtures.
- `bun run typecheck` : 20 erreurs, toutes également présentes à HEAD.

Les comparaisons ont utilisé un worktree temporaire détaché au commit de
référence et les mêmes dépendances installées, sans installation ni mise à jour.
Ce worktree temporaire a été supprimé après comparaison.

## Suite globale

Dernière passe `bun test --isolate` : **4 554 succès, 6 ignorés,
36 échecs comptabilisés, dont 1 erreur d’import**, dans 332 fichiers
(420,90 secondes). Ne pas présenter la suite globale comme verte.

Répartition des 36 échecs :

| Origine                                             | Nombre | Vérification                                                                                        |
| --------------------------------------------------- | -----: | --------------------------------------------------------------------------------------------------- |
| Échecs identiques reproduits à HEAD                 |     31 | 30 dans 13 suites de référence, plus le contrat Docker Administration                               |
| Échecs intermittents sous charge                    |      3 | 64 Mio, concurrence SDD et inspection Docker passent ensuite seuls sans modification                |
| Nouveau test RED Google sans `parts`                |      1 | Corrigé après son passage global, puis 32 tests fournisseurs et parcours réussis                    |
| Fichier local ignoré `think-in-code/parity.test.ts` |      1 | Import absent `../_shared/analysis/sandbox-analysis-broker.ts`, fichier non modifié par le refactor |

Les 30 échecs reproduits dans les suites de référence concernent les noms
de prompts migrés (1), les contrôles méta du dépôt (9), TPS/status (5),
le rôle Atlas absent (1), compatibilité/structure subagents (5),
configuration/compression de résultats (6) et reprises SDD (3).

Le dernier correctif Google conserve un tableau de parties lorsque le champ
optionnel `Content.parts` est absent, conformément au type installé du SDK.
Seuls les contrôles invalidés ont été rejoués après les dernières retouches :
32 tests fournisseurs puis 116 tests couvrant aussi le reload CLI, le formatage,
le lint et le typage. Les erreurs de
lint et de typage restent exclusivement celles reproduites à HEAD.

Journaux locaux de cette validation : `/tmp/policy-focused-complete.log`,
`/tmp/policy-global-complete.log`, `/tmp/policy-provider-complete.log`,
`/tmp/policy-baseline-comparison.log`, `/tmp/policy-baseline-environment.log`,
`/tmp/policy-lint-final-state.log`, `/tmp/policy-typecheck-final-state.log`.
Ces fichiers temporaires ne font pas partie de l’extension.

## Limites et périmètre préservé

Plannotator et Pi Lens restent des écrivains externes selon O3. Leur état n’est
ni intercepté ni adopté comme politique canonique. La présentation décrit la
requête observée, pas une promesse sur les prochains appels.

Ne pas ajouter un hook qui réécrit les schémas après l’injection sans revoir
cette frontière. Les hooks GLM/Codex installés ne le font pas.

Aucun appel LLM payant, aucune modification d’une session utilisateur,
aucun changement de Pi core, du rôle utilisateur `pi-agent`, des dépendances
ou d’un dépôt distant. Aucun commit automatique.

Ces tests prouvent la disponibilité et la fidélité du catalogue, pas
l’obéissance d’un modèle aux indications de routage.
