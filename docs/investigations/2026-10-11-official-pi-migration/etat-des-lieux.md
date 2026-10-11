# Migration du setup Pi : état des lieux et décisions proposées

Date de vérification : 11 octobre 2026. Investigation demandée avec scout, factual-researcher, architect et oracle. Ce document propose une direction, sans acter une migration. Aucun runtime, package, fichier de configuration, définition personnelle d’agent ou session n’a été changé. Les seuls fichiers produits sont des rapports et sondes de diagnostic.

## Conclusion

La cible Pi officiel est viable, mais la condition « toutes les modifications du fork sont déjà reprises » n’est pas satisfaite. Le blocage générique des prompts interactifs utilisé par Unattended et le layout fullscreen document restent absents. Les autres adaptations du core peuvent être supprimées ou replacées dans leurs propriétaires locaux.

La priorité recommandée est de centraliser la délégation programmatique dans le propriétaire partagé existant, puis de qualifier un moteur derrière ce contrat. Pi 1.1.0, MCP natif et pi-subagents 0.77.0 constituent un candidat, pas une combinaison validée pour le quotidien. Le package récent améliore plusieurs comportements mais conserve le défaut de priorité des modèles et une course possible à la disponibilité MCP. Un moteur possédé fondé sur le SDK Pi reste une alternative sérieuse, avec un périmètre plus conséquent qu’une simple fonction de lancement.

## F1 — Versions et provenance

| Composant | Installation actuelle vérifiée | Dernière version publiée vérifiée |
| --- | --- | --- |
| Pi core | Fork 0.87.1, release `0.87.1-00c5e7e300ba-51024884e6e0` | Officiel 1.1.0, publié le 7 octobre 2026 |
| pi-subagents | npm 0.73.1 | npm 0.77.0 |
| pi-mcp-adapter | npm 3.0.0 | npm 5.2.0 |

Le runtime promu et le checkout `~/engineering/pi-core` correspondent au commit propre `00c5e7e300baf77ea05c78fabac625b213e7a578`. Le checkout est sur `codex/pi-core-v0.87.1`. Le delta de cinq commits après la base officielle touche 42 fichiers. Il ne faut pas confondre ce nombre de fichiers avec 42 fonctionnalités à porter.

La comparaison officielle utilise le tag 1.1.0 et son commit `abe508e1b89912adde45528136c3221eb69acdd7`, dont les sources ont été extraites sous `/tmp/pi-official-1.1.0-source`. Les versions ont été contrôlées dans le registre npm et les publications officielles, pas déduites des checkouts locaux. [Publication Pi 1.1.0](https://github.com/earendil-works/pi/releases/tag/v1.1.0), [registre pi-subagents](https://registry.npmjs.org/pi-subagents/latest), [registre pi-mcp-adapter](https://registry.npmjs.org/pi-mcp-adapter/latest).

## F2 — Ce qui reste du fork

| Référence | Modification | État dans l’officiel 1.1.0 | Action possible |
| --- | --- | --- | --- |
| K1 | `ui_prompt_before` bloquant et `UIPromptBlockedError` | Absents. `ui_prompt_start/end` observent les prompts sans fournir la même interception. | Remplacer ou accepter le retrait du comportement Unattended, ou conserver ce patch dans un fork minimal. |
| K2 | `--fullscreen-layout document`, défilement et ancrage associés | Absent. Le fullscreen officiel utilise son propre dock. | Accepter le layout officiel et adapter Herdr, ou conserver ce patch. |
| K3 | Provenance et intégrité des artefacts de release | Équivalent officiel, format différent. | Adapter le promoteur local au manifeste officiel plutôt que maintenir le patch core. |
| K4 | Alias Jiti pour des sous-chemins Pi AI | Non repris, mais les exports racine nécessaires existent. | Changer les imports des consommateurs identifiés vers l’API publique. |
| K5 | Effort de Claude Opus 5.5 sous GitHub Copilot | Repris. | Retirer le patch local. |
| K6 | Isolation de tests clipboard WSL et téléchargements Ollama sur opt-in | Pas intégralement reprise, concerne le développement. | Ne justifie pas de conserver un fork du runtime. |

K1 est une incompatibilité concrète : `agent/extensions/pi-dangerous-mode/ui-prompt-guard.ts:22` teste l’export du fork et l’activation le refuse s’il manque. K2 est également concret : `~/.oh-my-zsh/custom/pi-herdr.zsh:110` injecte actuellement un flag absent de l’officiel. Une interception privée des prototypes déplacerait le couplage dans les extensions au lieu de le supprimer, ce n’est pas la voie recommandée.

Le promoteur actuel attend `release-manifest.json`, `source.repository` et `sha256` dans `agent/bin/pi-fork-release.ts`. L’officiel produit `manifest.json` et des champs `integrity` SHA-512. La provenance et le rollback local restent utiles même avec un core officiel. Le tarball npm officiel conserve `dist/bun/cli.js`, ce qui permet de conserver Bun et un vrai package root sans porter simultanément le sandbox vers Node.

Sources : [runner officiel](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/extensions/runner.ts#L582-L614), [layout officiel](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L873-L878), [artefacts officiels](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/scripts/package-artifacts.mjs), [exports Pi AI](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/index.ts#L35-L45).

## F3 — Usages réels des sous-agents

Le scout a commencé par les outils de rappel de sessions. Ils permettent la recherche, mais pas l’agrégation complète des arguments. Il a ensuite analysé uniquement les enregistrements d’appels d’outils des 200 fichiers de sessions principales, répartis sur 22 projets. Les sessions enfants ont été exclues. Les identifiants d’appels recopiés dans les forks ont été dédupliqués. Les dates de création des sessions vont du 8 juin au 10 octobre 2026, certaines ayant continué ensuite.

| Mesure | Résultat |
| --- | --- |
| Appels `subagent` uniques | 709, contre 1 287 enregistrements bruts |
| Sessions comportant ces appels | 34 |
| Demandes de lancement uniques, tous projets | 246 |
| Lancements sous forme de workflow | 185 |
| Lancements explicitement asynchrones | 219 |
| Dans le projet `.pi` | 97 lancements, dont 71 `workflowScript`, 1 `workflow`, 25 agents nommés |
| Contrôles dans `.pi` | 121 status, 21 steer, 6 interrupt, 7 stop, 4 resume |

Ces chiffres comptent des demandes enregistrées. Ils ne prouvent ni leur succès ni un taux de panne imputable au package. Le scan ne prétend pas avoir lu chaque conversation en entier. Les résultats n’ont pas été rapprochés de tous les appels.

Les besoins observés comprennent sorties structurées, parallélisme, séquences, exécution détachée, suivi, steering, interruption, arrêt, reprise, visibilité contextuelle et contraintes d’outils. Seuls 7 des 97 lancements dans `.pi` fixent explicitement un modèle. Les choix dépendent donc largement des définitions et réglages résolus au lancement.

## F4 — Le package récent ne résout pas tout

La version 0.77.0 apporte des améliorations réelles documentées : surface du schéma `subagent` réduite, résultats longs dirigés vers des artefacts, gestion du cache de prompt, lancement par nom, workflow parallèle prédéfini, lancement sandbox en arrière-plan, corrections de confiance projet et de récupération asynchrone. Ce sont des améliorations du produit, pas une preuve de gain mesuré dans ce setup.

Une rupture touche directement le code local : depuis 0.74.0, `workflowScript` et `workflowScriptPath` sont remplacés par `workflow`. `brainstorm-forcer/verification-runner.ts` émet encore l’ancien champ. Une mise à jour du package demande donc une adaptation des consommateurs ou de l’adaptateur commun. C’est un exemple concret de changement de package que la nouvelle frontière doit absorber une seule fois. [Changelog de la version étudiée](https://github.com/nicobailon/pi-subagents/blob/1ac9b964eb9cda1662507c52f5277764637daccc/CHANGELOG.md).

Le défaut des agents builtin demeure dans le résolveur : lorsqu’un override projet existe, il remplace le choix d’override global au lieu de fusionner les champs. Un projet qui ne change que `tools` peut donc perdre le modèle et le thinking définis globalement. Les agents personnalisés suivent un autre chemin qui fusionne les scopes. Ce mécanisme a été reproduit sur l’installation actuelle et retrouvé statiquement dans la version récente.

Source : [résolveur builtin et custom au commit 0.77.0](https://github.com/nicobailon/pi-subagents/blob/1ac9b964eb9cda1662507c52f5277764637daccc/src/agents/agents.ts#L1570-L1657).

Le preflight public retourne un contrat résolu. Ce n’est pas un hook global capable de modifier chaque lancement. Ajouter le bon modèle aux appels programmatiques locaux ne corrige pas les appels directs du modèle, les scripts et leurs reprises. Une correction durable doit couvrir le résolveur commun de tous ces chemins. Copier les modèles globaux dans les réglages projet créerait une deuxième source de vérité.

Pour MCP, la version récente propose deux chemins : avec pi-mcp-adapter, elle continue d’imposer elle-même un cache de sept jours. L’adapter récent a retiré sa propre expiration par défaut, mais cela ne retire pas la limite indépendante des sous-agents. Avec MCP natif, elle lit le registre du parent et évite ce cache. Cependant, cette lecture est synchrone et peut précéder l’enregistrement des outils d’un serveur encore en connexion. L’attente dans l’enfant intervient après la planification, elle ne corrige pas cette course initiale.

Sources : [résolution MCP](https://github.com/nicobailon/pi-subagents/blob/1ac9b964eb9cda1662507c52f5277764637daccc/src/runs/shared/mcp-direct-tool-allowlist.ts#L114-L155), [wrapper MCP enfant](https://github.com/nicobailon/pi-subagents/blob/1ac9b964eb9cda1662507c52f5277764637daccc/src/runs/shared/child-session.ts#L267-L307), [attente après planification](https://github.com/nicobailon/pi-subagents/blob/1ac9b964eb9cda1662507c52f5277764637daccc/src/runs/shared/child-session.ts#L565-L581).

La dernière version constitue donc un candidat à tester derrière la frontière possédée. Elle n’est pas recommandée comme simple mise à jour immédiate censée régler les incidents.

## O — Alternatives examinées

Versions publiées vérifiées dans le registre le 11 octobre. Aucune n’a été installée ni exécutée dans ce setup.

| Option | Apport | Écart décisif |
| --- | --- | --- |
| O1 — pi-subagents 0.77.0 derrière le contrat possédé | Préserve le plus de capacités actuelles, réduit le travail de remplacement immédiat. | Exige correction commune des modèles, readiness MCP, conversion `workflow` et qualification des connexions enfants. Candidat transitoire, pas mise à jour quotidienne recommandée sans ces preuves. |
| O2 — `@tintinweb/pi-subagents` 0.20.0 | Alternative tierce la plus proche : RPC entre extensions, async, workflows, résultats structurés, journal et replay. | Son RPC couvre ping/spawn/stop/consume, sans équivalents complets de status/steer/interrupt/resume. La documentation exclut le contrôle stop des workflows par ce RPC. La compatibilité native MCP précise reste à qualifier. |
| O3 — `pi-simple-agents` 1.2.1 | Jobs async simples, status/cancel, configuration par appel, MCP natif explicitement supporté. | Registre en mémoire et absence de contrat complet de steering/reprise durable/sortie structurée dans l’interface inspectée. Convient si les besoins sont volontairement réduits. |
| O4 — `@mjakl/pi-subagent` 3.1.0 | Processus séparés, single/parallel et sessions nommées réutilisables. | Outil synchrone, pas l’orchestration détachée avec contrôles utilisés ici. Continuer une session terminée n’équivaut pas à piloter et récupérer un run actif. |
| O5 — Moteur possédé sur SDK Pi officiel | Maîtrise de la résolution, du profil d’extensions et des contrats. Évite de reproduire le produit complet d’un package tiers. | Il faut réellement implémenter et tester supervision, arrêt des descendants, corrélation, reprise, sorties structurées et permissions. Aucun gain de vitesse n’est démontré à ce stade. |

O2 mérite un prototype si un package externe reste préféré. O3 et O4 ne répondent pas au périmètre observé sans retirer des capacités. O5 est la meilleure piste de remplacement contrôlé si O1 échoue aux contrats ou continue de coûter trop de maintenance. Il faut comparer O1 et un prototype borné O5 derrière la même frontière avant de consacrer une réécriture complète. L’exemple subagent officiel peut aider à comprendre le SDK, mais ne fournit pas la gestion asynchrone durable utilisée ici.

Pour O5, un bootstrap SDK dans un enfant Bun peut sélectionner explicitement les extensions, providers et serveurs requis. Le `RpcClient` officiel 1.1.0 démarre Node explicitement, il ne suffit pas que son parent tourne sous Bun pour obtenir un enfant Bun. Le choix du transport doit préserver cette contrainte et l’isolation entre enfants. Un dépôt autonome sous `~/engineering/pi-integrations/` convient si un véritable nouveau moteur devient nécessaire; la centralisation des consommateurs existants ne nécessite pas ce nouveau dépôt.

Sources : [Tintin au commit étudié](https://github.com/tintinweb/pi-subagents/tree/13106ab6f608b3acc54185da5299ee7fbaabb6b9), [son RPC](https://github.com/tintinweb/pi-subagents/blob/13106ab6f608b3acc54185da5299ee7fbaabb6b9/docs/rpc.md), [pi-simple-agents](https://github.com/piousp/llm-skills/tree/e9a4a72ecfcd3608cc8e3af7e70f2bf2be0da482/pi-simple-agents), [mjakl](https://github.com/mjakl/pi-subagent/tree/6d05481a475c08bfd1ee5a623d5b742fb95b2147), [SDK officiel](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/docs/sdk.md).

## F5 — MCP natif et codemode

Les six serveurs configurés sont Context7, DeepWiki, Exa, Firecrawl, vision-mcp-server et youtube-transcript. Cinq utilisent HTTP et un stdio. Le MCP natif couvre ces transports, la recherche d’outils, plusieurs modes d’exposition et OAuth. Il ne remplace pas toutes les fonctionnalités avancées de l’adapter, notamment les transports hérités, MCP Apps, prompts, sampling et elicitation. Leur nécessité doit être établie par l’usage avant retrait du package, sans supposer qu’une option non configurée n’est jamais utilisée.

Le MCP natif constitue une cible cohérente pour réduire le nombre de propriétaires de la connexion, du registre et des appels. L’installation d’un adapter qui possède `/mcp` remplace le MCP intégré en session. On ne doit pas garder deux piles en croyant qu’elles s’additionnent. Certains adapters récents peuvent aussi ajouter une exclusion persistante `-builtin:mcp`, à vérifier lors du retrait. Aucune exclusion de ce nom n’a été trouvée dans les deux settings actuels inspectés.

La conversion ne peut pas être un renommage de fichier. Dans un audit en lecture seule des six entrées réelles, le validateur natif accepte structurellement cinq entrées mais n’interprète pas `directTools` et `lifecycle`. Firecrawl est rejeté à cause de l’ancien format `auth: "bearer"`. Il faut convertir l’en-tête et préserver la résolution des références d’environnement sans exposer les secrets. Les nouveaux noms sont du type `mcp__serveur__outil`. Le propriétaire `_shared/mcp/ref-resolver.ts` peut préserver les références déclaratives existantes en traduisant vers le registre réel, sans réécrire tous les prompts.

Le MCP natif démarre tous les serveurs activés en arrière-plan. Le wrapper enfant de pi-subagents récent limite les outils enregistrés, mais ne réduit pas la liste de configurations de serveurs démarrés. Un fan-out peut donc multiplier les connexions et processus. Cette conséquence est établie par le chemin de code, son coût n’a pas été mesuré.

Codemode fournit l’orchestration JavaScript et la réduction de résultats. Il ne garantit pas un workflow durable détaché après arrêt du parent, et ne remplace pas automatiquement Think-in-Code, ses analyses Python, ses archives, sa rétention et son isolation externe.

Il faut distinguer autorisation et présentation : les outils `codemode` et `deferred` sont appelables sans figurer dans `setActiveTools()`. L’actuel garde de `tool-groups/index.ts:236` vérifie la liste calculée. Il doit évoluer pour représenter les capacités autorisées indépendamment des schémas affichés. Les appels imbriqués natifs passent bien par `tool_call` et `tool_result` avec `parentToolCallId`. Il faut conserver ces contrôles, pas les retirer pour faire fonctionner codemode. Le SDK ne charge pas automatiquement les extensions builtin MCP/codemode/tool-search : un bootstrap enfant doit les sélectionner explicitement.

Sources : [MCP natif 1.1.0](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/docs/mcp.md), [codemode](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/docs/codemode.md), [pipeline imbriqué](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/agent-session.ts#L727-L763), [outils appelables](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/agent-session.ts#L1530-L1567).

## D1 — Une seule frontière de délégation

Faire évoluer `agent/extensions/_shared/subagents/`. Ce propriétaire existe déjà et doit devenir le seul endroit qui connaît le package choisi. Il doit cacher les événements, versions RPC, formes de status/result, chemins d’artefacts du moteur, IDs externes et différences foreground/async. Les types publics doivent appartenir au setup.

| Consommateur actuel | Couplage à retirer du consommateur |
| --- | --- |
| Brainstorm recherche et vérification | Payloads de lancement, IDs async, génération de scripts propres au moteur, parsing de résultats |
| SDD | Import direct `pi-subagents/delegation` et types du package |
| Overview | Deuxième implémentation RPC et lecture des artefacts du moteur |
| Wait guard | Interprétation propre des snapshots du package |
| Addon et Brainstorm | Détails d’adaptation des ceilings, de la découverte et du preflight |

La configuration actuelle désactive l’overview et le wait guard. Leur duplication reste une dette de maintenance, mais leur reconstruction ne doit pas devenir une condition artificielle pour le premier candidat. `toolGroupOverrides` et `fallbackAdvice` sont activés. Le périmètre prioritaire couvre les consommateurs actifs et les contrôles effectivement utilisés dans les sessions, sans recopier toute la surface du package.

Un contrat indicatif couvre `start`, `inspect/wait`, `control`, `resume` et `subscribe`. La résolution des modèles, thinking, outils, contraintes et provenance du lancement est déterministe et commune à tous les points d’entrée. Les erreurs distinguent configuration, capacité indisponible, fournisseur, sortie invalide, interruption et échec de tâche. Un timeout de requête ne doit pas être confondu avec un arrêt effectif de l’enfant.

Les sources restent les définitions personnelles, les settings et les propriétaires existants de groupes, permissions et chemins. Cette centralisation est celle des règles et de l’exécution, pas une duplication des réglages dans un nouveau fichier. Les contraintes du propriétaire de session viennent du runtime fiable, pas d’un champ que le modèle pourrait choisir.

Conserver les machines d’état métier dans Brainstorm et SDD. Ne pas créer de registre générique de backends, de daemon ou de pool sans besoin mesuré. Un seul adaptateur sélectionné à la fois suffit. Le moteur reste l’autorité sur l’état d’exécution, la frontière conserve seulement la corrélation nécessaire. Les règles de lint peuvent ensuite interdire les imports/protocoles du package hors de cette frontière.

Ne pas faire de `workflowScript` le contrat public durable : ce serait garder le langage du package comme dépendance de tous les appelants. Le conserver temporairement dans l’adaptateur actuel tant que séquences, fan-out et récupération n’ont pas une alternative qualifiée.

## D2 — Politique de fallback

La décision existante dans `docs/adr/ADR-027-official-pi-subagents-parent-fallback-advice.md` est un conseil ponctuel au parent après un échec fournisseur avant travail utile, sans relance automatique. Un futur moteur doit pouvoir fournir une erreur structurée et éviter de déduire la cause d’un transcript. Transformer ce conseil en retry déterministe automatique serait une décision distincte. Les virtual models officiels offrent un mécanisme de routage sur échec, mais leur présence n’autorise pas à changer silencieusement les modèles fixes ou la politique de retry.

## D3 — Ce qui peut disparaître et ce qui reste

À retirer après migration de leurs consommateurs : le client RPC dupliqué, les imports et types du moteur disséminés, le parsing de status/IDs répété et les détails d’artefacts dans l’UI. Si MCP natif est qualifié, retirer l’adapter et sa dépendance dans le résolveur partagé. Si un moteur possédé remplace pi-subagents, le générateur d’overrides de tools et les définitions globales temporaires pourront disparaître après validation de leurs remplaçants.

À conserver : prompts et définitions libres, harness-sync, fournisseurs, source actuelle des modèles, sandbox, permissions, safe_bash, groupes d’outils, logique métier Brainstorm/SDD, intégrité et rollback du runtime. Ne pas supprimer Think-in-Code au seul motif que codemode utilise aussi JavaScript.

## A — Séquence proposée et réversibilité

1. **A1 — Contrats et baseline.** Figer les comportements requis avec des fixtures temporaires et modules de production importés. Ne pas figer les textes, listes d’agents ou modèles personnels dans les assertions. Mesurer le lancement et les ressources du setup de référence.
2. **A2 — Centralisation sur le moteur actuel.** Faire converger les consommateurs vers la frontière commune, un par un, sans changer simultanément core et package. Couvrir aussi les points d’entrée LLM, les scripts et les reprises avant de déclarer la résolution centrale complète.
3. **A3 — Candidat core isolé.** Préparer l’officiel épinglé sous Bun avec des configurations et copies de sessions séparées. Régler explicitement K1/K2, imports publics et format de promotion. Les packages Pi doivent rester cohérents avec le runtime choisi.
4. **A4 — Candidat MCP puis moteur.** Convertir les six serveurs sur copie, qualifier auth/connexion/exposition/permissions et readiness. Tester le package récent derrière le contrat possédé. Exiger une vraie correction de priorité des modèles. Comparer un prototype SDK possédé si le package ne satisfait pas les contrats et le coût de maintenance acceptable.
5. **A5 — Validation comparée.** Tester sortie structurée, cancel/interrupt/stop/reprise, crash parent/enfant, événements dupliqués, résultats tardifs, restrictions directes et codemode, refus fournisseur et fallback, chemins d’artefacts et sessions. Mesurer les mêmes scénarios cold/warm et fan-out avec mêmes serveurs et modèles.
6. **A6 — Promotion unique et retour contrôlé.** Sauvegarder les contenus réels, y compris ignorés et non suivis, avec inventaire et hashes avant transformation. Conserver runtime, versions exactes des packages et configuration précédents. Le rollback ne doit écraser que les fichiers toujours identiques à ceux produits par la migration, préserver toute modification postérieure, et signaler les conflits. Exercer le retour sur les copies avant la bascule quotidienne.

Les mesures de performance à comparer sont le temps jusqu’au premier appel fournisseur, latence de préparation, temps cold/warm, RSS agrégée parent/enfants, processus MCP/LSP, connexions, taille des schémas/prompt et coût de récupération. Aucun pourcentage de gain ne peut être promis ici. Un runner plus petit ne prouve pas une exécution plus rapide.

## Vérifications et limites

Vérifié : état Git courant, provenance du runtime promu, delta du fork, sources officielles à SHA identifié, versions du registre, consommateurs ciblés, agrégat des 200 sessions principales, mécanismes de résolution MCP/modèles. Quatre tests isolés importent le validateur MCP réel de Pi 1.1.0 : **4 pass, 0 fail, 8 assertions**. Ils couvrent `directTools` historique, ancien bearer, configuration native et noms normalisés. L’audit des six entrées réelles n’a affiché aucune valeur de secret.

Non exécuté : installation, build ou lancement complet de Pi 1.1.0, intégration réseau des six serveurs, authentification live, suite globale d’extensions, benchmark comparatif, migration ou rollback réel. Le format global des sessions CLI reste version 3 des deux côtés, mais cela ne démontre pas la réversibilité de toutes les nouvelles entrées. Les reprises doivent être éprouvées sur copies.

Les ruptures `shouldStopAfterTurn → finishTurn` et de contexte canonique datent de 0.87.0 et existent déjà dans le runtime actuel. Les changements ultérieurs d’API stream/TUI/harness expérimental n’ont pas montré de consommateur de production concerné dans le scan ciblé. Ce scan ne constitue pas une preuve de compatibilité globale des packages externes.

## Pièces de l’enquête

- [Inventaire scout : sessions, déduplication et consommateurs](scout.md).
- [Recherche : versions, sources exactes et alternatives](recherche.md).
- [Avis oracle : frontière, contrats et périmètre](oracle.md). Les estimations de durée qu’il contient sont indicatives, pas un planning établi.
- La matrice K1–K6 et les limites de compatibilité ci-dessus reprennent le rapport final architect.
- [Sonde MCP isolée](native-mcp-probe.test.ts). Elle importe le snapshot officiel au chemin temporaire mentionné plus haut. Commande exécutée depuis `~/.pi/agent` : `bun test --isolate /tmp/pi-native-mcp-migration-probe.test.ts`. Le snapshot doit être présent pour reproduire ce test.
