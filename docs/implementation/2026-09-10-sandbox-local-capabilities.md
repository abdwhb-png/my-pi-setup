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

Le runtime a été commité avant l’autorité pour introduire son contrat de
namespace avant ses consommateurs. Aucun paquet de permissions ni manifeste
de dépendances n’a été modifié. Le binaire Zerobox installé reste inchangé.

## Vérifications exécutées

Exécutez les commandes depuis `~/.pi/agent`, avec les dépendances déjà installées.

```sh
bun test --isolate extensions/sandbox/ extensions/bash-execution/ \
  extensions/_shared/sandbox-runtime/ extensions/_shared/command-execution/ \
  extensions/_shared/execution-provenance/
```

Dernière suite élargie dans le worktree : **602 réussites, 8 parcours optionnels
désactivés, 1 échec Docker préexistant**, sur 611 tests. Après cette exécution,
un cas supplémentaire vérifie que le profil hôte autorisé reste indépendant
des préférences de lecture du moteur strict : les 8 tests d’autorité passent.
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
ciblé des 40 fichiers TypeScript se termine avec **0 erreur et 97 avertissements**.
Le script `lint` force un parcours global avec `oxlint .`; le binaire local a
donc été utilisé directement pour limiter ce contrôle aux fichiers de la tâche.
`git diff --check` passe.

```sh
bun run typecheck
./node_modules/.bin/tsc --noEmit -p tsconfig.sandbox.json
```

Le contrôle global dans le worktree reste en échec avec **25 diagnostics hors
des fichiers de la tâche**. Il inclut des erreurs des autres extensions et des
résolutions de dépendances propres au worktree. Le contrôle ciblé reste bloqué
par un diagnostic transitif préexistant dans `pi-mcp-adapter/unix-socket-transport.ts:33`
(`string | NonSharedBuffer` transmis à une API attendant `Buffer`). Aucun
diagnostic ne vise les modules modifiés. Ne présentez pas ces commandes comme
un contrôle de types global réussi.

## Écart Docker confirmé avant changement

Le test `extensions/sandbox/docker-exec.integration.test.ts` échoue également
dans le checkout d’origine au commit `6d4aa91`. Le runtime installé est
`0.3.3-fork.17`, commit source `fff8a45a6092f78f7c4fefd57ad3fc9ac449ff94`.
Le checkout Zerobox consulté est plus récent (`d21bf650c100d09f79e4d217513ba66f0675c6c9`).
Le binaire ancien renvoie `Docker operation forbidden` et son validateur
`safe_exec_create_body` refuse `DetachKeys: ""`, accepté par le contrat de test
plus récent. Le test adapté au `/tmp` privé atteint ce refus `unsafe Docker exec
forbidden`. Le décalage n’a pas été corrigé en élargissant les autorisations ou
en remplaçant le binaire. Traitez sa mise à jour et sa provenance dans une
livraison Zerobox distincte. Les garanties Docker Administration/break-glass de
ce test ne sont donc pas validées contre le binaire actuellement installé.

## Racines vérifiées

| Composant | Racine installée et version |
| --- | --- |
| Pi | `~/.pi/agent/node_modules/@earendil-works/pi-coding-agent`, `0.85.0`; `dist/index.js` résout vers `~/projects/pi-core/packages/coding-agent/dist/index.js` |
| Harness de test | `~/.pi/agent/node_modules/@abdwhb-png/pi-test-harness`, `0.7.0` |
| Permissions | `~/.pi/agent/npm/node_modules/@gotgenes/pi-permission-system`, `24.0.0` |
| Extensions modifiées pendant les tests | `~/.pi-worktrees/sandbox-local-capabilities/agent/extensions` |
| Zerobox | `~/.pi/bin/zerobox`, SHA-256 `abbbb91b3500556e77f9552d15be0f732e01862f6236c828455264bebcfec64b` |
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
