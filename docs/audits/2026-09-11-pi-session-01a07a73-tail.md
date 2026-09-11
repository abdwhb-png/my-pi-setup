# Analyse de la fin de la session Pi 01a07a73

**Une partie des refus est cohérente avec les règles actuelles. Les échecs de cache Go et d’Analysis ne constituent pas un fonctionnement normal. Cette session ne permet pas d’évaluer la nouvelle implémentation : l’installation personnelle utilise encore l’ancien sandbox.**

Périmètre : branche finale de la [session enregistrée](/home/abdwhb/.pi/agent/sessions/--home-abdwhb-projects-shared-services-cliproxy--/2026-09-07T06-00-12-870Z_01a07a73-ed37-7369-992a-bd005f37f28d.jsonl:1018), le 11 septembre 2026, jusqu’à 10:29:31 UTC. Le fichier a été créé le 7 septembre, puis repris. Les 43 dernières entrées contiennent **26 résultats d’outils, dont 8 avec `isError:true`**. Le parcours des `parentId` confirme qu’ils appartiennent à la branche finale.

## F1 — La nouvelle version n’était pas activée

Trois observations concordent :

- Les commandes enregistrent `shellProfile: integrated`, `profile: bash-general`, `/tmp` hôte et les chemins de cache physiques de l’ancienne politique.
- L’installation personnelle conserve `sandbox.json` au format précédent et `sandbox.global.json` avec les autorisations Docker historiques.
- Le SHA-256 du binaire installé correspond à l’ancienne provenance, tandis que le candidat reste distinct.

| Binaire vérifié pendant cet audit | SHA-256 |
|---|---|
| `~/.pi/bin/zerobox` | `1a8202290afac9a4f8396ef7e0d8918cbcf82c4a89ebe6c303c3536e04aad53d` |
| `/tmp/pi-sandbox-candidate-87a73d/zerobox` | `87a73d1bd2556ad629e3a675b8d39898aa693c4e0b7cc27c33078e4a3b298b7f` |

Les deux portent la même version textuelle `0.3.3-fork.17` : le numéro de version seul ne les distingue pas. La session n’enregistre pas l’empreinte du binaire exécuté. L’attribution repose sur ses marqueurs de politique, recoupés avec les fichiers installés.

Le [rapport de livraison](/home/abdwhb/.pi/docs/superpowers/plans/2026-09-10-sandbox-generalisation-execution.md:9) indiquait une livraison dans les worktrees, sans activation personnelle. Relancer Pi depuis l’installation habituelle ne charge donc pas automatiquement ce candidat.

## F2 — Quatre échecs s’expliquent par les chemins et les règles

| Échec | Explication | Appréciation |
|---|---|---|
| Deux `read`, lignes 1042–1043 | Les scripts demandés se trouvent sous l’identifiant d’une autre session de debug et sont absents (`ENOENT`). | Références périmées ou indisponibles. Aucun refus du sandbox. |
| `docker exec`, ligne 1045 | L’agent demande `sh -lc` pour lire une configuration. La cible possède une exception d’accès hôte, qui limite les commandes `exec` persistantes à quelques inspections précises. | Refus attendu de la politique Docker installée. |
| `safe_bash find`, ligne 1048 | Le garde de commandes impose l’outil natif `find`. Il bloque avant l’exécution. | Refus attendu du harness, indépendant de Zerobox. |

Le [contrat Docker installé](/home/abdwhb/.pi/agent/extensions/sandbox/docs/troubleshooting.md:38) décrit explicitement cette restriction. La redirection vers les outils natifs vient du [garde partagé](/home/abdwhb/.pi/agent/extensions/_shared/command-execution/guard.ts:473).

## F3 — Le cache Go révèle un défaut réel de l’ancienne configuration

À la ligne 1049, `make ... verify` échoue avant les tests : Go ne peut pas créer son cache sous `~/.pi/zbx/l-0fa3be/home/.cache/go-build`.

La [politique installée](/home/abdwhb/.pi/agent/extensions/sandbox/runtime/policies.ts:598) place les caches et `DOCKER_CONFIG` sous le répertoire physique du bail, alors que son parent fait partie des chemins masqués. La trace confirme le refus de permission sur ce parent. Les quatre avertissements Docker sur `home/config.json` sont cohérents avec cette même disposition, même lorsque la commande Docker aboutit.

L’agent essaie ensuite `HOME=/tmp XDG_CACHE_HOME=/tmp/go-cache`. Cela lui permet d’atteindre les tests, ce qui confirme que le premier obstacle était bien l’emplacement du cache.

Le candidat utilise un [HOME logique `/home/sandbox`](/home/abdwhb/projects/pi-integrations/.worktrees/pi-sandbox-generalisation/agent/extensions/sandbox/runtime/policies.ts:801), monté par [`--private-home`](/home/abdwhb/projects/pi-integrations/.worktrees/pi-sandbox-generalisation/agent/extensions/sandbox/runtime/zerobox-backend.ts:557). Ce changement traite ce défaut architectural. Le workflow Cliproxy exact n’a toutefois pas été rejoué sur ce candidat pendant cet audit.

## F4 — Le second échec Go est indéterminable avec cette sortie

À la ligne 1054, la compilation du plugin `cliproxy-model-policy-scheduler` échoue. Les tests simples sur les en-têtes passent.

La cause de compilation manque parce que le [helper du test](/home/abdwhb/projects/shared-services/cliproxy/tests/muse-transport/muse_transport_test.go:390) envoie **stdout et stderr vers `io.Discard`**. L’unique message conservé est `exit status 1`. Il ne permet pas de départager dépendance, compilateur C, accès disque ou autre cause.

## F5 — Les deux échecs Analysis ne prouvent pas un mauvais programme

| Appel | Ce que la trace établit | Ce qu’elle ne permet pas d’établir |
|---|---|---|
| JavaScript, ligne 1057 | Lecture du fichier réussie. Exécution Analysis attestée dans Zerobox, puis échec avec code 1. | Erreur du programme, du worker ou de son environnement. |
| Python, ligne 1059 | Lecture réussie. Échec avec `phase: setup` et runtime `unknown`. | Cause de préparation et lancement effectif du worker. |

Le [normaliseur Think-in-Code](/home/abdwhb/.pi/agent/extensions/think-in-code/coordinator.ts:201) transforme ces erreurs en `analysis-failed` avec `recovery: change_program`. Il masque volontairement les messages susceptibles de contenir les données analysées, mais perd aussi la distinction entre panne de préparation et erreur du programme.

Le conseil « changer le programme » n’est donc pas justifié pour l’échec Python observé. Les traces conservées ne suffisent pas à identifier la cause technique exacte des deux appels.

## F6 — L’erreur Muse reste sans diagnostic vérifié

Le problème initial était un HTTP 500 pour Muse 1.3. Le script nommé `muse-500-loop.sh` **relit un journal existant** : il ne rejoue aucune requête au fournisseur. Son code de sortie 0 signifie que cette lecture a réussi, même lorsque sa sortie contient `server_error`.

Le test de transport consulté utilise par ailleurs des alias Muse **1.2**. Il ne valide pas à lui seul le cas 1.3 signalé. La session se termine à la ligne 1060 par `The operation was aborted.`, sans conclusion. Cette trace ne précise pas l’origine de l’interruption.

## Suites proposées, non appliquées

- **A1 — Activer et vérifier ensemble le code, le binaire et la configuration du candidat**, en suivant la [procédure existante](/home/abdwhb/.pi/docs/superpowers/plans/2026-09-10-sandbox-generalisation-activation.md). Vérifier ensuite le cache et Analysis dans une session fraîche.
- **A2 — Rendre les échecs exploitables** : conserver un diagnostic Go borné et distinguer les erreurs de préparation Analysis des erreurs de programme, sans exposer les données analysées.
- **A3 — Reprendre séparément le HTTP 500 Muse** avec une requête minimale sur l’alias exact et son résultat HTTP. La session examinée n’établit aucun lien causal entre cette erreur fournisseur et le sandbox.

Audit effectué en lecture seule sur les traces, les scripts, les politiques et les empreintes. Aucun test, script de diagnostic ou appel fournisseur rejoué. Aucun changement de code, de configuration, de service ou d’installation effectué. Seul ce rapport a été ajouté.
