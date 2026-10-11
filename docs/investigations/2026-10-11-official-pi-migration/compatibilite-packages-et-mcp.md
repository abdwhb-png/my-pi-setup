# Compatibilité des packages et migration MCP du candidat Pi 1.1.0

Investigation du 11 octobre 2026, avant planification. Le candidat doit associer le core, les packages retenus, les adaptations locales et les configurations MCP. La qualification antérieure du core seul et celle d’A1/A2 sur Pi 0.87.1 ne prouvent pas cette combinaison. Aucun package, fichier personnel MCP, service ou runtime quotidien n’a été modifié par cet audit.

Précision de périmètre donnée ensuite par l’utilisateur : Foundry Agent est exclu de la migration actuelle. M10 reste une observation d’inventaire, sans modification demandée de ce projet. La conservation des références à des variables d’environnement est une exigence explicite de la migration MCP.

**Recommandation : viser MCP natif dans le candidat et retirer pi-mcp-adapter après adaptation de ses consommateurs.** Les transports configurés dans les fichiers Pi et partagés examinés sont stdio ou HTTP, couverts par le natif. L’adapter reste une alternative technique, notamment pour les imports de configurations d’autres clients, SSE et sa gestion du cycle de vie. Ses fonctionnalités supplémentaires ne constituent pas une obligation de le conserver. Les retirer exige toutefois une migration explicite des comportements utilisés.

## E1 — Sources et limites des preuves

Le registre npm officiel a été interrogé directement pendant cet audit, puis recontrôlé avant la conclusion. `@earendil-works/pi-coding-agent` a toujours `latest: 1.1.0`, publié le 7 octobre 2026, avec Node `>=22.19.0`. La cible officielle est `abe508e1b89912adde45528136c3221eb69acdd7`. Le candidat local est `/tmp/pi-core-v1.1.0-candidate`, arbre sauvegardé `740667b8a1eb8e3a174b18320a77fab8a127e2b5`. Voir [la qualification du core](./candidat-fork-v1.1.0.md).

L’inventaire part de `agent/settings.json`, des racines réellement installées et de leurs manifestes. Neuf archives npm des versions ci-dessous ont été téléchargées dans un répertoire temporaire et vérifiées contre leur intégrité publiée, sans installation ni exécution de leurs scripts. Les observations de code portent sur ces sources publiées et sur les modules locaux. Les réponses d’index documentaires ne servent pas de preuve de version ou de compatibilité.

Les données temporaires sont dans `/tmp/pi-package-compatibility-MOoAOG/` : `inventory.json`, `registry.json`, `snapshots.json`, `mcp-survey.json` et `mcp-validation.json`. Elles ne contiennent pas les valeurs des secrets de configuration. Les versions publiées sont des observations datées, à recontrôler avant toute installation.

## E2 — Matrice des packages

« Déclaration compatible » signifie que la plage de dépendance inclut Pi 1.1.0. Elle ne prouve pas le fonctionnement du package dans le harness personnel. Une plage qui l’exclut indique une qualification manquante, sans prouver à elle seule une rupture de code.

| Code | Package et propriétaire actuel | Installé | Dernière publication vérifiée | Conséquence pour le candidat |
| --- | --- | --- | --- | --- |
| P1 | `pi-subagents`, Git `~/.pi/agent/git/github.com/abdwhb-png/pi-subagents` | Base 0.73.1, tag `v0.73.1-a1a2.1`, commit `c0ae7d70464d15eeac1944d7d5d8f2c4bcf00d5e` | 0.77.0 | Mettre à jour le fork en conservant le correctif A1/A2 et adapter le contrat workflow. La publication upstream seule perdrait le correctif. |
| P2 | `pi-mcp-adapter`, npm géré par Pi | 3.0.0, pin explicite | 5.2.0 | Cible recommandée : retrait avec migration native. Si l’adapter est finalement conservé, 5.2.0 ajoute la compatibilité Pi 1.x. Ne pas activer deux propriétaires MCP. |
| P3 | `@gotgenes/pi-permission-system`, npm géré par Pi | 33.0.0 | 40.1.4 | La famille récente adapte le prompt structuré et les permissions MCP natives. Elle exige Pi et TUI `>=1.0.0`, donc ne doit pas remplacer la version quotidienne avant le nouveau core. |
| P4 | `pi-lens`, chemin explicite `~/engineering/shared-services/pi-lens-dist/node_modules/pi-lens` | 4.3.0 | 4.4.3 | La plage TUI actuelle exclut 1.1.0. La famille 4.4 annonce une qualification Pi 1.0/1.1 et 4.4.3 corrige un import LSP de 4.4.2. Préparer chez son propriétaire, puis vérifier le root réellement chargé. |
| P5 | `@abdwhb-png/pi-session-recall`, local `~/engineering/pi-integrations/pi-session-recall` | 0.1.0 | Package local | Ses peers `>=0.84.2 <0.88.0` excluent le candidat. Qualifier l’extension et adapter sa déclaration après preuve. Son serveur MCP autonome est une surface distincte. |
| P6 | `@abdwhb-png/pi-test-harness`, dépendance de développement du harness | 0.8.1-fork.2 | npm 0.8.0 | Préserver le fork local. Ses peers `^0.87.1` excluent le candidat. Un test public isolé passe sur le core 1.1.0, mais il reste à déclarer et qualifier le support complet requis par N1. La publication npm plus ancienne ne résout pas cela. |
| P7 | `pi-agent-browser-native`, Git `~/.pi/agent/git/github.com/abdwhb-png/pi-agent-browser-native` | Fork 0.6.10, commit `3e68864e780724101c00359bbb7a901be2bbac72` | 0.9.4 | La famille 0.9 adopte Pi 1.x. Préserver l’adaptation de build Bun du fork. La dernière publication exige Node `>=24.21.0`, alors que le Node observé est 24.18.0. Cette mise à jour nécessite une décision sur le runtime ciblé, pas une mise à jour globale implicite. |
| P8 | `pi-web-access`, npm géré par Pi | 0.35.0 | 0.38.0 | Mise à jour utile à examiner : erreurs structurées et isolation des fournisseurs entre sessions SDK. Les peers actuels sont ouverts, aucune obligation de mise à jour liée au core seul n’est établie. Examiner aussi les changements de modèles par défaut. |
| P9 | `pi-hermes-memory`, npm géré par Pi | 0.9.9 | 0.9.10 | Plage déclarée compatible avec 1.1.0. Mise à jour optionnelle, aucun blocage spécifique établi par cet audit. Vérifier SQLite et le runtime réel lors de la qualification. |
| P10 | `@juicesharp/rpiv-ask-user-question`, npm géré par Pi | 2.12.0 | 2.12.0 | Déjà à jour. Qualifier le garde UI du fork et les interactions TUI. |
| P11 | `@abdwhb-png/rpiv-todo`, Git `~/.pi/agent/git/github.com/abdwhb-png/rpiv-todo` | Manifeste 2.8.0, commit `115541a419fab336c8998aa8836b142f88d05f5e` | Upstream `@juicesharp/rpiv-todo` 2.12.0 | Le numéro local sous-estime la base : l’historique contient déjà la fusion upstream 2.11.0. Préserver les adaptations overlay/footer. Aucun motif de remplacement aveugle par le package upstream. |
| P12 | `pi-fancy-footer`, local `~/engineering/pi-integrations/pi-fancy-footer` | 3.1.0-abdwhb.0 | Upstream 3.1.0 | Pas de version upstream plus récente. Conserver le fork et qualifier ses composants plein écran. Le peer durable `^1.0.0` accepte le candidat. |
| P13 | `tool-groups`, package local `./extensions/tool-groups` | 0.1.0 | Local | Adaptation nécessaire du propriétaire existant des politiques, avec `pi-roles`, `slow-mode` et `pi-subagents-addons`. Voir F3. |

Les six packages npm sont résolus sous `~/.pi/agent/npm/node_modules/`. Les trois forks Git, les packages locaux et le chemin explicite pi-lens ont des propriétaires distincts. Les sous-dépendances Pi anciennes présentes dans certains roots ne prouvent pas que le runtime les utilise : Jiti fournit des alias d’hôte. Les tests d’intégration doivent vérifier le paquet effectivement résolu, pour éviter une qualification accidentelle contre 0.84–0.87.

## F1 — Mise à jour pi-subagents : deux adaptations certaines

La 0.77.0 conserve le défaut corrigé dans le fork A1/A2. Dans `src/agents/agents.js:1336`, la branche de surcharge projet retourne avant d’appliquer la surcharge utilisateur aux agents intégrés. Une surcharge projet limitée aux outils peut donc encore perdre le modèle et le niveau de réflexion définis globalement. Le correctif local applique d’abord la surcharge utilisateur puis celle du projet. Il doit être porté avec son test de régression.

Le contrat public des workflows a aussi changé. `src/extension/rpc.js:375` rejette explicitement `workflowScript` et `workflowScriptPath`. Un script inline RPC passe désormais par `script`, et un fichier ou workflow nommé par `workflow`. Or `agent/extensions/_shared/subagents/integration.ts:401` envoie encore `workflowScript`. Le propriétaire central doit évoluer, ainsi que les fixtures publiques qui appellent encore l’ancien schéma. Le tool LLM et le RPC ont des entrées différentes, à ne pas confondre.

La 0.77 apporte un schéma de tool plus petit, la conservation du cache de prompt lors des reprises, des sorties longues publiées sous forme d’aperçu et de fichier, ainsi qu’un workflow parallèle prédéfini. Il s’agit de changements vérifiés dans la publication, pas de gains mesurés sur ce setup. Elle sait également préparer MCP natif et codemode dans les enfants. La résolution des sélecteurs natifs lit le registre d’outils de l’hôte, alors que les connexions MCP arrivent de manière asynchrone. La readiness parent/enfant reste une preuve à obtenir. Les formats replay, archive et receipt examinés restent version 1, mais leur compatibilité complète avec le lecteur local n’a pas été exécutée.

Source : [publication pi-subagents 0.77.0](https://registry.npmjs.org/pi-subagents/0.77.0), [code et changelog au commit publié](https://github.com/nicobailon/pi-subagents/tree/1ac9b964eb9cda1662507c52f5277764637daccc).

## F2 — Le retrait de l’adapter doit couvrir le code local

`agent/extensions/_shared/mcp/ref-resolver.ts:1–11` importe les fonctions de référence, la configuration, le cache de métadonnées et les types de pi-mcp-adapter. `tool-groups` et `slow-mode` importent ce propriétaire partagé. Retirer le package sans remplacer ses imports ferait échouer leur chargement.

Les références `mcp:server[/tool]` figurent aussi dans les groupes, les rôles, certains agents et les overrides de sous-agents. Le natif nomme ses tools `mcp__<server>__<tool>`, avec normalisation des tirets et des caractères spéciaux. Le résolveur commun et ses consommateurs doivent s’appuyer sur le registre natif et préserver la signification des sélecteurs. La syntaxe personnelle `mcp:…` peut être conservée par ce propriétaire local si son contrat est maintenu. Un renommage manuel partout n’est pas une obligation technique.

L’adapter 5.2.0 constitue une alternative compatible Pi 1.x, mais ce n’est pas une étape obligatoire si la cible est son retrait. Lorsqu’il est installé, il remplace le MCP intégré et peut enregistrer l’exclusion `-builtin:mcp`. Cette exclusion n’est pas présente dans les settings actuels. La migration doit vérifier ce sélecteur dans le candidat et garantir un seul propriétaire des connexions et de `/mcp`.

Source : [pi-mcp-adapter au commit publié 5.2.0](https://github.com/nicobailon/pi-mcp-adapter/blob/80fcdef8d9f6958751f1e225f88b272440caa542/CHANGELOG.md).

## F3 — Autorisation et visibilité des tools sont actuellement couplées

La politique locale transforme `pi.getAllTools()` en une liste de noms et ignore la nouvelle propriété `ToolInfo.exposure`. En rôle `all`, elle active tous ces noms avec `pi.setActiveTools()`. Dans le candidat, un tool MCP `codemode` ou `deferred` est appelable sans être déclaré directement au modèle. Une activation explicite par nom le déclare. La politique actuelle annulerait donc l’exposition choisie et augmenterait le schéma des tools.

Le garde `tool_call` local utilise la même liste pour refuser les appels. Une simple exclusion des tools MCP de la liste visible bloquerait les appels imbriqués de codemode. L’adaptation doit distinguer les tools déclarés au modèle des tools autorisés à l’exécution, dans les propriétaires existants. Elle doit conserver les refus et les limites héritées par les enfants.

La chaîne complète concernée est : groupes/rôle parent → résolution des sélecteurs → overrides persistés par `pi-subagents-addons` → lancement enfant → politique enfant. `slow-mode` valide aujourd’hui à partir de `getActiveTools()`, ce qui ne suffit plus pour des tools natifs volontairement non déclarés. Les connexions tardives doivent être couvertes. `codemode` et `tool_search` doivent aussi rester accessibles quand le rôle attendu les permet, sans que le coordinateur les masque après leur activation native.

Références locales : `agent/extensions/_shared/tool-policy/index.ts:60`, `tool-groups/index.ts:185,236`, `pi-subagents-addons/tool-group-overrides.ts:457`, `slow-mode/index.ts:63`. Le spécialiste Pi a terminé cet audit en lecture seule. Aucun test d’exécution de ces extensions sur le candidat n’a été lancé.

## F4 — Permissions et prompt natif

Le handler installé en 33.0.0 retourne un `systemPrompt` rendu lorsqu’il réorganise la surface des tools ou filtre les skills. Dans Pi 1.x, ce texte retourné peut figer le prompt d’une exécution et empêcher l’arrivée de sections ajoutées ensuite, dont `<mcp_servers>`. La famille 37+ a remplacé cette stratégie par des mutations de `systemPromptOptions`, et la famille 38 ajoute le traitement des namespaces MCP natifs. Ces changements justifient l’inclusion du package de permissions dans la qualification du candidat.

Les hooks locaux examinés reprennent généralement `event.systemPrompt` avant d’ajouter leur texte. Le mode de traduction remplace intentionnellement le prompt pour sa tâche. À la fin de l’audit, `agent/SYSTEM.md` et `agent/APPEND_SYSTEM.md` sont absents. Le comportement de rôle par défaut est additif. Cela ne dispense pas de qualifier l’ordre des hooks et le prompt effectivement transmis au provider du candidat.

Source : [correction des sections de prompt](https://github.com/gotgenes/pi-packages/commit/1abdfe4901a27cb8ff3d85a965fc07b3be874624), [manifest publié 40.1.4](https://registry.npmjs.org/@gotgenes/pi-permission-system/40.1.4).

## F5 — Inventaire des fichiers MCP à migrer

Le scan inclut les fichiers cachés et ignorés par Git sous `~/.pi` et `~/projects`, en excluant les dépendances et les sorties de build. Les configurations JSONC VS Code ont été analysées avec le parseur déjà installé. Quarante fichiers hors caches de plugins et sauvegardes ont été lus, dont 76 définitions de serveurs, avec doublons entre clients et exemples. Ce compte n’est pas un nombre de serveurs actifs dans Pi. Un dossier de médias applicatifs de q-messenger était inaccessible au scan. Aucun fichier de configuration ciblé n’a échoué au parsing final.

Le chargeur réel du candidat ne lit que `~/.pi/agent/mcp.json` et `<cwd>/.pi/mcp.json` après confiance du projet. Il ne lit pas automatiquement `.mcp.json`, `.pi/mcp-adapter.json`, les fichiers VS Code/Gemini, ou les configurations d’ancêtres. Ce dernier point importe notamment pour Clipty et les monorepos : lancer Pi à la racine et dans un sous-projet n’a pas la même configuration native. Une entrée projet complète remplace celle de même nom globale. Une entrée partielle peut seulement modifier `enabled`, `exposure` et `toolExposure` du serveur global.

### M1–M10 — Fichiers Pi et partagés concernés directement

| Code | Source actuelle | Serveurs | Destination ou adaptation native |
| --- | --- | --- | --- |
| M1 | `~/.pi/agent/mcp-adapter.json` | context7, deepwiki, exa, firecrawl, vision-mcp-server, youtube-transcript | `~/.pi/agent/mcp.json`, conversion de l’exposition et de l’authentification Firecrawl. |
| M2 | `~/.pi/.pi/mcp-adapter.json` | openaiDeveloperDocs | `~/.pi/.pi/mcp.json`, préserver l’exposition choisie. |
| M3 | `~/projects/gstechnical-services/.mcp.json` | laravel-boost, nuxt | `.pi/mcp.json` du projet, préserver le filtre HTTP `X-MCP-Tools` et l’exposition. |
| M4 | `~/projects/warriors-trading/.mcp.json` | laravel-boost | `.pi/mcp.json` du projet. |
| M5 | `~/projects/quickcoin-platform/.mcp.json` | quickcoin-laravel-boost, finmark-laravel-boost, nexo-laravel-boost, nuxt, vision-mcp | `.pi/mcp.json` du projet, conserver les chemins, arguments, limites de racines et environnement de la vision. |
| M6 | `~/projects/Clipty-io/.mcp.json` et `apps/backend/.mcp.json` | nuxt-ui, shadcn-vue-docs à la racine, laravel-boost dans le backend | Deux `.pi/mcp.json` correspondant aux cwd utilisés. Ne pas supposer une fusion automatique parent/enfant. |
| M7 | `~/projects/cryptoLoan/crypto-vault/.mcp.json` | dokploy-advanced, dokploy-deploy, dokploy-databases, dokploy-git, hostinger-api, cloudflare-api | `.pi/mcp.json` du sous-projet. Convertir `bearerTokenEnv` en header natif et sécuriser la provenance des valeurs. |
| M8 | `~/projects/falla-cash-project/falla-cash/.pi/mcp.json` | laravel-boost, shadcn-ui, hugeicons, chrome-devtools | Chemin déjà natif. Convertir les champs d’exposition. Le `.mcp.json` racine est vide et ne représente pas ces serveurs. |
| M9 | `~/projects/shein-ecom/.pi/mcp.json` | laravel-boost, shadcn-ui, project_mcps, chrome-devtools-mcp | Chemin déjà natif. Convertir `directTools`/`lifecycle` et vérifier le cwd relatif de Laravel. |
| M10 | `~/projects/Foundry-AI/foundry-knowledge/tools/foundry-agent/.pi/mcp.json` et `config/mcp.json` | `imports: ["vscode"]`, aucun serveur inline | Hors périmètre actuel à la demande de l’utilisateur. Observation conservée : le natif ignore `imports` et charge zéro serveur sans erreur. Aucune modification de Foundry Agent prévue. |

Le `.mcp.json` racine de `~/.pi` est vide. Les chemins `~/.config/mcp/mcp.json`, `~/.agents/mcp.json` et `~/.agents/mcp/mcp.json` n’existent pas lors de cet audit. Les `.mcp.json` partagés peuvent servir à d’autres clients et doivent être conservés tant que leur usage n’est pas retiré. Choisir la source canonique ou une génération déjà possédée évite de maintenir deux jeux de règles à la main. Aucun nouvel outil de synchronisation n’est recommandé sans examiner les propriétaires existants.

### M11–M20 — Configurations d’autres clients recensées

Ces fichiers ne sont pas consommés automatiquement par MCP natif. L’adapter installé désactive la découverte des clients externes par défaut, sauf imports ou configuration contraire. Ils doivent rester utilisables par leurs propriétaires. Leur présence ne suffit pas à décider que tous leurs serveurs doivent être activés dans Pi.

| Code | Emplacement | Serveurs ou particularité |
| --- | --- | --- |
| M11 | `~/.pi/.vscode/mcp.json` | context-mode, deepwiki, openaiDeveloperDocs, pi-lens, pi-session-recall. Le dernier utilise `${workspaceFolder}`. |
| M12 | `~/projects/Clipty-io/.vscode/mcp.json` et `apps/backend/.vscode/mcp.json` | shadcn-frontend/backend, laravel-boost, nca-toolkit-docs, n8n-mcp. NCA est en SSE et rejeté par le natif. Des valeurs `${workspaceFolder}` et `${input:…}` demandent une traduction. |
| M13 | `~/projects/Foundry-AI/foundry-knowledge/.vscode/mcp.json` et `legacy/brain/.vscode/mcp.json` | exa, exa-advanced, cloudflare-docs, youtube_transcript, linear-mcp suivant le fichier. Plusieurs headers utilisent `${input:…}`. |
| M14 | `~/projects/Foundry-AI/foundry-os/.vscode/mcp.json`, `.gemini/settings.json`, et `foundry-website/.vscode/mcp.json` | laravel-boost ou shadcn-ui suivant le projet. |
| M15 | `~/projects/cryptoLoan/.vscode/mcp.json` et `.gemini/antigravity/mcp_config.json` | laravel-boost, enveloppes `servers` ou format Antigravity distinct. |
| M16 | `~/projects/dikoli-platform/.vscode/mcp.json`, `apps/backend-core/.vscode/mcp.json`, `.gemini/settings.json` | laravel-boost, figma, shadcn-ui suivant le fichier. Une copie Gemini existe aussi dans le worktree historique. |
| M17 | `~/projects/decoding-discontinuity/agentic-resilience-workbench-proto/.vscode/mcp.json` et `.factory/mcp.json` | hugeicons, convex-mcp, vision-mcp-server. Cwd et environnement vision contiennent des expressions VS Code. |
| M18 | `~/projects/quickcoin/.vscode/mcp.json` | laravel-boost, quickcoin-cpanel-ssh. |
| M19 | `~/projects/falla-cash-project/falla-cash/.vscode/mcp.json` | laravel-boost, shadcn-ui, hugeicons. Le fichier Pi contient aussi chrome-devtools. |
| M20 | `~/projects/shein-ecom/.vscode/mcp.json` | laravel-boost, shadcn-ui, project_mcps, linear-mcp, cloudflare-docs, cloudflare-api. Le fichier Pi contient chrome-devtools-mcp et ne reprend pas tous ces serveurs. |

`~/projects/q-messenger/mcp.redis.example.json` est un exemple, pas une configuration active prouvée. Les manifests `.mcp.json` dans `.codex/.tmp/plugins/` ou `.codex/plugins/cache/`, ainsi que les sauvegardes `.portable-path-backups/`, ont été distingués des configurations personnelles à migrer. Ils ne doivent pas être importés collectivement dans Pi.

### F5a — Conversions sémantiques vérifiées

MCP natif prend en charge `${VARIABLE}` et `$VARIABLE` dans les valeurs `headers` HTTP et `env` stdio, via le résolveur de configuration de Pi qui lit l’environnement du processus. Un header peut contenir `Bearer ${API_KEY}`. Une variable requise absente produit une erreur explicite. Le champ `env` d’un serveur HTTP n’est en revanche pas un dictionnaire local servant à résoudre ses headers. La migration doit conserver les références et vérifier leur disponibilité dans le vrai processus Pi, sans inscrire les valeurs des secrets dans la configuration.

| Champ ou comportement actuel | Traitement natif | Migration requise |
| --- | --- | --- |
| `directTools: true` | Ignoré, exposition par défaut `codemode` | `exposure: "direct"` si cette visibilité reste voulue. |
| `directTools: ["tool", …]` | Ignoré | `toolExposure` pour les tools explicitement directs, exposition générale choisie pour les autres. |
| `directTools: false` | Ignoré | Choisir `codemode`, `deferred` ou `hidden` selon le contrat attendu. L’ancien proxy adapter ne devient pas automatiquement identique à codemode. |
| `lifecycle: eager/keep-alive` | Ignoré | Le natif connecte tous les serveurs activés en arrière-plan. Pas de traduction équivalente de toute la gestion lazy/idle de l’adapter. Mesurer le coût du fanout enfants. |
| `auth: "bearer"` et `bearerToken` de Firecrawl | Rejeté par le validateur | Header `Authorization` natif, avec une provenance de secret réellement résolue. |
| `bearerTokenEnv` de Hostinger/Cloudflare | Accepté comme champ inconnu, ignoré à la connexion | Header `Authorization` alimenté par le canal approprié. Une validation de forme seule ne détecte pas cette perte. |
| `env` sur un serveur HTTP | Ignoré par le transport natif | Les références du header doivent être disponibles dans le processus ou le mécanisme de résolution choisi. `env` n’alimente que les serveurs stdio. |
| `${input:…}`, `${workspaceFolder}` | Pas de résolution VS Code native | Variables/chemins compatibles Pi, sans copier un secret dans un fichier partagé. |
| `imports: ["vscode"]` | Ignoré, aucun serveur chargé | Définitions natives explicites des serveurs choisis. |
| `type: "sse"` | Rejeté | Endpoint streamable HTTP confirmé chez le serveur, ou maintien de ce serveur dans son client actuel. |

Les références de clés d’Exa et Firecrawl doivent être vérifiées depuis le vrai lancement Pi. Elles sont absentes de l’environnement du processus Codex utilisé pour l’audit, ce qui ne prouve pas leur absence dans la session quotidienne. Aucune clé n’a été affichée ni utilisée. La confiance projet est désormais une condition de chargement des fichiers projet, à qualifier également pour les enfants.

Source du contrat : [documentation MCP de Pi 1.1.0](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/docs/mcp.md), vérifiée contre `src/extensions/mcp/config.ts`, `runtime.ts` et `src/core/mcp-servers.ts` du candidat.

## F6 — Réversibilité de l’ensemble

Le lanceur quotidien reste `~/.pi/bin/pi` sur la release `0.87.1-00c5e7e300ba-51024884e6e0`. Une promotion du core seule ne restaure pas les packages externes, leurs sources dans les settings, les configurations MCP ou les adaptations locales du harness. Il faut donc qualifier le retour de l’ensemble retenu.

Un défaut du promoteur reste déjà documenté : `synchronizeAgentPiPins()` ajoute les pins des packages de la release cible mais ne retire pas ceux absents de cette release. Le retour 1.1 → 0.87 conserve donc des packages natifs nouveaux, et l’aller conserve l’ancien paquet SQLite. Ce propriétaire existant doit être corrigé et testé avant promotion. Ne pas confondre une vérification de cohérence verte avec une restauration complète.

Les flags `--tui-mode fullscreen --fullscreen-layout document` utilisés par Herdr restent reconnus par le candidat. Les fabriques d’outils utilisées par pi-overrides et le garde UI du fork restent présents. Le patch local Unattended dépend cependant de la structure interne du runner. Ces constats de source ne remplacent pas les tests de sécurité et les vérifications visuelles des overlays et du footer.

## V1–V6 — Vérifications réellement exécutées

| Code | Vérification | Résultat et portée |
| --- | --- | --- |
| V1 | Registre npm officiel, roots installés, manifestes, historique des forks, neuf archives avec intégrité vérifiée | Versions et déclarations constatées. Aucune installation ni commande de mise à jour. |
| V2 | Scan des fichiers cachés/ignorés et parsing JSON/JSONC de 40 fichiers, validateur réel du candidat | 76 définitions examinées. Firecrawl ancien bearer et NCA SSE rejetés. Les champs ignorés sont recensés séparément. Hashes inchangés après lecture. Aucune connexion MCP. |
| V3 | Chargeur natif réel avec agentDir personnel en lecture seule et dix cwd, confiance activée puis désactivée | Zéro serveur global chargé actuellement. Seuls Falla Cash et Shein chargent leurs quatre entrées projet. Les autres sources listées ne sont pas découvertes. Sans confiance, aucun serveur projet chargé. |
| V4 | Test public du fork `pi-test-harness` 0.8.1-fork.2 dans un graphe temporaire lié aux packages 1.1.0 du candidat | 1 test passe, 7 assertions. Création d’une session, exécution réelle d’un tool enregistré, observation du hook `tool_call` et résultat collecté. LLM remplacé par playbook, aucune extension personnelle chargée. Ce test ne qualifie ni MCP ni tout le harness. |
| V5 | `pi --version`, `pi-fork status`, `pi-fork verify`, état Git du harness | Pi quotidien 0.87.1 et release de départ toujours vérifiée. Aucun diff de code/configuration produit par l’audit. Le présent rapport est un nouvel artefact documentaire. |
| V6 | Résolveur natif du candidat avec variables temporaires synthétiques | 2 tests passent, 5 assertions : résolution des headers HTTP et valeurs env stdio depuis le processus, erreur explicite pour une variable absente. Environnement restauré, aucun secret réel utilisé, aucune connexion réseau. |

Les preuves encore manquantes sont la combinaison complète des versions retenues, le lancement des serveurs MCP et l’authentification, les refus codemode et sandbox à travers les appels imbriqués, la readiness et l’héritage des sous-agents, les workflows et reprises via le nouveau RPC, les imports Jiti réels de chaque package, le typecheck intégré, les outils LSP et navigateur, les overlays TUI et le retour de tout l’ensemble. Aucun de ces points n’est déclaré validé par les contrôles ci-dessus. Le périmètre de N1 doit en tenir compte avant son exécution. La promotion reste une étape séparée avec l’utilisateur.
