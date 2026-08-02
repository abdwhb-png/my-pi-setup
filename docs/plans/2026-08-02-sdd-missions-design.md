<!-- markdownlint-disable MD013 -->

# SDD Missions

**Date:** 2026-08-02

**Status:** Design approuvé

**Cible principale:** `agent/extensions/sdd-missions/`

**Remplace après cutover:** `agent/extensions/sdd-orchestrator/`, le rôle `sdd-plan` et les agents SDD devenus inutiles

## Contexte

Le workflow `sdd-orchestrator` actuel est déterministe après compilation d'un plan, mais son expérience d'utilisation et son modèle d'exécution ne correspondent plus au résultat recherché. Il traite un plan Markdown externe comme entrée, compile des tâches plates dans un manifest, applique un profil par tâche et borne les workers, reviewers et corrections avec un plafond commun de lancements.

La session Pi `019fa86b-1f09-7269-af28-56c2f66eb72b` a rendu les limites de ce modèle observables : 15 appels à `sdd_prepare`, 9 manifests approuvés, 8 appels à `write_plan`, 12 à `edit_plan` et 13 consultations de statut. Chaque run lié au changement actif s'est arrêté sur `task-1`, avec notamment `budget_exhausted`, `invalid_review_output`, `acceptance_failed` et `reviewer_blocked`. Plusieurs workers ou reviewers avaient pourtant produit du code, des tests ou un verdict exploitable. Des défaillances de protocole, des contrôles de baseline et des critères d'acceptance ont donc été comptabilisés comme des échecs fonctionnels et ont provoqué de nouveaux plans et de nouvelles approbations.

Factory Missions fournit une inspiration utile, sans être un contrat à copier. Les principes retenus sont : définir la réussite avant les features, externaliser l'état, donner un contexte frais à chaque agent, regrouper les features en milestones, valider chaque milestone avec des agents indépendants et transformer les findings en fix features. L'objectif local reste spécifique à Pi, aux règles SDD de ce dépôt et aux garanties programmatiques déjà éprouvées.

Le nouveau système doit être une mission complète, depuis l'objectif jusqu'à l'application locale du résultat validé. La planification n'est plus un préalable extérieur à SDD : elle devient une phase native, déléguée et contrôlée de la mission.

## Objectifs

- Démarrer explicitement une mission depuis un objectif avec `/sdd-mission <objectif>`.
- Recommander une intensité SDD de façon déterministe après une reconnaissance courte et factuelle.
- Faire confirmer l'intensité avant de dimensionner l'exploration et la planification approfondies.
- Déléguer les recherches nécessaires à des sous-agents spécialisés avec contextes frais et périmètres bornés.
- Produire un contrat de validation avant le graphe final des milestones et features.
- Obtenir une approbation unique avant l'exécution autonome.
- Figer l'objectif, les contraintes, l'intensité minimale et le contrat de validation après approbation.
- Autoriser l'évolution append-only du graphe d'exécution par redécoupage et fix features.
- Valider les milestones avec des agents indépendants plutôt que d'imposer une double review à chaque petite feature.
- Séparer les budgets d'exploration, d'implémentation, de correction, de validation et d'infrastructure.
- Traiter les erreurs de protocole comme des défaillances d'orchestration, jamais comme des défauts du code.
- Fonctionner sur un working tree propre ou non propre sans attribuer à la mission les changements préexistants.
- Appliquer automatiquement le delta validé lorsque la source correspond toujours au baseline et qu'aucun conflit n'existe.
- Centraliser l'état sous `<cwd>/.pi/sdd-missions/<mission-id>/`.
- Reprendre de façon idempotente après une interruption ou un redémarrage.
- Supprimer définitivement `sdd-orchestrator` après validation et cutover de `sdd-missions`.

## Non-objectifs

- Maintenir durablement deux orchestrateurs.
- Convertir automatiquement les anciens snapshots `.sdd` en missions.
- Conserver le rôle `sdd-plan` ou un rôle de contrôle équivalent.
- Donner au LLM la responsabilité de choisir librement les transitions, budgets, reviewers ou retries.
- Réutiliser une conversation de sous-agent pour une nouvelle tentative.
- Déverser l'intégralité des artefacts de mission dans le contexte d'un worker.
- Autoriser une fix feature à modifier le périmètre produit ou le contrat de validation approuvé.
- Commiter, pousser, merger ou déployer sans autorisation distincte.
- Garantir une isolation contre un autre processus disposant d'un accès filesystem complet; la détection d'altération est requise, mais l'isolation hostile relève d'une sandbox OS.

## Décision centrale

Créer une nouvelle extension `sdd-missions` avec ses propres types métier, sa propre machine d'états et son propre store. La coexistence avec `sdd-orchestrator` est uniquement une stratégie de construction et de cutover. Elle n'est pas une architecture produit permanente.

Les primitives réellement neutres de l'ancien moteur peuvent être extraites ou adaptées : transport de délégation, corrélation, redaction, écritures atomiques, locks, digests et composants TUI génériques. Les abstractions `ParsedPlan`, `DraftManifest`, `ApprovedManifestTask`, `RunSnapshot`, `TaskState`, `ProfileBudget` et le workflow task-centric ne sont pas des contrats de réutilisation.

Le cutover supprime l'ancien moteur, ses tools, son rôle et ses agents devenus inutiles. Le répertoire `.sdd/` est conservé comme archive locale inerte jusqu'à une purge séparée et explicitement autorisée.

## Architecture

### Mission Controller

Le Mission Controller possède la commande, la phase active, les transitions valides, les restrictions de tools, la reprise et les décisions utilisateur. Il injecte avant chaque appel LLM un statut compact contenant la phase, l'artefact attendu, les blocages et l'unique prochaine action autorisée.

Il ne demande jamais au modèle de se souvenir du workflow. Une transition invalide est rejetée par le programme. Les phases d'écriture disposent d'un tool de soumission dédié; les tools génériques de planification et de mutation ne peuvent pas servir à contourner le store de mission.

### Planning Coordinator

Le Planning Coordinator dirige la reconnaissance, la recommandation d'intensité, les explorations spécialisées, le contrat de validation et la décomposition en milestones et features. Il assemble des sorties structurées; il ne copie pas des transcriptions entières de sous-agents dans les artefacts approuvés.

### Execution Engine

L'Execution Engine sélectionne les features prêtes, vérifie leurs dépendances et conflits d'écriture, compile leurs paquets de tâche, lance workers et validators, comptabilise les budgets appropriés et crée les fix features autorisées.

### Artifact Store

L'Artifact Store est la source de vérité. Il valide les schémas, confine les chemins, refuse les symlinks, écrit atomiquement, contrôle les révisions attendues et conserve un journal append-only. Les snapshots sont des projections reconstruisibles du journal.

### Delegation Gateway

Le Delegation Gateway encapsule le protocole public de `pi-subagents`. Chaque requête est corrélée à une mission, une entité, une étape, une tentative et un digest de Task Packet. Les réponses structurées sont validées localement avant toute transition.

### Workspace and Delivery

Cette frontière capture le baseline, matérialise le workspace isolé, calcule le delta de mission, détecte la dérive de source et applique le patch validé de façon contrôlée et idempotente.

### Activity and Review UI

L'activité live reste éphémère et distincte de l'état durable. Le widget et `/sdd-mission live` projettent des événements corrélés, bornés et redacted. Les erreurs d'observabilité sont best-effort et ne peuvent jamais modifier l'issue d'une mission.

## Cycle de vie

Le cycle nominal est :

```text
created
  -> recognizing
  -> awaiting_intensity_confirmation
  -> exploring
  -> planning
  -> awaiting_approval
  -> executing
  -> validating_milestone
  -> executing_fix_features
  -> validating_milestone
  -> validating_mission
  -> applying
  -> completed
```

Les états transversaux sont `paused`, `needs_decision`, `cancelled` et `failed`. Une pause est réversible. `needs_decision` exige une décision typée et explique pourquoi le contrat approuvé ne permet pas de continuer. `cancelled`, `failed` et `completed` sont terminaux.

Les transitions sont événementielles, persistées avant et après toute frontière externe, et idempotentes. Aucun polling du LLM n'est nécessaire pour progresser.

## Reconnaissance et intensité SDD

La reconnaissance est courte, bornée et en lecture seule. Elle collecte uniquement les éléments nécessaires pour dimensionner la mission : portée réelle, dépendances, surfaces de validation, risques sensibles, état du dépôt et incertitudes bloquantes.

Un rules engine transforme des signaux factuels versionnés en recommandation `light`, `standard` ou `critical`. L'utilisateur confirme ou modifie cette recommandation avant l'exploration approfondie. La décision et ses preuves sont persistées dans `intensity.json`.

L'intensité confirmée est le plancher global de la mission. Elle dimensionne :

- le nombre et la profondeur des explorations;
- la granularité des milestones et features;
- les modèles et efforts autorisés par rôle;
- la profondeur des validations;
- les budgets de correction et d'infrastructure;
- le parallélisme maximal.

Une milestone ou une feature peut être élevée automatiquement avec une justification traçable. Aucun downgrade sous le niveau confirmé n'est silencieux.

## Planification et approbation

Les recherches sont déléguées par questions précises. Chaque résultat référence ses sources, faits, incertitudes et impact sur la mission. Le Planning Coordinator écrit ensuite un contrat de validation fini avant de finaliser le plan.

Chaque assertion du contrat possède au minimum :

- un identifiant stable;
- le comportement attendu;
- les préconditions;
- la méthode ou le tool de validation;
- la preuve attendue;
- la milestone responsable;
- un statut de couverture.

Le plan regroupe les features en milestones cohérentes. Chaque feature déclare les assertions qu'elle prétend satisfaire, ses dépendances, son périmètre de fichiers ou ressources, ses vérifications et les décisions qu'elle n'est pas autorisée à prendre.

L'approbation unique fige :

- l'objectif et les contraintes;
- l'intensité minimale;
- les digests des recherches retenues;
- le contrat de validation;
- le plan initial et la hiérarchie;
- les budgets;
- le baseline;
- l'autorisation d'exécuter et d'auto-appliquer un delta validé.

Après approbation, les fix features et redécoupages sont append-only. Une modification du périmètre produit, d'une contrainte ou du contrat de réussite produit `needs_decision` et exige une nouvelle approbation explicite.

## Artefacts

La racine canonique est `<cwd>/.pi/sdd-missions/<mission-id>/`. Dans ce dépôt, elle correspond à `~/.pi/.pi/sdd-missions/<mission-id>/`.

```text
.pi/sdd-missions/<mission-id>/
├── mission.json
├── baseline.json
├── brief.md
├── intensity.json
├── validation-contract.json
├── plan.json
├── events.jsonl
├── snapshot.json
├── research/
├── features/
├── validations/
├── evidence/
└── delivery/
```

`mission.json` contient l'identité, la version de schéma, le propriétaire et les références stables. `events.jsonl` est append-only. `snapshot.json` est une projection reconstruisible. Les sous-dossiers conservent les résultats structurés et leurs preuves sans exiger leur injection dans chaque contexte.

`.pi/sdd-missions/` est exclu programmatiquement du baseline, des deltas et des validations Git. Le système ne modifie pas automatiquement le `.gitignore` versionné. Une exclusion locale `.git/info/exclude` peut être installée sans changer le projet.

Chaque écriture vérifie le propriétaire, la révision attendue, le confinement, l'absence de symlink et le digest. Une altération externe d'un artefact approuvé ou d'un état durable produit `needs_decision` au lieu d'être absorbée silencieusement.

## Task Compiler et isolation de contexte

Une tentative correspond toujours à un contexte frais. Aucun worker, validator ou chercheur n'est repris avec son historique pour une nouvelle tentative.

Avant chaque délégation, le Task Compiler produit un paquet borné contenant :

- un objectif unique et un résultat attendu;
- la feature, correction ou question exacte;
- les assertions concernées;
- les dépendances satisfaites;
- les fichiers et interfaces autorisés;
- les instructions du dépôt applicables;
- les preuves directement nécessaires;
- les commandes de vérification;
- les décisions interdites ou bloquantes;
- le schéma de sortie obligatoire.

Un readiness gate rejette toute tâche ambiguë, trop large, non testable ou dépendante d'une décision non approuvée. Elle retourne alors à la planification pour clarification ou redécoupage.

Le compilateur utilise le modèle réellement sélectionné et ses limites configurées. Il réserve une part substantielle du contexte pour l'inspection locale, les tools, l'implémentation et les résultats. Un paquet initial excessif provoque un redécoupage avant lancement.

Après un échec, le nouvel agent reçoit uniquement les faits persistés : contrat, delta, commandes, erreurs observées et findings applicables. Les raisonnements et transcriptions du prédécesseur ne sont pas injectés.

Les modèles économiques traitent des tâches étroites et mécaniques. Une décision complexe ou un échec répété peut déclencher un routage vers un modèle plus compétent autorisé par l'intensité.

## Exécution des features

Le runner sélectionne uniquement les features dont les dépendances sont satisfaites. Deux writers peuvent avancer en parallèle seulement si leurs périmètres d'écriture sont indépendants et si la politique d'intensité le permet.

Le cycle nominal d'une feature est :

```text
planned -> ready -> implementing -> self_verifying -> completed
```

Le worker suit TDD et exécute les vérifications définies dans son Task Packet. Il produit un delta et des preuves structurées. Une feature élevée à `critical` passe ensuite par une review locale indépendante. Les autres attendent la validation du milestone.

Un worker qui rencontre une décision absente, un périmètre insuffisant ou une opération non autorisée retourne un résultat `blocked` typé. Il n'élargit pas lui-même sa tâche.

## Validation des milestones

Lorsque toutes les features d'un milestone sont terminées, des validators frais interviennent :

- scrutiny du code, de l'intégration, des tests et du respect des conventions;
- validation comportementale black-box contre les assertions applicables;
- validation navigateur, TUI ou service réel seulement lorsque le contrat la déclare et que l'environnement est prêt.

Un test navigateur complète les tests, le lint et le typecheck; il ne les remplace pas. Les preuves attendues peuvent inclure snapshots, screenshots, logs, requêtes réseau et sorties de commandes.

Un finding bloquant devient une fix feature liée au validator, au finding, à l'assertion et au périmètre concerné. La correction est exécutée par un contexte frais. Après les corrections, le milestone entier est revalidé. Une fix feature ne peut pas modifier le contrat approuvé ni introduire une nouvelle fonctionnalité.

## Budgets et récupération

Les budgets sont indépendants :

- reconnaissance et exploration;
- planification;
- implémentation;
- corrections fonctionnelles;
- rondes de validation;
- infrastructure et protocole;
- budget global de mission.

Il n'existe pas de compteur unique équivalent à `launches 4/7`. Avant d'épuiser un budget local, l'orchestrateur peut redécouper la feature ou créer une fix feature autorisée. Le budget global reste la limite d'autonomie.

Une sortie structurée invalide, un timeout de transport ou une corrélation impossible consomme seulement le budget infrastructure. La récupération suit :

1. validation déterministe du résultat;
2. réparation bornée du protocole;
3. validator ou agent de remplacement avec contexte frais;
4. `needs_decision` si plusieurs tentatives indépendantes restent inexploitables.

Aucun worker correctif n'est lancé sans véritable verdict fonctionnel `changes_required` ou finding bloquant valide.

Le moteur demande l'utilisateur uniquement pour une décision hors contrat, une permission ou un secret manquant, une action irréversible non autorisée, la répétition démontrée du même blocage ou l'épuisement du budget global.

## Persistance et reprise

Chaque délégation suit une séquence durable :

```text
request_planned
  -> request_dispatched
  -> terminal_response_recorded
  -> response_applied
```

La requête est persistée avant l'appel externe avec identifiant, agent, entité, étape, tentative et digest du paquet. La réponse terminale est persistée avant toute transition métier.

Après redémarrage, le moteur recherche d'abord un résultat terminal exactement corrélé. Il ne relance pas aveuglément un writer dont l'état est incertain. Une réponse déjà appliquée ne consomme pas deux fois un budget et ne crée pas deux fois une fix feature.

Si aucune preuve terminale n'est disponible et que l'exécution précédente peut encore modifier le workspace, la mission passe à `needs_decision`. La sécurité contre un double writer prime sur une reprise spéculative.

## Baseline, workspace et livraison

`baseline.json` enregistre le commit, les digests des fichiers suivis modifiés et les fichiers non suivis explicitement pertinents. Les fichiers ignorés, caches, artefacts de build, secrets détectables et `.pi/sdd-missions/` sont exclus du delta de mission.

Le workspace isolé est construit depuis le commit, puis le baseline autorisé y est matérialisé. Le delta final est calculé relativement à ce baseline, jamais simplement relativement à `HEAD`.

Après validation finale :

1. recalculer l'empreinte du working tree source;
2. vérifier qu'elle correspond toujours au baseline;
3. vérifier le patch sans mutation;
4. appliquer automatiquement le delta sans commit;
5. enregistrer un reçu de livraison contenant le digest du patch et l'état résultant.

Toute dérive, collision, vérification négative ou application partielle arrête la livraison et conserve le workspace. Aucun commit, push, merge ou déploiement n'est implicite.

## Flow utilisateur

La commande principale est `/sdd-mission <objectif>`. La surface utilisateur minimale est :

- `/sdd-mission status [id]`;
- `/sdd-mission review [id]`;
- `/sdd-mission pause [id]`;
- `/sdd-mission resume [id]`;
- `/sdd-mission cancel [id]` avec confirmation;
- `/sdd-mission live [id]`.

Chaque phase expose uniquement les tools requis pour produire son artefact ou sa décision. Les tools génériques `write_plan`, `edit_plan` et les lancements arbitraires de sous-agents sont bloqués pour les opérations appartenant à une mission active.

L'approbation utilise un overlay natif montrant exactement les valeurs figées. Après approbation, le runner gère les lancements. Le LLM ne répète pas `prepare`, `approve` ou `status` pour faire progresser le workflow.

Un widget compact affiche milestone, feature active, validation et budgets. Il ne persiste pas de sortie live dans le contexte LLM.

## Sécurité et invariants

- Aucun chemin persistant ne hardcode `/home/<user>`; les chemins utilisateur sont documentés avec `~/` et développés par `homedir()` avant I/O.
- Toute écriture d'artefact est confinée sous la racine de la mission.
- Les symlinks et traversals sont refusés aux frontières d'écriture et de purge.
- Un agent reçoit le minimum de tools et de fichiers nécessaire à son rôle.
- Un validator ne modifie jamais le code.
- Un worker ne modifie jamais le contrat de validation.
- Une fix feature ne peut pas élargir le scope approuvé.
- Une défaillance d'observabilité ne modifie jamais l'état durable.
- Une erreur d'infrastructure ne devient jamais un finding fonctionnel.
- Une tentative ne réutilise jamais le contexte conversationnel de la tentative précédente.
- Une application de patch est vérifiée et idempotente.

## Stratégie de test

L'implémentation suit TDD par tranche verticale : test rouge sur le module réel, code minimal, refactorisation, puis gates affectés.

### Contrats purs

Tester les schémas, le Task Compiler, les budgets, les digests, les règles d'autorité et la classification d'intensité avec `bun:test`.

### Machine d'états

Tester les tables de transitions et des séquences générées pour prouver qu'aucun milestone ne passe sans validation, qu'un finding ne disparaît pas, qu'une réponse dupliquée reste idempotente et qu'une fix feature ne peut pas modifier le contrat.

### Persistance

Tester écritures atomiques, conflits de révision, reconstruction depuis le journal, corruption, symlinks, traversal et altération externe.

### Délégation

Tester corrélation, contexte frais, outputs invalides, réparation de protocole, remplacement, timeout, annulation et reprise. Vérifier explicitement qu'une erreur de protocole ne consomme jamais un budget fonctionnel.

### Workspace Git

Utiliser des dépôts temporaires pour couvrir baseline propre ou sale, fichiers non suivis, dérive de source, conflits, exclusion de `.pi/sdd-missions/`, vérification du patch et non-application double.

### Intégration Pi

Utiliser le runtime Pi réel uniquement lorsque le test doit exercer les vrais tools, hooks, UI ou wrapping. Les helpers purs restent sous `bun:test` avec imports réels et mocks ciblés.

### Scénarios de mission

Couvrir une petite mission multi-milestones, une feature critical, une fix feature, une validation black-box, une interruption/reprise et l'auto-apply final. Vérifier qu'aucun transcript de tentative précédente n'est transmis et qu'un paquet excessif est redécoupé ou refusé.

### Gate de cutover

Le cutover exige les tests affectés, le typecheck, Oxlint, le format et la suite complète. Un test d'intégration doit prouver l'absence des anciens tools, rôles et listeners après suppression de `sdd-orchestrator`.

## Cutover et archive legacy

La coexistence n'existe que jusqu'à validation de `sdd-missions`. Pendant cette période, chaque moteur possède ses commandes, ses listeners et ses artefacts; aucun run n'est transféré automatiquement.

Avant le cutover, l'inventaire des runs `.sdd` est recalculé. Un run non terminal bloque la suppression. Les runs terminaux restent consultables comme fichiers, sans support runtime.

Le cutover retire :

- l'enregistrement de `sdd-orchestrator`;
- les tools `sdd_prepare`, `sdd_approve`, `sdd_status`, `sdd_result`, `sdd_apply`, `sdd_cancel` et `sdd_direct_complete`;
- le rôle `sdd-plan`;
- les agents, groupes de tools, prompts, settings et documentation devenus orphelins;
- les tests qui ne décrivent plus aucun contrat actif.

La purge de `.sdd/` est une opération destructive distincte qui exige une autorisation explicite.

## Risques résiduels

- La matérialisation et l'auto-application d'un baseline non propre exigent une matrice de tests Git approfondie.
- Les modèles économiques nécessitent des Task Packets particulièrement étroits; un mauvais découpage réduirait fortement leur fiabilité.
- Les validations black-box dépendent de la readiness du dépôt : commandes reproductibles, environnement pilotable, logs accessibles et fixtures stables.
- La coexistence temporaire peut créer des doubles listeners ou collisions si les commandes et ownership markers ne sont pas strictement séparés.
- Un processus externe avec accès complet peut altérer les artefacts; le système détecte l'altération mais ne peut pas fournir seul une isolation hostile.
- Le workspace/isolation actuellement présent dans le working tree est un prototype local non stabilisé et ne doit pas être traité comme une dépendance fiable sans review et tests propres.

## Critères de succès

- Une mission complète ne nécessite qu'une confirmation d'intensité et une approbation initiale en l'absence de véritable décision bloquante.
- Le LLM ne peut pas recréer un plan ou un manifest parallèle hors du store de mission.
- Un finding valide crée une fix feature dans la mission existante plutôt qu'un nouveau run.
- Une sortie de reviewer invalide ne déclenche aucune modification du code et ne consomme aucun budget fonctionnel.
- Chaque tentative utilise une session fraîche et un Task Packet borné.
- Les milestones ne passent qu'après validation indépendante contre le contrat approuvé.
- Une mission reprend sans dupliquer writer, budget, finding ou application.
- Les changements préexistants du working tree restent distincts du delta mission.
- Le résultat validé est appliqué automatiquement lorsque le baseline est inchangé et le patch sûr.
- Après cutover, `sdd-orchestrator` n'est plus chargé ni maintenu, tandis que `.sdd/` reste une archive inerte jusqu'à purge autorisée.

## Sources de conception

- Session Pi auditée : `019fa86b-1f09-7269-af28-56c2f66eb72b`.
- Factory, « How Missions Work » : <https://factory.ai/news/missions-architecture>.
- Factory, « Introducing Missions » : <https://factory.ai/news/missions>.
- Factory Documentation, « Autonomy Level » : <https://docs.factory.ai/cli/user-guides/auto-run>.
- Factory Documentation, release notes : <https://docs.factory.ai/changelog/release-notes>.
