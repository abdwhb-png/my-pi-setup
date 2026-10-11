# Intégration Pi 1.1.0 : N1, N2 et promotion N3

Le moteur quotidien Pi 1.1.0 est promu le 11 octobre 2026 avec autorisation explicite de l’utilisateur. Les packages qualifiés résident sous `~/.pi/runtime/package-sets/pi-1.1.0-20261011/`, les dépendances sont épinglées, les dix configurations MCP natives sont appliquées et pi-mcp-adapter est retiré. Les échecs MCP externes et les commandes de projets restant à qualifier sont explicitement acceptés pour cette promotion. La sauvegarde et les preuves finales se trouvent dans `~/.pi/runtime/migrations/2026-10-11-pi-1.1.0/`. Les sections ci-dessous conservent les détails et limites de la qualification du candidat. Les sources restent non commitées. Aucune publication, mise à jour globale de Node/Bun ou modification Foundry Agent n’a été effectuée.

## N1 — Candidat intégré

### D1 — Sources et fonctionnalités conservées

Le core est fusionné dans `/tmp/pi-core-v1.1.0-candidate`, branche `codex/pi-core-v1.1.0`, depuis le fork `00c5e7e300baf77ea05c78fabac625b213e7a578` vers le tag officiel `v1.1.0`, commit `abe508e1b89912adde45528136c3221eb69acdd7`. Le candidat construit est `1.1.0-00c5e7e300ba-dirty-79f8bc0b6a58`. Son identifiant indique correctement des sources non commitées. Le harness est sur `codex/pi-1.1-integration`, basé sur `7c9bc2619039e36ea707dc713c4181a016e8ee97`, avec les travaux A1/A2 terminés.

Le garde `ui_prompt_before` d’Unattended, le plein écran `document`, les alias Bun/Jiti utiles, le contrat local des artefacts et l’isolation des tests WSL/Ollama restent présents. Le core exporte publiquement `mcpNamespace` et `createMcpToolName` pour éviter une copie du nommage MCP dans le harness.

### D2 — Packages retenus

| Package | Candidat | Adaptation ou preuve spécifique |
| --- | --- | --- |
| pi-subagents | 0.77.0 + fork A1/A2 | Contrat RPC `script`, attente des commandes asynchrones et classification des résultats en erreur. Cycle réel de lancement, interruption et reprise sous Bun. |
| pi-agent-browser-native | 0.9.4 + fork | Validation des arguments depuis l’aide, cache, normalisation des actions, réserve de la file avant la validation asynchrone, préparation via sfw/Bun et Node minimal 22.19 conservés. |
| pi-lens | 4.4.3 + fork | Résolution du tsconfig du harness conservée. Artefact installé dans une racine privée. Navigation LSP réelle sous Pi 1.1.0. |
| rpiv-todo | 2.12.0-abdwhb.0 | Adaptation des fixtures au terminal et au JSON du core 1.1.0. |
| pi-fancy-footer | 3.1.0-abdwhb.0 | Copie du fork existant, sans migration fonctionnelle. Validé avec Todo et le mode document. |
| @gotgenes/pi-permission-system | 40.1.4 | Refus des appels MCP imbriqués vérifié au runtime. |
| pi-web-access | 0.38.0 | Chargement depuis la racine installée du candidat. |
| pi-hermes-memory | 0.9.10 | Chargement depuis la racine installée du candidat. |
| @juicesharp/rpiv-ask-user-question | 2.12.0 | Chargement depuis la racine installée du candidat. |
| @abdwhb-png/pi-test-harness | 0.8.1-fork.3 | Compatibilité des providers, modèles et peers avec Pi 1.1.0. |
| pi-session-recall | 0.1.0, peers adaptés | Suite du package, types et build validés. |
| pi-mcp-adapter | Retiré du candidat | Remplacé par le MCP natif. Encore présent dans le quotidien 0.87.1. |

Les versions et commits exacts issus des registres officiels sont conservés dans `evidence/registry.json` et `evidence/owners.json`. Les packages gérés par Pi ont été modifiés via la CLI Pi isolée. Les forks restent dans leurs dépôts indépendants. Pi Lens reste une extension explicitement chargée, sans activation implicite de toutes ses skills.

### D3 — MCP natif et politique d’outils

Dix configurations ont été traduites en copies privées : globale, projet `~/.pi`, GS Technical Services, Warriors Trading, Quickcoin, Clipty et son backend, CryptoLoan, Falla Cash et Shein. Le manifeste privé `evidence/mcp-migration.json` contient les sources, cibles, empreintes et variables référencées. Les `.mcp.json` utilisés par les autres clients sont conservés. Foundry Agent est exclu.

`directTools: true` devient une exposition directe. Les serveurs auparavant différés passent par codemode, et les listes d’outils directs deviennent des sélections explicites. Les références d’environnement sont conservées, y compris pour Authorization HTTP. Les champs `env` d’un serveur HTTP ne lancent aucun processus et ne sont pas convertis en variables de processus. Les clés ainsi ignorées sont signalées dans le manifeste. Les anciennes options lazy/idle de l’adapter n’ont pas d’équivalent complet : le natif démarre les serveurs activés en arrière-plan.

Le résolveur utilise l’inventaire réel du core et ses helpers publics. La politique distingue autorisation et présence dans le schéma LLM. Un outil MCP différé peut être autorisé sans être déclaré directement. Les restrictions de rôle et de sous-agent restent appliquées aux appels imbriqués et après `tool_search`. Le groupe `codemode` contient `codemode` et `tool_search`, et les groupes `docs` et `web` l’incluent. Cette modification de `agent/config/tool-groups.json` fait partie du candidat et doit être migrée avec les configurations.

### V1 — Contrôles exécutés

| Surface | Preuve obtenue | Journal dans `evidence/` |
| --- | --- | --- |
| Core | `npm run check`, build et 425 tests ciblés déjà exécutés sur les conflits et fonctionnalités conservées | Rapport core antérieur et journaux de qualification core |
| Harness final | Typecheck et lint réussis, incluant les frontières des extensions. Le lint conserve ses avertissements habituels | `harness-typecheck-final-2.log`, `harness-lint-final-2.log` |
| Migration et sécurité natives | 27 tests, 109 assertions : promoteur, snapshot, MCP, codemode, permissions et sandbox | `migration-core-gates-last.log` |
| Variables MCP | Stdio : `${VAR}`, `$VAR`, héritage. HTTP : interpolation des en-têtes Authorization et d’un second en-tête. Valeurs synthétiques | `native-env-final.log` |
| Configurations MCP | Dix fichiers acceptés par le chargeur natif, refus des projets non approuvés | Sorties de `validate-mcp.ts` |
| MCP publics | Découverte réelle : Context7 2 outils, DeepWiki 3, documentation OpenAI 5, Nuxt 4, Nuxt UI 12, Shadcn Vue 4 | `public-mcp.json`, `additional-http-mcp.json` |
| MCP authentifiés | Exa 3 outils et Firecrawl 28. Une recherche publique Exa et un scrape de pi.dev réussissent via codemode | `authenticated-mcp-calls.json` |
| MCP de projets | Clipty Laravel 15 outils. Quatre profils Dokploy : 102, 119, 94 et 46 outils découverts | `clipty-mcp-discovery.json`, `crypto-mcp-discovery.json` |
| Revue N2 | 22 tests, 82 assertions. Refus des chemins superposés dont le nom commence par deux points | `migration-review-tests.log`, `migration-dot-path-red.log`, `migration-review-final.log` |
| Qualification parallèle | Trois enfants réels, trois initialisations MCP et trois appels par échantillon. Trois mesures conservées après un échauffement | `native-fanout-measured.json`, `native-fanout-summary.json` |
| Vérifications après revue | Typecheck du harness et lint, frontières comprises | `harness-review-typecheck.log`, `harness-review-lint-full.log` |
| Chargement intégré | 50 extensions résolues et chargées, zéro erreur, racines concrètes enregistrées | `candidate-resources.json` |
| A1/A2 | Cycle réel CLI Bun, outils plafonnés, reload, foreground, async, interruption et reprise : 93 assertions | `subagents-lifecycle-4.log` |
| pi-subagents | Suites unitaires et intégration exécutées. Échecs de compatibilité corrigés. Les 15 échecs initiaux d’intégration passent lors de la reprise sérielle. Types et build réussis | `subagents-integration-recheck.log` et journaux ciblés |
| Browser | Lint strict, typecheck, build, 28 tests ciblés finaux et 11 tests sur Node 22.19.0 réussis | `browser-lint-final-4.log`, `browser-typecheck-final-4.log`, `browser-fork-final-3.log`, `browser-node22-last.log` |
| Browser réel | Pi 1.1.0/Bun, provider déterministe et Chromium réel : open, lecture via worker code, close | `browser-live-final-2.log`, `browser-live-persistent.json` |
| Browser démarrage | 191.6, 202.1 et 188.7 ms sous le budget de 250 ms. Les mesures précédentes sous charge dépassaient ce budget | `browser-startup-last.log` |
| Lens réel | Hover et symboles d’un projet TypeScript 7 via l’extension distribuée, téléchargement LSP désactivé | `lens-live-5.log`, `lens-live.json` |
| Todo/Footer/document | PTY réel sous le lanceur Bun candidat, défilement et redimensionnement, Todo et Footer actifs | `todo-footer-document-bun-3.log` |
| Todo | 256 tests avec le core 1.1.0, types réussis | Journaux `todo-*` |
| Test harness | 119 tests, 20 tests packaging, types/build/lint réussis | Journaux `test-harness-*` |
| Session recall | 99 tests, 479 assertions, types/build/lint réussis | Journaux `recall-*` |

### V2 — Limites et échecs conservés

La suite globale du harness a produit 5563 succès, 92 skips et 23 échecs avant corrections ciblées. Elle n’a pas été relancée intégralement. Les reprises ciblées couvrent les incompatibilités corrigées. Quatre échecs sandbox restent reproductibles sur le quotidien 0.87.1 : remplacement concurrent de runtime, délai d’un grant révoqué, contrôle timeout et contrôle abort en exécution hôte. Ils ne sont pas attribués à cette migration et ne sont pas masqués. Journaux : `daily-baseline-sandbox-races.log` et `daily-baseline-host-control.log`.

La suite globale Browser a produit 1527 succès, 49 skips et 10 échecs. Les corrections et reprises ciblées ont ensuite passé, y compris le dernier budget de démarrage. La suite entière n’a pas été rejouée après ces corrections. Ses tests de développement utilisent le SDK déclaré upstream 1.0.2. La compatibilité avec 1.1.0 est démontrée séparément par la session réelle sous Bun. Les mesures de démarrage sont celles du test Node du package et ne constituent pas une comparaison des performances globales de Pi.

Les cinq variables d’authentification sont absentes du processus Codex et du `zsh -lic` testé, mais disponibles par les canaux existants : `~/.pi/agent/.env` pour Exa/Firecrawl, `direnv exec` dans CryptoLoan pour Cloudflare/Dokploy/Hostinger. Les probes Exa/Firecrawl chargent explicitement le fichier avec `bun --env-file`. Cela prouve l’interpolation et les appels authentifiés, pas le chargement automatique de ce fichier global lors d’un lancement depuis n’importe quel projet. Les fichiers de secrets restent en place, leurs valeurs ne figurent pas dans les preuves publiées. Preuves : `login-shell-env.json`, `bun-cwd-env.json`, `crypto-direnv-env.json`.

Les connexions réelles Vision, Hostinger et Cloudflare échouent encore : Vision répond HTTP 404, les deux autres demandent une authentification même avec les variables disponibles. Leur cause n’est pas attribuée à la migration sans comparaison avec l’adapter. Aucun accès ni endpoint n’a été changé. Dokploy est qualifié via son exécutable déjà installé en cache npm, version 0.30.7, sans installation réseau. Cela valide le protocole et les profils, pas un futur téléchargement par `npx`. Aucune action de déploiement n’a été appelée. Preuves : `mcp-connection-diagnostics.json`, `crypto-mcp-discovery.json`.

GS, Quickcoin et Shein ont leurs processus arrêtés au contrôle Dev Services. Certains services liés sont non préparés ou arrêtés. Le conteneur Falla référencé n’est pas actif. Leur démarrage/provisionnement n’a pas été effectué. Warriors conserve sa commande WSL/Herd existante, non exécutée. Les lancements npx/uvx non qualifiés restent à vérifier sans contourner les contrôles de dépendances. Preuves : `project-mcp-prerequisites.json` et `dev-services-*-before.json`.

Le scénario de délégation parallèle a mesuré trois enfants réels sur Pi 1.1.0 et pi-subagents 0.77.0. Après un échauffement, les trois mesures via l’intégration du harness sont 4855, 4075 et 4679 ms, médiane 4679 ms. Chaque mesure comprend trois initialisations et trois appels MCP. Le RSS maximal échantillonné d’un enfant atteint 208,4 Mio, sans mesure de somme des RSS simultanés. Le parent utilise Bun, les enfants asynchrones utilisent Node selon l’exception upstream déjà retenue. Le provider est déterministe et le serveur MCP local. Ces mesures incluent toute la délégation et ne mesurent ni le seul surcoût MCP, ni un gain sur 0.87.1, ni la latence des serveurs privés. Les bras « reference » et « candidate » utilisent ici le même package 0.77.0, par deux interfaces différentes. Les grandes vagues d’enfants restent non mesurées. Le benchmark a été adapté au nommage natif et à la confiance explicite de ses propres répertoires temporaires. Il refuse désormais une délégation qui n’a pas exécuté son appel MCP. Preuves : `native-fanout-before.json.failure.json`, `native-fanout-measured.json`, `native-fanout-summary.json`. Le scénario interruption/reprise passe ensuite par les deux interfaces, avec deux processus successifs et deux initialisations MCP par scénario. Preuve : `native-interrupt-after.json`.

Le premier lancement parent avant découverte a été testé avec un serveur volontairement retardé : le preflight refuse explicitement le sélecteur pendant la connexion. Après `tool_search`, il résout exactement `mcp__fixture__echo`. Il ne met pas automatiquement la demande initiale en attente. Une première délégation qui sélectionne explicitement un MCP peut donc nécessiter découverte puis nouvelle tentative. Preuve : `parent-mcp-readiness.json` et `parent-mcp-readiness-4.log`.

## N2 — Retour arrière

### D4 — Promoteur core

`agent/bin/pi-fork-release.ts` conserve le graphe `node_modules` avant de synchroniser les dépendances Pi. Un échec d’installation, de cohérence ou d’activation restaure le manifeste, le lockfile et ce graphe. Les pins d’une ancienne release sont retirés dans les deux sens uniquement si leur appartenance à un manifeste de release géré est prouvée. Les dépendances étrangères sont préservées. Les 16 tests du promoteur passent. Le cycle core 1.1.0 → 0.87.1 → 1.1.0, répété, est cohérent.

### D5 — Transaction de migration complète

Le module `agent/bin/pi-migration-snapshot.ts` sauvegarde un ensemble explicite de chemins dans un répertoire privé, vérifie contenus, permissions et cibles des liens, journalise l’état et restaure après un échec d’application ou de validation. `rollbackMigration` refuse les changements personnels intervenus après la migration, vérifie les sauvegardes avant de toucher les cibles et permet la reprise d’une restauration interrompue. Les chemins superposés, racines système et journaux invalides sont refusés. Les six tests du module passent. La revue a reproduit puis corrigé une omission du contrôle de superposition pour un enfant nommé `..private` : seul le segment parent `..` doit être traité comme une sortie du répertoire.

Le laboratoire a exercé un graphe réel 0.87.1 → 1.1.0 → 0.87.1 → 1.1.0, incluant dépendances installées, adapter, configurations, extensions, Lens et un fichier MCP projet. Le premier retour a vérifié onze chemins. Une seconde capture a été interrompue avant application puis le candidat a été réappliqué et vérifié. Preuves : `whole-migration-cycle.json` et `whole-migration-cycle-resume.log`.

Le véritable mécanisme `active/current/previous` du runtime, le MCP global et le vrai fichier `agent/artifacts/package-finalizer-state.json` ont été qualifiés séparément avec les fonctions réelles du runtime et du snapshot. Les cinq chemins ont retrouvé leur état candidat après sélection temporaire de 0.87.1. Preuve : `runtime-state-rollback.json`. Sauvegarder seulement la façade `current` serait insuffisant, puisque le promoteur bascule le lien `active`.

Le snapshot ne fige pas automatiquement la cible externe d’un lien symbolique. Les racines des packages locaux devront donc être stabilisées avant promotion ou incluses dans la transaction si elles sont modifiées. Les sessions, l’authentification et les prompts personnels ne sont pas des fixtures et restent hors de cette transaction.

## N3 — Procédure préparée, non exécutée

Le manifeste privé `evidence/promotion-review.json` décrit les propriétaires, empreintes et chemins à sauvegarder. Il est destiné à la revue. Il n’autorise aucune exécution. Le candidat pointe encore vers des worktrees temporaires et des artefacts locaux : ne pas copier aveuglément son `settings.json`, son manifeste de dépendances ou son lockfile dans le quotidien.

- **N3.1 — Fermer les écarts de qualification.** Résoudre ou faire accepter explicitement les trois connexions en échec et qualifier les commandes MCP restantes des projets. Préserver les canaux d’environnement existants, sans afficher les valeurs. Pour une délégation qui sélectionne explicitement un MCP, effectuer la découverte avant le preflight ou reprendre après son refus explicite. La mesure locale à trois enfants est réalisée. Étendre à une grande vague et aux serveurs privés seulement si ce volume fait partie du scénario de promotion. Présenter les quatre échecs sandbox antérieurs comme tels. Conserver les contrôles de confiance des projets.
- **N3.2 — Figer les sources après revue.** Faire approuver puis créer les commits de chaque dépôt indépendant. Conserver les références de retour. Préparer des racines durables pour les packages locaux et reconstruire une release propre. Préserver le fork Footer existant. Recalculer les empreintes et remplacer uniquement les références temporaires correspondantes dans la configuration destinée au quotidien.
- **N3.3 — Obtenir l’accord de promotion.** Présenter les versions, le diff des configurations sans secrets, les limites restantes, les chemins de sauvegarde et le journal de retour prévu. La promotion quotidienne est une décision séparée de cette implémentation.
- **N3.4 — Exécuter la transaction.** Arrêter les processus Pi affectés, contrôler à nouveau les empreintes des sources et cibles, puis appeler `runMigration` sur le manifeste explicite. Appliquer les changements du harness, promouvoir le core avec le promoteur corrigé, installer/retirer les packages via la CLI Pi, installer l’artefact Lens prévu, copier les configurations MCP et config du harness, puis remettre le finaliseur `tool-groups` en dernier. Les nouveaux pins core sont générés par le promoteur pour les chemins quotidiens. Toutes ces écritures appartiennent à la transaction.
- **N3.5 — Vérifier avant réouverture.** Exécuter `pi-fork verify`, contrôler les racines réellement chargées, le MCP natif sans adapter actif, le runtime choisi par les enfants, une reprise de session, le refus Unattended, les garde-fous codemode et le TUI document/Todo/Footer. En cas d’échec, `runMigration` restaure l’ensemble. Conserver le journal privé et les anciennes releases après succès.
- **N3.6 — Revenir si nécessaire.** Fermer les processus affectés et appeler `rollbackMigration(journalPath)` depuis une copie stable de l’outil hors des chemins restaurés. Vérifier ensuite `pi-fork status` et `pi-fork verify`, le retour de l’adapter et les racines des packages. Ne pas utiliser seulement `pi-fork rollback` pour annuler la migration complète : il ne restaure pas les packages ni les configurations MCP.

Exemple de retour, après expansion du chemin du journal réel et après fermeture des processus concernés :

```ts
import { rollbackMigration } from './pi-migration-snapshot.ts';
rollbackMigration(process.argv[2]);
```

Le script est exécuté avec Bun depuis la copie stable de l’outil. Le journal exact est produit par `runMigration`, jamais inventé à partir d’un nom de release.

### V3 — État quotidien et incident de qualification

Les empreintes de `agent/settings.json`, `agent/package.json`, `agent/bun.lock`, `agent/mcp-adapter.json` et des dix sources/cibles MCP quotidiennes sont identiques à la baseline. Le runtime quotidien passe `pi-fork verify`. Aucun lien de package projet ne pointe vers le candidat. Preuves : `final-state.json`, `continuation-daily-state.json`, `daily-status-final.log`, `daily-verify-final.log`. Le contrôle après cette revue confirme les empreintes quotidiennes inchangées, aucune modification suivie dans le harness quotidien et aucun lien de package projet vers le candidat.

Un premier probe SDK avait gardé `process.cwd()` sur `~/.pi` et le finaliseur avait réécrit neuf liens sous `~/.pi/.pi/node_modules` vers le candidat. Ces liens ont été restaurés vers les racines quotidiennes et vérifiés. Les probes suivants changent explicitement le cwd dans leur répertoire privé avant le chargement des extensions. Le runtime quotidien n’a pas basculé pendant cet incident. Preuve : `project-links-restored.json`.

### R1 — Portée de la revue complémentaire

Revue locale du promoteur, du snapshot, de la résolution MCP, de la politique d’exposition, des frontières de préflight et de la validation Browser. Aucun agent de revue indépendant n’a été lancé. Les huit lots `review/` rassemblent les patchs et nouveaux fichiers par dépôt pour une revue complète. Le probe personnel déjà suivi `agent/.probe-runtime-agent.ts` est conservé à l’identique de la baseline, sans suppression dans le candidat. Les limites V2 restent ouvertes.

Le contrôle `git diff --check HEAD` passe pour six dépôts. Browser et Lens signalent des espaces dans des patchs, documents et fixtures importés, tous vérifiés identiques au commit upstream retenu. Ils sont conservés. Le contrôle des modifications non indexées passe dans les huit dépôts. Preuve : `review-diff-checks.json`.
