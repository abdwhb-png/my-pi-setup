# Validation — sandbox, /tmp et provenance

Implémentation du plan approuvé du 7 septembre 2026 dans le checkout existant.
Recharger Pi avec `/reload` ou ouvrir un nouveau processus pour charger les
extensions modifiées. Les processus Pi de validation ont été lancés à neuf.

## Résultat

| Référence | Comportement livré |
| --- | --- |
| A1 | `bash`, `safe_bash` et `!` utilisent `bash-general` avec le `/tmp` de l’hôte. Les refus explicites du projet et les autres protections restent appliqués. |
| A2 | La collecte Think utilise `think-strict`, avec un lease distinct par session/cwd. Chaque analyse utilise un nouveau lease `analysis-strict`. Les deux profils ont `TMPDIR=/tmp` et un montage temporaire privé. Aucun repli Think vers l’hôte. |
| A3 | La provenance provient du processus et du protocole de supervision. Elle distingue préparation, exécution, refus, annulation, délai dépassé et nettoyage, en conservant le code de sortie observé. |
| A4 | Les résultats Pi persistent la provenance dans `details`. Une copie destinée au modèle reçoit un reçu compact, sans modification des sorties brutes. Les commandes `!` persistent un reçu associé dans l’historique. |
| A5 | Les JSON Think distinguent `sourceExecution` et `analysisExecution`, y compris les erreurs. Les lots exposent `sourceExecutions` et la provenance dans les détails de chaque élément. La lecture des fichiers et la recherche d’artefacts se font sur l’hôte. |
| A6 | Save Tokens conserve le texte intégral et écrit un `.txt.meta.json` associé. Le fichier natif `fullOutputPath` est copié octet pour octet. La rétention compte et supprime les deux fichiers. Une collision de nom ne supprime pas une archive existante. |
| A7 | Les archives sont identifiées comme du texte de sortie stocké sur l’hôte. Leur lecture native paginée échappe à la recompression. Les anciennes archives et les métadonnées indisponibles restent lisibles avec une provenance source inconnue. Aucun export des fichiers privés Think n’est ajouté. |

Le lot n’est pas un processus unique : son enregistrement collectif conserve
`unknown`, tandis que chaque élément fournit les faits de son propre processus.
Les anciens résultats sans preuve et les outils non instrumentés restent
également `unknown`. Des commandes `!` identiques qui se chevauchent restent
inconnues si le format d’historique Pi ne permet pas de les attribuer sûrement.

## Vérifications exécutées

Les cycles RED → GREEN ont porté notamment sur le partage de `/tmp`, le profil
Think distinct, les observations de processus, les erreurs de préparation,
les reçus Pi, la séparation des phases Think et les archives associées.
Les groupes ci-dessous se recoupent : leurs nombres ne sont pas additionnés.

| Vérification | Résultat |
| --- | --- |
| Exécution partagée, provenance, Bash, politiques, service, backend, routage et runtime Think | 336 tests réussis sur 28 fichiers au point de contrôle correspondant. |
| Suite Think complète après ajout de la provenance par élément | 221 tests réussis sur 25 fichiers. |
| Coordinateur Think, hôte/client d’analyse et composants Save Tokens | 279 tests réussis sur 19 fichiers au point de contrôle correspondant. Les tests ajoutés ensuite sur les archives ont aussi passé. |
| Publication du runtime partagé, cycle de vie Sandbox et overrides natifs | 147 tests réussis sur 6 fichiers. |
| Linux réel, profils temporaires et analyse QuickJS/TypeScript/Python | 17 tests réussis, dont isolement des leases, protections réseau et sockets, restrictions explicites, timeout, code 125 et boucles infinies. |
| Pi réel avec compression active, ordre des hooks inversé | Les deux ordres passent. Sortie compressée, archive exacte, provenance persistée et reçu présent dans le contexte du fournisseur. Backend de compression simulé, pipeline Pi réel. |
| Lecture native paginée avec compression enregistrée avant/après les reçus | Les deux ordres passent. Les lignes 101–103 sont rendues exactement sans appel au compresseur. |
| Archives : collision, ancien format, métadonnées illisibles, copie binaire, permissions et rétention | 10 tests réussis. |
| Nouveau processus Pi : fonctionnel, Bash, rechargement, navigation et compaction RPC | Script `extensions/think-in-code/e2e/real-pi/run.sh` terminé avec code 0. Fournisseur déterministe local, sans appel LLM externe. |
| Build Dev Services réel via `safe_bash` | `bun run --cwd apps/web build` réussi en 19,51 s. Provenance `sandboxed / bash-general / host`, code 0. Checkout Dev Services toujours propre après validation. |
| Formatage et whitespace | Oxfmt exécuté sur les fichiers de la tâche selon les exclusions du dépôt. `git diff --check` passe. |

Le test Linux vérifie maintenant un refus explicite sur le fichier sentinelle
de `/tmp`, en accès direct et via `/proc/1/root`. Le partage général de `/tmp`
est vérifié séparément dans les deux sens. Les tests de backend utilisant une
racine temporaire personnalisée ont été exécutés avec le `/tmp` hôte standard,
car le chemin temporaire du sous-processus context-mode dépassait leur budget
de socket Unix. Le budget de production n’a pas été assoupli.

## Preuves et résolution du runtime

- Preuves du dernier smoke : `/tmp/pi-host-tmp-verification-2026-09-07-final/`.
- Journaux principaux : `functional-events.jsonl`, `bash-events.jsonl`,
  `reload-events.jsonl`, `navigation-events.jsonl`, `compact-rpc.jsonl`,
  `provider-trace.jsonl` et `session.jsonl`.
- Pi chargé par le smoke : `~/.pi/agent/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`, version installée `0.84.2`, lancé sous Bun.
- Extensions chargées depuis les sources de `~/.pi/agent/extensions/`.
- Zerobox vérifié : `~/.pi/bin/zerobox`, `0.3.3-fork.15`, SHA-256
  `a0d234f552afed6f6517394fca3ece7af3d7d0a324808607bdc9416893168a0b`.
- Exemple réel : une commande Think sortie avec le code `7` conserve
  `think-strict / failed / exitCode:7`, alors que sa dérivation réussie porte
  `analysis-strict / succeeded / exitCode:0`.

## Limites des contrôles globaux

`bun run typecheck` échoue avec **21 erreurs hors du périmètre de cette tâche**.
Aucune erreur TypeScript ne reste dans les fichiers de la tâche. Les fichiers
concernés sont les tests Audit, Subagents, certains tests CPA, SDD,
`quit-and-delete.ts`, `pi-skill-loader/index.ts` et le transport Unix de
`pi-mcp-adapter`.

`bun run lint --format json` échoue avec **71 erreurs hors des fichiers de
l’implémentation modifiée** et 673 avertissements à l’échelle du dépôt.
Les nouvelles erreurs de lint détectées dans le décodage des métadonnées ont
été corrigées. Les contrôles globaux ne constituent donc pas une validation
verte de l’ensemble du dépôt.

La suite générale de tout le dépôt et les trois autres workflows Dev Services
optionnels (`build`, `typecheck`, `test` à la racine) n’ont pas été lancés.
Les dépendances, le binaire Zerobox et l’infrastructure Dev Services n’ont pas
été modifiés par cette tâche. Les modifications préexistantes du checkout ont
été conservées. Aucun commit ni publication n’a été effectué.
