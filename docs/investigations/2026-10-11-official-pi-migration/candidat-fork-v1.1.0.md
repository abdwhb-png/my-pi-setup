# Candidat du fork Pi core 1.1.0

Le core fusionné est construit et validé dans un environnement isolé. La fusion n’est pas commitée et aucune promotion quotidienne n’a été effectuée. Ce document complète [l’état des lieux](./etat-des-lieux.md) avec les résultats du candidat, sans qualifier la future intégration A1/A2.

## S1 — Sources et références

La stable officielle a été vérifiée sur le registre npm et l’API GitHub le 11 octobre 2026 : [v1.1.0](https://github.com/earendil-works/pi/releases/tag/v1.1.0), publiée le 7 octobre, tag `abe508e1b89912adde45528136c3221eb69acdd7`. Le registre npm annonçait `latest: 1.1.0` et Node `>=22.19.0`.

Le checkout `~/engineering/pi-core` reste propre sur `codex/pi-core-v0.87.1`, commit `00c5e7e300baf77ea05c78fabac625b213e7a578`. La référence de retour `backup/pi-core-before-v1.1.0-20261011` pointe sur ce commit.

Le worktree candidat est `/tmp/pi-core-v1.1.0-candidate`, branche `codex/pi-core-v1.1.0`. La fusion `--no-commit --no-ff v1.1.0` a dix conflits résolus, aucun conflit restant et aucune modification hors index. Les conflits concernaient le générateur de modèles, le changelog coding-agent, cinq documents CLI/UI, le parseur CLI, les tests TUI et le script de release locale. Le delta final par rapport au tag officiel porte sur 46 fichiers, incluant les patches antérieurs du fork.

L’arbre exact validé est `740667b8a1eb8e3a174b18320a77fab8a127e2b5`. La référence locale `refs/pi-core-candidates/v1.1.0-tree` conserve cet arbre dans le dépôt principal, sans commit. Les artefacts portent honnêtement la provenance du HEAD initial avec `dirty: true`. `AGENTS.md` impose « Never commit unless the user asks ».

## S2 — Décisions sur les patches

| Référence | Résultat |
| --- | --- |
| K1 | `ui_prompt_before` attendu avant affichage, blocage, erreurs et export public `UIPromptBlockedError` conservés. Les événements officiels `ui_prompt_start/end` restent présents. |
| K2 | `--fullscreen-layout fixed\|document`, réglage persistant, défilement, marqueurs d’ancrage et focus conservés. La priorité CLI sur le réglage a été vérifiée dans les deux sens. |
| K3 | Le propriétaire officiel des tarballs et de SHA-512 est conservé. Un petit adaptateur produit `release-manifest.json`, `source.repository` et SHA-256 depuis les mêmes artefacts vérifiés. Le promoteur de `~/.pi` n’a pas été modifié. Le build local vérifie les données de modèles présentes au lieu de les rafraîchir implicitement. |
| K4 | Les alias de sous-chemins sont conservés. Le test du paquet construit a révélé que le bundle utilise des modules intégrés plutôt que ces alias. La table existante contient désormais `models`, `providers/faux`, `utils/transcript` et `api/openai-completions` pour les deux noms de packages Pi. Les imports des extensions A1/A2 restent intacts. |
| K5 | Le générateur est identique à celui du tag officiel. L’effort Copilot Opus 5.5 est déjà repris en amont, sans patch doublonné. |
| K6 | L’isolation clipboard WSL et les téléchargements Ollama sur opt-in sont conservés. Aucun téléchargement Ollama ni appel à un provider payant n’a été lancé. |

L’adaptation supplémentaire de `npm pack --json` accepte l’objet retourné par npm 12 et conserve le format tableau antérieur. Les tests de release ont reproduit les échecs avant correction : manifeste de promotion absent, rafraîchissement de modèles malgré un build hors ligne et sortie npm pack rejetée. Le test Jiti a reproduit l’absence des sous-chemins intégrés avant correction.

## S3 — Candidat exécutable

- C1 — Release immuable temporaire : `/tmp/pi-core-v1.1.0-runtime/releases/1.1.0-00c5e7e300ba-dirty-b18c85af9dc9`. Le package root résolu est son `install/node_modules/@earendil-works/pi-coding-agent`.
- C2 — Manifestes et tarballs finaux : `/tmp/pi-core-v1.1.0-artifacts/final-packed/`. Le consommateur npm de ces artefacts est `/tmp/pi-core-v1.1.0-artifacts/validated-consumer/`.
- C3 — Binaire Linux x64 final : `/tmp/pi-core-v1.1.0-artifacts/binary-build-final/linux-x64/pi`, archive `binary-build-final/pi-linux-x64.tar.gz`.

Les artefacts initiaux directement à la racine de `/tmp/pi-core-v1.1.0-artifacts/` et dans `binary-build/` précèdent la correction Jiti. Utiliser exclusivement les chemins finaux C1–C3. Les répertoires temporaires doivent être conservés jusqu’à l’enregistrement du candidat ou reconstruits depuis l’arbre sauvegardé.

## Vérifications exécutées

| Référence | Vérification | Résultat |
| --- | --- | --- |
| V1 | Parseur CLI, runner extensions, TUI interactive, réglages et sélecteurs, clipboard, alias Jiti, tests Ollama isolés et scripts de packaging | 425 tests ciblés distincts passent : 96 parseur, 67 runner, 137 UI/réglages/clipboard, 113 TUI, 5 scripts, 4 Ollama, 3 chargement d’extensions. |
| V2 | `npm run check`, après la dernière correction de code | Passe : Biome, versions exactes, dépendances runtime, imports, budgets des graphes d’entrée, install-lock, TypeScript et smoke navigateur. |
| V3 | Build `release:local`, modèle catalogue hydraté depuis la révision officielle figée | Passe. SHA-256 du catalogue : `439c53478c84ed27a58f8b54e1c3bd45810e5a969515b4e3666a3898d51ee22f`. Hydratation et compilation suivantes hors ligne. |
| V4 | Installations contrôlées par Socket Firewall, sans lifecycle | `sfw npm ci --ignore-scripts`, consommateurs npm et installations Bun du promoteur passent. Lockfile officiel conservé. |
| V5 | Version, help, imports d’extensions, prompt avec faux provider, RPC et blocage UI avant requête UI | Passent sur Node bundle, Node sans bundle, Bun et binaire Linux. Le consommateur npm distinct passe également sous Node et Bun. Configurations et cwd temporaires, environnement sans identifiants de providers. |
| V6 | Interface interactive en PTY 80×24 | Six essais passent : Node, Bun et binaire Linux, chacun en `fixed` et `document`, avec prompt, réponse et garde UI. `tmux` est absent. Herdr n’a pas été utilisé. |
| V7 | Vrai `deployFork` et vrai `rollbackFork` avec runtimeRoot/agentDir temporaires | Candidat activé, cohérence validée, retour vers une copie de 0.87.1 et cohérence revalidée. Aucun lien quotidien modifié. |
| V8 | Session synthétique version 3 sur copies | Deux messages produits par 0.87.1 lus par 1.1.0, deux messages ajoutés puis relus par 0.87.1. Original byte-identique. |
| V9 | État quotidien final | `pi-fork status`, `pi-fork verify` et `pi --version` confirment encore `0.87.1-00c5e7e300ba-51024884e6e0`, version `0.87.1`. |

Les preuves persistantes sont `/tmp/pi-core-v1.1.0-runtime/isolated-deploy.json`, `isolated-rollback.json`, `/tmp/pi-core-v1.1.0-artifacts/runtime-smoke.json` pour le consommateur npm, `interactive-smoke.json`, les captures `interactive/*/terminal.txt` et `session-copy/result.json`. Les scripts des sondes sont sous `/tmp/pi-core-*.{mjs,ts,py}`.

## Limites et étapes avant promotion

- L1 — Le harness personnel complet, les travaux A1/A2 et leur combinaison avec `pi-subagents` mis à jour n’ont pas été qualifiés. Ni MCP ni codemode n’ont été activés dans la configuration quotidienne. La suite globale, les E2E authentifiés, le sandbox Docker et le rendu dans Herdr n’ont pas été exécutés.
- L2 — Le rollback remet les pins des paquets de l’ancienne release, mais laisse les nouveaux `pi-codemode`, `pi-env` et `pi-mcp` dans l’agent temporaire. La vérification de cohérence passe, sans retour byte-identique du manifeste. Inversement, le déploiement conserve l’ancien paquet SQLite absent de la nouvelle liste. L’inventaire de ces pins doit être revu avec le propriétaire du harness avant promotion. Aucun correctif du promoteur n’a été appliqué en parallèle d’A1/A2.
- L3 — L’audit npm du monorepo signale deux vulnérabilités hautes sur la chaîne d’exemple `@earendil-works/gondolin` → `node-forge`, sans correction annoncée dans le résultat. Ces deux packages sont absents du lockfile du consommateur CLI installé. Les autres plateformes natives et les sessions personnelles complexes ne sont pas couvertes par ces essais.

## Procédure de promotion séparée

P1 — Après autorisation du commit, enregistrer la fusion dans la branche candidate avec les hooks habituels. Le lockfile officiel importé requiert l’autorisation explicite prévue par `PI_ALLOW_LOCKFILE_CHANGE=1`. Vérifier que `HEAD^{tree}` vaut toujours l’arbre S1. Aucun push ni publication n’est nécessaire.

P2 — Terminer la qualification conjointe avec A1/A2 et résoudre L2. Sauvegarder localement les pins et le lockfile de l’agent au moment de la promotion, sans les utiliser comme fixtures de tests. Recontrôler `pi-fork status` et `pi-fork verify`. Le `pi-fork deploy` ordinaire pointe sur `~/engineering/pi-core`, qui est toujours sur la baseline : ne pas l’utiliser tel quel pour ce candidat.

P3 — La sonde préparée `/tmp/pi-core-promote-validated-candidate.ts` appelle le vrai `deployFork({ sourceRoot: "/tmp/pi-core-v1.1.0-candidate" })` et refuse une source non commitée ou un arbre différent. Elle n’a pas été exécutée. Après autorisation distincte de la promotion, son exécution par Bun produit une nouvelle release propre et bascule le runtime quotidien. Vérifier ensuite `~/.pi/bin/pi-fork verify`, `~/.pi/bin/pi --version` et les scénarios du harness qualifiés en P2.

P4 — Pour revenir à la release précédente après une promotion autorisée, utiliser `~/.pi/bin/pi-fork rollback`, puis `verify`, `status` et `pi --version`. Le mécanisme a été exercé sur copies, mais L2 impose de contrôler aussi les pins résiduels. Ne pas restaurer un ancien manifeste global par-dessus des modifications A1/A2 intervenues entre-temps. Le checkout baseline et sa référence de sauvegarde restent disponibles indépendamment du rollback runtime.
