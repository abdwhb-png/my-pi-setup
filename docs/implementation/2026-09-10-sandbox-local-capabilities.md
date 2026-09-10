# Profils d’isolation : livraison et validation

Le contrat shell D1/D2/D3 est implémenté. Les droits locaux restent inactifs
jusqu’à la migration utilisateur et au redémarrage complet de Pi. Consultez
[le guide](../../agent/extensions/sandbox/docs/shell-capabilities.md) et
[les scénarios d’évaluation](../evaluations/sandbox-local-capabilities.md).

## Lots livrés

| Lot | Commit | Changement |
| --- | --- | --- |
| L2 | `45fbce9` | `/tmp` privé par défaut, générations conservées jusqu’à la fin des opérations admises, préparation des chemins interdits absents ou liés. |
| L1 | `58b700d` | Autorité locale, identité Linux/projet, préférences restrictives, protection du magasin. |
| L3 | `729b87f` | Adaptateurs Zed, SFW/npm/Pi et Dev Services, supervision et provenance hôte. |
| L4 | `8d209f8` | Commandes utilisateur, migration, routage `safe_bash`, contrôles Pi et contexte du modèle. |
| L5 | `1395f0a` | Guide, migration, scénarios d’évaluation et bilan initial. |
| C1 | `a3fa596` | Canonicalisation des accès demandés et protection des alias vers une autorité absente. |
| C2 | `aa201af` | Installation du broker Docker corrigé et provenance vérifiée. |
| C3 | `c04c4b4` | Alignement des contrats Audit, SDD, CPA et raccourcis avec Pi installé. |
| C4 | `aad0c85` | Schéma compatible avec les alias TypeBox du chargeur Node/Jiti de Pi. |

Le runtime a été commité avant l’autorité pour introduire son contrat de
namespace avant ses consommateurs. Aucun paquet de permissions ni manifeste
de dépendances n’a été modifié. Les cinq lots initiaux ont été intégrés dans
le checkout d’origine. À la demande de l’utilisateur, les écarts Docker et
TypeScript initialement signalés ont ensuite été corrigés dans ce checkout.

## Vérifications exécutées

Exécutez les commandes depuis `~/.pi/agent`, avec les dépendances déjà installées.

```sh
bun test --isolate extensions/sandbox/ extensions/bash-execution/ \
  extensions/_shared/sandbox-runtime/ extensions/_shared/command-execution/ \
  extensions/_shared/execution-provenance/
```

Dernière suite élargie dans le checkout d’origine : **607 réussites, 8 parcours
optionnels désactivés, aucun échec**, sur 615 tests dans 62 fichiers.
Le résultat initial du worktree était bien **602 réussites, 8 parcours
désactivés et 1 échec Docker préexistant**. Il reste une preuve du décalage
avant correction, pas le résultat de la livraison finale.
Les 8 parcours optionnels comprennent les 3 essais hôte relancés séparément
ci-dessous et 5 scénarios dépendant de services/projets locaux particuliers.

Les tests importent les modules de production. Les preuves couvrent notamment
le réseau fermé, `/tmp` privé et partagé explicitement, les espaces Think,
la protection réelle du magasin, les aliases/hardlinks natifs, la révocation,
les opérations admises, les refus Git sur les trois capacités, les échecs SFW
sans poursuite et les codes de sortie réels. Les cas runtime Pi utilisent ses
hooks et le paquet de permissions installé, sans LLM. Le test SFW refusé utilise
un lanceur simulé qui sort avec le code 31 : il prouve l’arrêt du parcours, pas
la détection réelle d’un paquet malveillant.

```sh
PI_SANDBOX_HOST_SMOKE=1 \
PI_SANDBOX_DEV_SERVICES_PROJECT="$HOME/projects/shein-ecom" \
bun test --isolate extensions/bash-execution/capabilities.host-smoke.test.ts
```

Les **3 essais hôte réels passent**. SFW installe `is-number@7.0.0` avec cache
npm neuf et scripts désactivés dans un projet jetable. La version et l’intégrité
du paquet ont été vérifiées avant installation. Zed accepte le fichier du
projet. Une observation séparée, avec `PI_SANDBOX_ZED_OBSERVE=1`, a confirmé la
fenêtre `sandbox-capability-smoke.txt`. Dev Services renvoie le marqueur de la
commande bénigne sur le projet déjà enregistré. Aucun service ni donnée de
projet n’a été redémarré ou supprimé par cette validation.

Le formatage a utilisé `bun run fmt:files` et les exclusions du dépôt. Le lint
initial des 40 fichiers TypeScript se termine avec **0 erreur et 97 avertissements**.
Les fichiers corrigés ensuite ont également passé leur lint ciblé, avec des
avertissements conservés et aucune erreur.
Le script `lint` force un parcours global avec `oxlint .`; le binaire local a
donc été utilisé directement pour limiter ce contrôle aux fichiers de la tâche.
`git diff --check` passe.

```sh
bun run typecheck
./node_modules/.bin/tsc --noEmit -p tsconfig.sandbox.json
```

Les deux contrôles de types passent dans le checkout d’origine. Les **201 tests
des contrats corrigés passent** : Audit, raccourcis, catalogue CPA et délégation
SDD. Audit normalise les entrées JSON non fiables et ses tests de commandes
utilisent désormais le vrai runtime Pi. Les raccourcis sont validés avant leur
enregistrement. SDD refuse le statut externe supprimé `turn_budget_exhausted`
sans modifier son budget interne. Les fixtures CPA utilisent le type public
actuel, sans modifier les changements utilisateur dans `cpa.ts` et `cpa.test.ts`.

Après cette validation, le chargement utilisateur a révélé une différence
non couverte : Pi redirige `@sinclair/typebox` vers `typebox`, où
`Type.Composite` n’existe pas. Le test ajouté
`extensions/bash-execution/index-loader.test.ts` reproduit l’échec des deux
extensions dans un sous-processus Node utilisant le véritable chargeur Pi.
Le schéma utilise désormais `Type.Object` avec les propriétés Bash partagées.
Le même test charge les deux extensions et vérifie le schéma public enregistré.
Les **38 tests ciblés** du chargement, de l’exécution, des permissions et du
routage passent, ainsi que le contrôle de types global et les contrôles de
formatage/lint ciblés. La suite de 607 tests ci-dessus avait précédé cette
correction et ne constituait donc pas une preuve du chargement Node/Jiti.

Dans le dépôt propriétaire `~/.pi/agent/git/github.com/abdwhb-png/pi-mcp-adapter`,
le commit local `53733d3` normalise les fragments texte du socket Unix en Buffer.
Le défaut a été reproduit avant correction. Les **6 tests ciblés** du transport
et de sa connexion MCP passent, ainsi que `bun run typecheck` de ce paquet.

```sh
bun test --isolate extensions/audit-mode/index.test.ts extensions/_shared/audit-mode/ \
  extensions/ogulcancelik-pi-extensions/quit-and-delete.test.ts \
  extensions/ai-providers/providers/cpa-catalog-guard.test.ts \
  extensions/sdd-orchestrator/delegation-client.test.ts \
  extensions/sdd-orchestrator/workflow.test.ts
```

## Correction Docker et provenance

Le test `extensions/sandbox/docker-exec.integration.test.ts` échouait également
dans le checkout d’origine au commit `6d4aa91`. Le runtime installé était
`0.3.3-fork.17`, commit source `fff8a45a6092f78f7c4fefd57ad3fc9ac449ff94`.
Le checkout Zerobox consulté (`d21bf650c100d09f79e4d217513ba66f0675c6c9`)
était **plus ancien**, avec des corrections Docker non commitées. Le bilan
initial le qualifiait à tort de plus récent.
Le binaire ancien renvoyait `Docker operation forbidden` et son validateur
`safe_exec_create_body` refusait `DetachKeys: ""`, accepté par le contrat de test
plus récent. Le test adapté au `/tmp` privé atteignait ce refus
`unsafe Docker exec forbidden`.

Le nouveau worktree `~/projects/shared-services/sandboxes/zerobox-local-capabilities`
part du commit réellement installé `fff8a45`, conserve ses correctifs de
renommages et intègre les trois fichiers Docker modifiés dans le checkout
ancien. Le commit local `5c530891c2883bfbfd192883002cfc9b0f50e632` porte cette
correction. Le checkout Zerobox ancien et ses modifications restent intacts.

`./scripts/sync.sh` a rejoué les patches sans rejet. Les tests exécutés donnent
**27 réussites pour le broker Docker**, **4 pour son protocole** et **10 pour
les accès dynamiques aux fichiers**, avec un benchmark volontairement ignoré.
Le formatage et Clippy strict selon les options CI applicables passent.
Un premier appel Clippy avec `--all-targets`, absent du contrat CI, avait
signalé les `expect()` des anciens tests. Il n’est pas présenté comme vert.
La compilation release a réutilisé le cache local, avec `--locked --offline`.

Le binaire installé est une **compilation locale de fork.17**, sans nouvelle
publication ni déplacement du tag. Sa provenance distingue le tag d’origine,
le commit construit et le hash de leur différence. Les **2 tests d’intégration
Docker réels passent**, y compris Administration, inspection et break-glass.

Conservez le retour arrière dans
`~/.local/state/pi/rollback/zerobox-before-capabilities-20260910/` : il contient
le binaire précédent et son `zerobox-provenance.json`. Restaurez ces deux
fichiers ensemble si nécessaire. Le SHA-256 du binaire précédent est
`abbbb91b3500556e77f9552d15be0f732e01862f6236c828455264bebcfec64b`.

## Racines vérifiées

| Composant | Racine installée et version |
| --- | --- |
| Pi | `~/.pi/agent/node_modules/@earendil-works/pi-coding-agent`, `0.85.0`; `dist/index.js` résout vers `~/projects/pi-core/packages/coding-agent/dist/index.js` |
| Harness de test | `~/.pi/agent/node_modules/@abdwhb-png/pi-test-harness`, `0.7.0` |
| Permissions | `~/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system`, `24.0.0` |
| Extensions lors de la validation finale | `~/.pi/agent/extensions` |
| Subagents | `~/.pi/agent/git/github.com/abdwhb-png/pi-subagents/src/api/delegation.ts`, `0.62.0` |
| Adaptateur MCP corrigé | `~/.pi/agent/git/github.com/abdwhb-png/pi-mcp-adapter`, `2.27.0`, commit local `53733d3` |
| Zerobox | `~/.pi/bin/zerobox`, SHA-256 `1a8202290afac9a4f8396ef7e0d8918cbcf82c4a89ebe6c303c3536e04aad53d` |
| SFW / npm | Binaire SFW `1.15.1`, npm `12.0.1` |

Les dépendances existantes ont été réutilisées. Les dépendances Analysis ont
été copiées localement dans le worktree pour respecter ses chemins lisibles
stricts. Aucun lien de dépendances propre au worktree ne fait partie des commits.

## Activation et limites

Redémarrez Pi complètement. Dans chaque projet concerné, ouvrez `/sandbox
capabilities migrate`, comparez les anciennes ouvertures et choisissez une fois
les droits à conserver. Aucune autorisation locale réelle n’a été accordée par
cette livraison. Le fichier d’autorité réel est absent après les tests.

Les outils natifs de fichiers restent sur l’hôte. Les intégrations accordées
utilisent le réseau et les fichiers temporaires de l’hôte. Gardez les projets
hors du `/tmp` hôte lorsque le namespace shell est privé. Les lanceurs de GUI
et les services externes peuvent terminer leur requête avant leur travail
effectif. Les gestionnaires autres que npm et les sources Pi non npm restent
hors périmètre de l’adaptateur de dépendances.

La campagne avec modèles économiques n’a pas été exécutée. Les scénarios,
mesures et seuils initiaux sont livrés séparément. Ne concluez pas à la
fiabilité de ces modèles avant de mesurer leurs essais.
