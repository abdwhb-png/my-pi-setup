# Avis d’architecture : délégation Pi et indépendance du moteur

Date : 2026-10-11. Analyse en lecture seule. Aucun changement de code, configuration, dépendance, runtime promu ou session. Les conclusions concernant les versions récentes s’appuient sur les sources vérifiées par le chercheur et les fichiers officiels 1.1.0 extraits dans /tmp/pi-official-1.1.0-source.

## Recommandation

Créer une seule frontière de délégation que tu contrôles avant de remplacer le moteur. Faire évoluer `agent/extensions/_shared/subagents/` plutôt qu’ajouter un framework de fournisseurs : les workflows restent propriétaires de leur logique, un seul adaptateur traduit leur contrat vers le moteur de sous-agents choisi. Cette séparation réduit immédiatement le coût d’un changement de package, sans prétendre rendre interchangeables des capacités qui ne le sont pas.

La combinaison officielle Pi 1.1.0 + pi-subagents 0.77.0 + MCP natif est un candidat de qualification intéressant : elle évite la dépendance au cache MCP historique. Elle n’est pas prête à remplacer sans condition le setup actuel : le défaut de priorité des modèles des agents builtin subsiste, la disponibilité MCP native peut encore subir une course au démarrage, et le fork Pi conserve des fonctionnalités absentes de l’officiel. Ne pas basculer simplement sur les numéros de version.

## Faits locaux déterminants

| Référence | Constat | Conséquence |
| --- | --- | --- |
| F1 | `_shared/subagents/rpc-client.ts:152` transporte les méthodes RPC du package avec des `Record<string, unknown>`, et expose les événements du package. | C’est déjà le bon point de départ, mais pas encore une frontière indépendante du package. |
| F2 | `pi-subagents-addons/pi-subagents-overview/rpc-client.ts:1` réimplémente le même protocole RPC. `live-runtime.ts:1` importe aussi les événements foreground du package. L’overview et le wait guard sont actuellement désactivés dans la configuration. | Il existe deux chemins de maintenance pour le même protocole, mais reconstruire cette UI désactivée ne doit pas bloquer un candidat minimal. Si conservée, elle doit consommer le client partagé et un état normalisé. |
| F3 | `sdd-orchestrator/delegation-client.ts:1` utilise l’autre API publique du package, et `delegation-contract.ts:10` aliasse directement ses types. | Centraliser le client RPC seul laisserait SDD couplé au package. Le transport foreground et le transport async doivent être cachés derrière la même frontière locale. |
| F4 | `brainstorm-forcer/research-runner.ts:152` lance un agent async avec schéma de sortie. `verification-runner.ts:428` génère un workflowScript pour plusieurs feuilles et traite les résultats/IDs spécifiques au package. | Les exigences incluent sorties structurées, coordination parallèle, annulation, corrélation des résultats et restauration. |
| F5 | `brainstorm-forcer/index.ts:499` enregistre une capability ceiling du package, puis appelle le preflight public à la ligne 543. L’addon de tool groups installe aussi une ceiling de refus pendant la synchronisation. | L’autorisation doit couvrir les appels programmatiques autant que les outils LLM. Déplacer uniquement les appels ne suffit pas. |
| F6 | `_shared/subagents/workflow-agents.ts:90` écrit temporairement des fichiers dans le répertoire global d’agents. Le refcount à la ligne 124 est local à l’objet créé. | Ce mécanisme doit rester un détail de compatibilité du moteur actuel. Une future implémentation peut recevoir les définitions en mémoire, mais cela doit préserver overrides, visibilité et isolation entre sessions. Aucun incident multi-session n’a été reproduit ici. |
| F7 | Les sessions analysées par scout montrent une forte utilisation des workflows et des contrôles : 709 appels subagent dédupliqués dans 34 sessions sur 200 sessions principales/22 projets; dans .pi, 97 lancements dont 71 workflowScript, 1 workflow et 25 agents nommés. | Un remplacement réduit à spawn + texte final ne couvre pas le workflow réel. Le détail et les limites de déduplication restent dans le rapport scout. |

## D1 — Frontière proposée

Interface indicative à concevoir et qualifier, et non API déjà disponible :

- `start(request) -> RunRef` : accepte agent, tâche, contexte fresh/fork, propriétaire/session, cwd et contraintes supplémentaires; résout et valide les capacités/modèle avant démarrage, renvoie une identité corrélable.
- `inspect(ref) -> RunSnapshot` et `wait(ref, {signal}) -> RunResult` : statut, résultat typé texte/structuré, usages et références d’artefacts. Un timeout du client ne doit pas inventer un échec terminal du child.
- `control(ref, command)` : steering, interruption et arrêt avec sémantiques distinctes, seulement pour les runs autorisés du propriétaire.
- `resume(ref, task) -> RunRef` : renvoie l’identité de la nouvelle tentative, conserve la filiation et n’efface pas la précédente.
- `subscribe(owner, listener)` : événements normalisés pour interface et livraison de completion, avec corrélation/duplication traitées une seule fois.

Les types exposés appartiennent au setup, pas à pi-subagents. La frontière cache les noms d’événements, import paths, version du protocole, statuts externes, asyncId, lecture éventuelle des artefacts et transport foreground/async. Les paramètres d’autorisation proviennent d’un contexte fiable du runtime, pas d’un champ owner que le LLM peut librement choisir.

La résolution de groupes, configuration, permissions et chemins doit appeler les propriétaires existants. Ne pas créer un second registre de modèles, de groupes ou de runs. L’état du moteur reste l’autorité d’exécution; la frontière ne conserve que corrélation et références nécessaires. L’état métier SDD/Brainstorm reste chez SDD/Brainstorm. Une seule implémentation sélectionnée à la fois suffit, sans registre de plugins ni découverte de fournisseurs.

## D2 — Source de vérité et modèle effectif

Conserver pour commencer les définitions utilisateur et `agent/settings.json` comme sources autoritatives, avec une règle explicite de priorité par champ et un reçu de lancement indiquant modèle/thinking/outils réellement utilisés et leur origine. Les overrides explicites autorisés doivent rester distinguables des defaults ou d’un fallback. Ne pas migrer toutes les configurations simplement pour renommer une clé.

Attention : `resolveSubagentLaunchContract` est un preflight qui retourne un diagnostic/contrat calculé. Ce n’est pas un hook qui modifie tous les lancements. Ajouter un modèle explicite aux seuls appels de SDD ou Brainstorm ne corrige pas les appels LLM directs, les étapes workflowScript ou leurs reprises.

Le défaut builtin doit être corrigé dans le résolveur commun du package (merge global puis projet comme pour les agents custom), ou éliminé par un moteur dont tous les points d’entrée passent par ton résolveur. Omettre les overrides projet strictement redondants réduit le problème actuel, mais ne résout pas le cas légitime où un projet change seulement les outils. Copier le modèle global dans les overrides projet recréerait deux vérités et doit être évité.

Le fallback actuel est volontairement un conseil ponctuel au parent après erreur fournisseur avant travail utile, pas un retry automatique. Préserver cette décision tant que tu ne demandes pas de la changer. Un moteur contrôlé peut retourner une cause d’échec structurée, ce qui permettrait de supprimer la lecture fragile de transcripts tout en conservant le conseil. Si tu souhaites ensuite remplacer le conseil par une règle automatique, Pi 1.1.0 possède des virtual models avec routage sur échec; ce serait une décision de politique distincte, à qualifier sans créer un autre service de routage ni modifier silencieusement les modèles fixes des agents.

## D3 — Package récent ou moteur à toi

| Option | Intérêt | Limite qui décide |
| --- | --- | --- |
| Package officiel récent derrière ta frontière | Conserve la majorité des workflows, artefacts, contrôles, reprise et UI existants. La branche MCP native utilise les outils du runtime parent plutôt que le cache disque de sept jours. | Le défaut builtin n’est pas corrigé en 0.77.0. Il faut une correction qualifiée dans le point commun, pas une série de contournements locaux. |
| Petit moteur possédé, sur SDK Pi officiel dans un child Bun | Maîtrise de la résolution, du chargement d’extensions et des contrats. Réduit le périmètre à tes usages réels et supprime des mécanismes de compatibilité au package. | Le lancement peut être court, mais cycle de vie détaché, reprise, contrats structurés, permissions et concurrence constituent un vrai développement. Aucun gain de performance n’est encore mesuré. |
| Remplacer par un autre package | Potentiellement moins de maintenance de moteur. | Aucun remplacement ne doit être appelé compatible avant confrontation avec les contrats observés; une simple fonction subagent ne suffit pas. Voir comparaison sourcée du chercheur. |

Le SDK officiel est une base crédible : `CreateAgentSessionOptions` expose model, thinkingLevel, tools, excludeTools, resourceLoader, sessionManager et settingsManager; `DefaultResourceLoaderOptions` permet noExtensions et des extensions sélectionnées. Il ne fournit pas à lui seul le coordinateur durable équivalent aux usages existants.

Réduire le périmètre au workflow constaté : children Pi natifs, contrôles réellement utilisés et contrats actifs Brainstorm/SDD. Rien dans cette analyse ne justifie de reconstruire tous les runners CLI externes, intégrations de jobs ou écrans Fleet du package. L’overview et le wait guard locaux sont désactivés; toolGroupOverrides et fallbackAdvice sont activés.

L’alternative subprocess officielle `RpcClient` mérite une limite explicite : son `start()` appelle `spawn("node", ...)` dans la version 1.1.0, même si le parent est Bun. Pour respecter un child Bun, le chemin naturel est un bootstrap SDK sous Bun avec supervision maîtrisée, plutôt que modifier le code installé ou prétendre que le client RPC officiel sélectionne Bun.

Ne pas charger toute la configuration/collection d’extensions du parent pour chaque feuille. Construire un profil de child minimal contenant les providers/auth nécessaires, outils sélectionnés, permissions/sandbox requis, groupes et MCP explicitement autorisés. Ne pas créer de pool de workers ou de daemon avant d’avoir mesuré le coût réel.

## D4 — Codemode et sécurité

Le codemode natif peut composer des appels d’outils; il ne doit pas être confondu avec la garantie actuelle d’un workflow détaché qui continue et se récupère après arrêt du parent. Maintenir le workflowScript historique derrière l’adaptateur transitoire jusqu’à qualification d’un remplacement, sans en faire le type public durable.

Le parent a vérifié dans Pi 1.1.0 que les appels imbriqués passent par tool_call/tool_result, mais que les outils codemode/deferred restent appelables indépendamment de setActiveTools. La politique locale doit donc distinguer outils autorisés et schémas visibles, puis garder un contrôle par appel réel. Ne pas résoudre une incompatibilité en supprimant les gates.

MCP natif démarre les serveurs enabled en arrière-plan. Selon les sources vérifiées par le chercheur, le package 0.77.0 consulte immédiatement le snapshot des outils sans attendre les serveurs codemode/deferred, tandis que Pi 1.1.0 n’attend au premier prompt que les serveurs d’exposition directe; la disparition du cache expiré n’est donc pas une garantie de readiness. Son wrapper child restreint les outils exposés sans réduire les serveurs enabled dans mcp.json : la migration du lazy/eager actuel peut multiplier connexions et processus dans les children. Le coût et la readiness doivent être mesurés avec les serveurs réellement nécessaires à chaque rôle.

Le parent a validé les six configurations existantes contre le validateur natif avec des lectures et fixtures : cinq sont acceptées structurellement, mais directTools/lifecycle sont ignorés; Firecrawl requiert une conversion de son auth bearer et la vérification de ses références d’environnement. Une copie brute du fichier de l’adapter ne préserve donc pas le comportement. Ces validations ne prouvent pas encore connexion réseau, authentification réelle ou autorisation des children.

## A — Séquence réversible proposée

1. A1 : figer les contrats observés par des fixtures temporaires et des checks de production importée; conserver les prompts/modèles personnels libres et ne pas les transformer en assertions de test.
2. A2 : centraliser les deux transports et normalisations derrière `_shared/subagents/`, migrer un consommateur à la fois, et garder le package actuel comme exécution de référence.
3. A3 : qualifier Pi officiel dans une installation isolée, puis MCP natif et le package récent séparément. Ne pas combiner le changement core, MCP, moteur de délégation et configuration dans une seule bascule.
4. A4 : exiger la correction de résolution modèle commune à tous les points d’entrée avant adoption du package récent. Si cette dépendance reste incompatible avec ton exigence de contrôle, prototyper le runner SDK possédé derrière la même frontière.
5. A5 : comparer la même matrice de contrats et de performance entre référence et candidat; ne remplacer ni état vivant ni sessions en cours.
6. A6 : promouvoir seulement la combinaison qualifiée, conserver l’ancien runtime/package/config exacts et un journal de transformations avec rollback conditionnel qui protège les modifications postérieures. Ne pas reprendre un ancien run avec un autre moteur simplement parce que son identifiant existe : terminer les runs actifs avant bascule, ou conserver leur propriétaire/version pour les inspecter avec le bon adaptateur.

## Qualification nécessaire

- Résolution : builtin/custom, overrides globaux/projet par champ, thinking false, modèle indisponible, appel direct/workflow/programmatique/reprise. Le modèle effectif doit être prouvé au démarrage du child, pas seulement dans le listing parent.
- Autorité : outils interdits depuis appel normal et codemode, groupes, MCP HTTP et stdio, serveur non prêt, credentials existants sans fuite, rôle et workflow actifs, child ne récupérant pas toute l’autorité parent.
- Vie du run : completion avant reçu, événements dupliqués, timeout, crash parent/child, stop avec contrôle des descendants, interruption/reprise et identité de tentative, résultat malformé, attente sans boucle LLM.
- Sorties : conservation sessions/artefacts dans les chemins possédés, résultats structurés invalides visibles, coûts/token unknown distincts de zéro, preuves de fallback avant travail utile.
- Performance : lancement cold/warm, délai jusqu’au premier appel fournisseur, nombre de processus, RSS agrégé, nombre de MCP/LSP démarrés, tokens du prompt et des outils, fanout usuel et récupération. Comparer mêmes inputs/modèles/serveurs; pas d’affirmation de gain à partir de la taille du fichier runner.

## À retirer et à conserver

Retirer quand les appelants ont migré : RPC dupliqué de l’overview, importations et types du package disséminés dans les consommateurs, parsing répété de ses statuts/IDs, lecture de ses artefacts dans l’UI. Si un moteur possédé prend le relais : générateur de tool overrides dans settings, fichiers temporaires d’agents globaux et classification d’erreur par transcript peuvent disparaître seulement lorsque leurs contrats ont un remplaçant validé.

Conserver : prompts personnels et harness-sync, sources modèles existantes, logique métier SDD/Brainstorm, utilitaires de groupes/config/chemins, gates de permissions/sandbox, visibilité contextuelle, intégrité/rollback du runtime. Les choix de fork Pi non couverts par upstream restent des décisions séparées.

## Effort et limites

Centralisation programmatique et tests de contrats : Medium (1–2 jours) comme ordre de grandeur, hors migration Pi/MCP. Remplacement complet correspondant aux usages : Large (3 jours et plus), avec qualification de récupération et sécurité; il serait trompeur de présenter cela comme une extension de quelques dizaines de lignes.

Cette analyse inspecte les sources et reçoit les agrégats de scout, les vérifications du chercheur et de l’architecte. Elle ne contient ni benchmark exécuté, ni sessions réseau lancées, ni validation live de la combinaison candidate. Les résultats de qualification doivent décider de la bascule.

