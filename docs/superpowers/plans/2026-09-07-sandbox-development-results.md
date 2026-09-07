# Corrections F1–F6 : résultats

## État

Les six corrections sandbox sont implémentées et le workflow DevServices complet passe dans le vrai `safe_bash`. La politique OS ne bloque plus les écritures normales des outils dans `node_modules`; Pi Permission System continue de refuser les appels directs `write` et `edit` visant les dépendances.

## Corrections

| Référence | Correction durable                                                                                                                                                                                                                                | Protection conservée                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| F1        | Revendiquer les montages synthétiques sous le même verrou que leur nettoyage. Sérialiser la publication des helpers avec les créations de processus qui pouvaient hériter d'un descripteur ouvert en écriture, cause des `ETXTBSY` intermittents. | Ne pas supprimer ni figer les vrais fichiers vides.                                              |
| F2        | Autoriser les paires privées de sockets Unix de type stream utilisées par les sous-processus Bun et rétablir les commandes workspace `--filter`.                                                                                                  | Refuser les sockets Unix nommés de l'hôte et les paires datagramme.                              |
| F3        | Monter le stockage temporaire privé de la session à `/tmp`, avec `TMPDIR=/tmp`.                                                                                                                                                                   | Aucun accès au `/tmp` de l'hôte ou des autres sessions. Analyse isolée par requête.              |
| F4        | Autoriser les serveurs TCP de test dans le namespace réseau privé. Conserver les ports localhost explicitement accordés via le proxy qui applique la politique.                                                                                   | Aucun serveur exposé sur l'hôte, aucun accès sortant non autorisé, pas d'UDP ni de socket hôte.  |
| F5        | Conserver les diagnostics de préparation, signaler toute troncature et exposer les erreurs du relais loopback. Distinguer `EPERM` de `EADDRINUSE` dans DevServices et préserver les échecs `wslpath`.                                             | Préserver le code, stdout et stderr du processus. Aucun repli hors sandbox.                      |
| F6        | Mémoriser uniquement les décisions lexicales immuables et appliquer l'offset de répertoire avant les vérifications coûteuses par entrée.                                                                                                          | Toujours résoudre fraîchement les chemins/liens. Aucun cache de contenu ou métadonnées, TTL nul. |

Le refus OS récursif de `node_modules` a été retiré après clarification de son objectif. Il empêchait les écritures légitimes de Vite et TypeScript sans savoir si elles venaient d'un outil ou du LLM. Un test réel couvre désormais la séparation : Pi Permission System refuse les éditions directes, tandis que `safe_bash` laisse les outils maintenir leurs propres fichiers.

## Binaire et retour arrière

Version finale construite : `0.3.3-fork.15`.

- Source locale : `~/projects/shared-services/sandboxes/zerobox`, tag `v0.3.3-fork.15`, commit `1bffd639196d144743110e2172f0a61304e700c4`.
- SHA-256 du binaire : `a0d234f552afed6f6517394fca3ece7af3d7d0a324808607bdc9416893168a0b`.
- Baseline moteur : `rust-v0.131.0-alpha.22`, commit `9b8cf56cdefb09f54564ccc295fd42f6647f558f`.
- Les 29 patches passent par `./scripts/sync.sh`. Aucun changement direct du répertoire généré `upstream/`.
- Installation finale : `~/.pi/bin/zerobox`, avec provenance et contrat de dépendance Pi vérifiés contre le binaire, le tag et les 29 patches.
- Retour arrière complet : `~/.local/state/pi/rollback/zerobox-fork.12-ou3Geh`, avec ancien binaire, provenance, intégration Pi et configuration antérieure. Préserver les éditions ultérieures avant restauration. Ne pas restaurer seulement l'exécutable.

Les tags sont locaux. Aucune publication distante n'a été effectuée. Aucun service DevServices, Docker ou Windows n'a été redémarré ou modifié par une opération d'administration.

## Validation

Les tests utilisent les vraies frontières publiques. Le harness installé est `@abdwhb-png/pi-test-harness@0.7.0` sous `~/.pi/agent/node_modules`, avec Pi `0.84.2`, Pi Permission System, les extensions sandbox et bash-execution réelles, et des appels `safe_bash` non simulés. Les nouvelles sessions de test ne constituent pas un redémarrage de la session TUI existante de l'utilisateur.

- Régressions RED → GREEN vérifiées pour les comportements corrigés, dont diagnostic loopback manquant, première page FUSE qui évaluait tout le répertoire et conservation du descripteur d'écriture après fork.
- F1 : 480 lancements concurrents supplémentaires sans `ETXTBSY` après correction.
- Rust final : 324 tests de bibliothèques et 121 tests d'intégration passent, soit 445 tests. Les quatre tests ignorés sont les trois tests Docker opt-in et le benchmark exécuté séparément.
- Pi final : 95 tests ciblés de contrat, politique, protocole, isolation Linux et vrai `safe_bash` passent. Les quatre replays de projet opt-in passent séparément. Les fixtures réelles vérifient Bun `--filter`, serveur HTTP privé, `/tmp` persistant, stderr/code `37`, refus des éditions directes de dépendances et écriture normale par les outils.
- DevServices : réserve de ports et wrappers Windows testés avec doubles des commandes externes. Le wrapper d'installation n'exécute pas de véritable commande Windows.
- Les tests exécutables ciblés et le typecheck des fichiers sandbox modifiés ne signalent pas d'erreur. Le typecheck global Pi reste en échec hors de ce périmètre.
- Mesure F6 : 500 opérations de métadonnées passent d'environ 1,615 s à 0,435 s. Le chargement du gros module d'icônes passe d'un dépassement de 30 s à environ 3,64 s. Les deux tests Dashboard passent d'un blocage à environ 4,32 s sous FUSE, contre environ 0,54 s sur l'hôte. Ces mesures locales ne promettent pas la parité avec l'hôte.
- Rejeu DevServices avec Pi Permission System, `safe_bash`, fork.15 et les configurations projet inchangées : build web 15,48 s, build workspace 15,13 s, typecheck 13,44 s et tests 12,74 s. Les quatre commandes passent.

## Décision de politique issue du rejeu

Vite écrit sa configuration compilée dans `apps/web/node_modules/.vite-temp`. TypeScript écrit ses `.tsbuildinfo` dans `apps/web/node_modules/.tmp`. Ce sont des écritures normales des outils, pas des éditions directes demandées au LLM.

DevServices n'a donc reçu aucun changement de loader Vite ou de chemin de cache TypeScript. La protection contre les modifications directes de `node_modules` reste dans Pi Permission System, qui peut distinguer les surfaces `write` et `edit`. Zerobox conserve les frontières de sécurité qu'il possède réellement : secrets, réseau, montages, namespaces et chemins explicitement sensibles.

## Échecs globaux non masqués

- DevServices `bun run check` : les cinq typechecks passent sur l'hôte, puis ESLint échoue sur sept erreurs UI préexistantes (`badge`, `button-group`, `code-block`, `tabs`, `toast`). `format:check` n'est pas atteint.
- Pi `bun run typecheck` : vingt erreurs hors des fichiers sandbox modifiés, dans audit-mode, délégation/subagents, provider guard, quit-and-delete, sdd-orchestrator et pi-mcp-adapter.
- Oxlint ignore les fichiers de test ciblés. L'exécution forcée avec `--no-ignore` échoue dans tsgolint sur un chemin de `tsconfig.json` non absolu; aucun contournement ni suppression de diagnostic n'a été ajouté.
- Clippy global avec `--all-targets -- -D warnings` : échec sur les `expect_used` préexistants des tests du protocole. Le contrôle des cibles de production Zerobox et linux-sandbox passe.
- Les tests Docker qui nécessitent ou modifient un véritable moteur restent explicitement ignorés. Le benchmark FUSE est opt-in et a été exécuté séparément, sans assertion de durée arbitraire.
- L'exécution des tests via l'outil d'analyse avec son long `TMPDIR` a déclenché les garde-fous AF_UNIX. Le même ensemble passe avec le `/tmp` normal. Aucun garde-fou de longueur n'a été modifié.

## Activation

Redémarrer complètement la session Pi utilisateur pour charger l'intégration actualisée. Les nouvelles sessions du harness ont déjà validé le comportement installé, mais elles ne remplacent pas ce redémarrage opérationnel.
