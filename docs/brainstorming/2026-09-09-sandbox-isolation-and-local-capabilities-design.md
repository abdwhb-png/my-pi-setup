# Isolation par défaut et capacités locales de développement

Date : 2026-09-09

Statut : direction validée par l’utilisateur. Document de brainstorming prêt pour la planification. Les contrats techniques ci-dessous cadrent le plan, sans constituer une implémentation validée.

## Destination

Fournissez un environnement Pi isolé par défaut sur toute machine, avec des ouvertures locales explicites, ajustables par projet et session, utilisables sans diagnostic de sandbox par le modèle.

La demande initiale concernait les difficultés de `safe_bash`, Dev Services et SFW dans deux sessions, puis le besoin d’utiliser les outils habituels du poste, notamment Zed. La clarification déterminante est que ces attentes dépendent de la machine : privilégiez toujours l’isolation lors d’une nouvelle installation.

## Recherche et preuves

Les observations suivantes proviennent du code et de sondes réalisés pendant le diagnostic. Consultez le [rapport d’audit](../audits/2026-09-09-safe-bash-dev-services-sfw.md) pour les traces, les versions et les limites des mesures.

| Source consultée | Observation établie | Conséquence pour le design |
| --- | --- | --- |
| [Résolution Bash](../../agent/extensions/bash-execution/builtin-bash.ts), `resolveBashOperations` | L’exécution locale est sélectionnée lorsque le sandbox est explicitement désactivé. | Réutilisez la frontière d’exécution existante. N’ajoutez pas un repli hôte après échec. |
| [Contrat Bash](../../agent/extensions/bash-execution/README.md) | `bash`, `safe_bash` et `user_bash` partagent un propriétaire. Les états non initialisé et erreur bloquent l’exécution. | Centralisez les décisions pour ces trois surfaces. |
| [Politiques](../../agent/extensions/sandbox/runtime/policies.ts), `createShellPolicy` | `bash-general` partage le `/tmp` hôte mais conserve d’autres restrictions. `/mnt/c` figure parmi les chemins interdits fixes. | Un profil existant de développement ne garantit pas la compatibilité avec les outils du poste. |
| [Chargement des réglages](../../agent/extensions/sandbox/index.ts), `loadSandboxConfig` | Les réglages ordinaires sont fusionnés depuis les valeurs par défaut, globales et de projet. Docker possède une autorité distincte. | Une fusion de configuration n’équivaut pas à un plafond d’autorisation imposé au projet. |
| [Description de Safe Bash](../../agent/extensions/bash-execution/safe-bash/description.ts) | La description expose principalement les règles du garde de commandes. | Complétez le contrat visible avec les capacités et le lieu effectif d’exécution. |
| [Sondes SFW](../audits/sfw-runtime-probe.test.ts) | Le wrapper installé rencontre une écriture de cache interdite. Le binaire rencontre aussi une incompatibilité réseau distincte, y compris vers GitHub autorisé. Le téléchargement hôte contrôlé réussit. | Ni la préinstallation ni l’ajout d’un domaine ne suffisent. Le test hôte ne prouve pas une installation complète protégée. |
| Lanceur Zed installé dans `~/…` côté Windows, accessible depuis WSL sous `/mnt/c/Users/winne/AppData/Local/Programs/Zed/bin/zed` | Le lanceur appelle `zed.exe`, avec des arguments WSL. Aucun lancement graphique n’a été effectué. | Une intégration avec l’hôte est nécessaire pour ce lanceur. Sa compatibilité complète reste à tester. |
| Dev Services : `~/projects/shared-services/dev-services/apps/cli/src/index.ts` et `packages/core/src/runtime.ts`, bundle installé et service actif | Le client transmet les commandes à un service qui les exécute sur l’hôte. | Conservez ce choix intentionnel et rendez son autorité réelle explicite. |

Les refus Git signalés dans la conversation correspondent à des refus de l’utilisateur. Ne les requalifiez pas en défaut d’isolation. La création de `/tmp/shellkeep` servait à sauvegarder des modifications avant une comparaison avec HEAD, et non à satisfaire une obligation du sandbox. Le code de sortie final d’une commande composée ne prouve pas que toutes ses étapes ont réussi.

Les rapports des deux sous-agents pi-expert ont été intégrés à l’audit initial. Ils ne constituent pas une revue indépendante de cette nouvelle architecture.

### Limites de la recherche

L’inventaire complet des outils Pi et de leurs accès hôte n’est pas établi. Les vérifications sur Bash ne prouvent pas l’isolation de `read`, des écritures natives, des extensions, des outils MCP ou des sous-agents. La révocation d’une autorisation pendant une opération, les autorisations minimales de chaque intégration et la migration des installations existantes restent à préciser dans le plan.

## Décisions retenues

Conservez les repères de la conversation pour les trois profils.

| Décision | Contrat |
| --- | --- |
| **D1 — Isolé, par défaut** | Exécutez les commandes dans le sandbox avec des accès limités. N’accordez aucune exécution hôte implicite. Appliquez ce défaut sur une nouvelle machine. |
| **D2 — Isolé avec intégrations** | Conservez l’isolation des commandes ordinaires et activez seulement les capacités locales autorisées. Signalez chaque opération hôte comme telle. Utilisez ce profil comme destination pour le poste personnel de l’utilisateur. |
| **D3 — Hôte** | Réservez l’exécution hors sandbox à une activation explicite de portée déterminée. Maintenez les contrôles de permissions et signalez l’absence d’isolation système. |

Traitez ces profils comme des ensembles de capacités compréhensibles, pas comme un score unique de sécurité. Distinguez les accès aux fichiers, au réseau, aux services locaux et à l’exécution hôte. Ne déduisez pas qu’une ouverture dans un domaine autorise les autres.

Préservez également les actions validées :

- **A4 — Autorité locale.** Fixez sur la machine les ouvertures autorisées. Autorisez un dépôt à exprimer un besoin, jamais à s’accorder lui-même ce besoin.
- **A5 — Portée.** Sélectionnez au niveau du projet et de la session un sous-ensemble des ouvertures accordées. Exigez une décision utilisateur pour toute ouverture supplémentaire. Permettez de mémoriser cette décision pour le projet sur cette machine.
- **A6 — Prise en charge par Pi.** Sélectionnez le parcours d’exécution et produisez les erreurs explicites dans le harness. Donnez au modèle les capacités disponibles, sans lui faire reconstruire les règles du sandbox.

Ces repères A4–A6 reprennent la dernière proposition approuvée. Les repères de l’audit historique restent propres à ce rapport.

## Architecture cible

### Autorité, préférences et disponibilité

Séparez trois informations : les autorisations locales accordées par l’utilisateur, les capacités souhaitées par le projet ou la session, et les capacités réellement disponibles. Considérez une capacité comme utilisable seulement si les trois conditions sont satisfaites.

Conservez les autorisations hors des fichiers que le dépôt ou une commande sandboxée peut modifier. Ne transportez pas les autorisations locales avec un clone Git. Définissez pendant la planification le traitement d’une copie de la configuration Pi vers une autre machine. Ne confondez pas l’installation d’un outil avec l’autorisation de l’utiliser sur l’hôte.

Permettez au projet et à la session de restreindre les autorisations accordées. Distinguez une autorisation absente d’une interdiction explicite. Ne remplacez jamais un refus utilisateur par une autre route d’exécution donnant accès à la même opération.

### Exécution et intégrations

Réutilisez le propriétaire Bash et le runtime partagé pour sélectionner l’exécuteur. Centralisez la résolution des autorisations et les preuves d’exécution. Maintenez les particularités de Zed, SFW et Dev Services dans leurs intégrations, sans ajouter leurs chemins ou protocoles au cœur générique de Zerobox.

Définissez les intégrations par les opérations qu’elles permettent. « Ouvrir un fichier du projet dans l’éditeur » et « Exécuter une commande arbitraire sur l’hôte » n’accordent pas la même autorité. Signalez explicitement la seconde, notamment pour les parcours Dev Services concernés.

Ne promettez pas une compatibilité automatique avec tous les outils présents dans le PATH. Fournissez une interface commune d’autorisation, de diagnostic et de résultat, puis validez les intégrations prises en charge. Évitez de transformer les commandes composées du shell en appels hôte par une détection approximative de leur nom. Choisissez dans le plan les frontières d’appel et les validations d’arguments nécessaires.

### Parcours d’une opération

1. Chargez le profil et les autorisations locales applicables au projet et à la session.
2. Résolvez l’opération demandée et vérifiez sa disponibilité et son autorisation.
3. Appliquez les contrôles de permissions existants. Une autorisation d’intégration ne vaut pas approbation de toutes ses opérations.
4. Exécutez dans le sandbox, ou dans l’intégration hôte explicitement autorisée.
5. Renvoyez le résultat réel, le lieu d’exécution, le profil et l’autorisation utilisée.

En cas de capacité absente, expliquez la restriction et le parcours d’activation utilisateur. N’activez rien automatiquement et ne multipliez pas les tentatives équivalentes. Vérifiez les prérequis utiles au démarrage ou à l’activation, puis les conditions susceptibles de changer avant l’exécution. Ne lancez pas un éditeur ni une installation de dépendances comme simple diagnostic initial.

### Résultats et erreurs

Distinguez refus utilisateur, autorisation manquante, outil indisponible, échec de préparation du sandbox, refus réseau et échec du programme cible. Préservez stdout, stderr et le véritable code de sortie. Signalez une provenance inconnue au lieu d’inventer une preuve d’isolation.

Affichez les opérations hôte même si elles ont été déclenchées depuis une commande sandboxée. Assurez la cohérence entre les données visibles par le modèle, la TUI et les journaux. Définissez les actions de récupération dans le harness et ne conseillez aucun contournement d’un refus.

## Alternatives écartées

| Option examinée | Motif |
| --- | --- |
| **O1 — Développement hôte par défaut** | Écartée après clarification : l’isolation doit primer sur une nouvelle machine. Conservez uniquement l’activation explicite D3. |
| **O2 — Environnement de développement isolé complet obligatoire** | Non retenue pour cette amélioration : elle impose la maintenance d’un environnement distinct et ne répond pas directement au besoin des outils du poste. |
| **O3 — Exceptions successives dans le sandbox actuel** | Écartée comme stratégie générale : elle reporte la découverte des incompatibilités sur l’utilisateur et le modèle. Des besoins spécifiques restent à traiter dans les intégrations D2. |

La voie sélectionnée combine un défaut isolé et des capacités hôte locales contrôlées. Elle ne promet pas de conserver une isolation totale pour les opérations auxquelles l’utilisateur accorde un accès hôte.

## Points à résoudre pendant la planification

Ces questions ne bloquent pas la documentation de la direction. Résolvez-les avant d’implémenter les composants concernés.

| Repère | Question précise | Méthode de résolution |
| --- | --- | --- |
| **Q1 — Autorisations** | Quel stockage protégé, quelle identité de projet et quelle portée pour les autorisations persistantes et temporaires ? | Inspectez l’autorité Docker et pi-permission-system. Réutilisez les mécanismes valides, puis testez les tentatives d’auto-autorisation et le changement de machine. |
| **Q2 — Intégrations initiales** | Quels appels et arguments autoriser pour Zed, SFW et Dev Services ? | Définissez le contrat de chaque intégration à partir du parcours réel. Testez Zed sans effet non demandé et SFW dans un projet jetable autorisé. |
| **Q3 — Portée de l’isolation** | Quels outils natifs, extensions, MCP et sous-agents peuvent accéder à l’hôte hors du runtime Bash ? | Inventoriez leurs frontières d’exécution. Documentez la couverture et les limites avant de qualifier une session entière d’isolée. |
| **Q4 — Révocation** | Que devient une opération déjà lancée lorsqu’une capacité est retirée ? | Examinez le superviseur et les services distants. Définissez le comportement des nouvelles opérations, des processus existants et des opérations non annulables. |
| **Q5 — Migration** | Comment convertir les réglages actuels en capacités explicites sans élargissement silencieux ni perturbation des services ? | Produisez une comparaison avant/après, exposez les écarts et obtenez une décision pour les changements d’autorité. Préservez les données et les refus existants. |
| **Q6 — Interface et modèles** | Quels schémas et messages permettent aux modèles économiques de choisir correctement le parcours ? | Préparez des exemples minimaux, puis mesurez des scénarios identiques. Fixez les seuils d’acceptation avant de conclure sur leur fiabilité. |

Revenez vers l’utilisateur seulement si la résolution de ces questions implique un nouvel arbitrage de sécurité, de portée ou d’expérience utilisateur. Résolvez les questions factuelles dans le code et avec des sondes ciblées.

## Validation attendue

- **V1 — Défaut portable.** Vérifiez qu’une configuration neuve reste isolée, qu’une intégration installée ne s’active pas seule et qu’un dépôt ne peut pas s’accorder de droits hôte.
- **V2 — Autorisations et refus.** Vérifiez les restrictions de projet et de session, les refus explicites, la révocation et l’absence de repli hôte après erreur.
- **V3 — Frontières réelles.** Testez les outils via le runtime Pi et ses hooks, puis les processus réels pour les garanties système. Ne remplacez pas ces preuves par des tests de fonctions copiées ou des simulations du sandbox.
- **V4 — Compatibilité.** Vérifiez les parcours Zed, SFW et Dev Services, leurs arguments, leur provenance et leurs erreurs. Pour SFW, distinguez version, téléchargement, installation complète et refus de sécurité contrôlé.
- **V5 — Régressions.** Préservez les refus Git, les contrats stricts de Think-in-Code et le fonctionnement intentionnel des services. Vérifiez les codes de sortie et les commandes composées.
- **V6 — Accessibilité aux modèles économiques.** Comparez les mêmes tâches et autorisations avec les modèles retenus. Mesurez réussite complète, appels inutiles, interventions humaines, coût et identification correcte du lieu d’exécution. Ne déduisez pas une fiabilité statistique des sessions historiques.

Appliquez RED → GREEN → REFACTOR aux changements de comportement lors de l’implémentation. Commencez par les tests publics les plus petits capables de révéler le défaut, puis complétez par les preuves système nécessaires.

## Passage à la planification

Utilisez ce document comme contrat de direction. Préparez ensuite un plan avec les modules concernés, les contrats d’autorisation, la migration, les tests et les critères d’acceptation. Identifiez les besoins de preuve avant chaque changement de production.

N’implémentez pas les profils, n’ouvrez pas de permissions, n’installez pas de dépendances et ne redémarrez pas de services dans cette étape de documentation. Aucun nouvel accord n’est nécessaire pour produire ce document. La définition détaillée et l’exécution du plan constituent les étapes suivantes.
