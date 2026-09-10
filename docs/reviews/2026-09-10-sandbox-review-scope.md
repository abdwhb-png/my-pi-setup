# Périmètre de la revue indépendante

Révision Pi figée : `aad0c85453607daa5bc9b5b9a1d56812a21496ad`.
Base avant implémentation : `6d4aa91`.
Objet : vérifier l’implémentation du plan utilisateur « Profils d’isolation et
capacités hôte locales », pas seulement le dernier correctif TypeBox.

Consulter le diff des répertoires `agent/extensions/sandbox`,
`agent/extensions/bash-execution`, `agent/extensions/_shared/command-execution`,
`agent/extensions/_shared/execution-provenance` et
`agent/extensions/_shared/sandbox-runtime`, ainsi que leurs consommateurs.
Lire le brainstorming `docs/brainstorming/2026-09-09-sandbox-isolation-and-local-capabilities-design.md`,
le guide `agent/extensions/sandbox/docs/shell-capabilities.md`, les évaluations
`docs/evaluations/sandbox-local-capabilities.md` et le bilan
`docs/implementation/2026-09-10-sandbox-local-capabilities.md`.
Vérifier leurs affirmations dans le code et les tests.

Examiner les changements externes s’ils affectent le parcours suivi :
- Zerobox : dépôt `~/projects/shared-services/sandboxes/zerobox-local-capabilities`,
  diff `fff8a45..5c530891c2883bfbfd192883002cfc9b0f50e632`.
- MCP : dépôt `~/.pi/agent/git/github.com/abdwhb-png/pi-mcp-adapter`,
  commit `53733d3`.

Ne pas attribuer à ce plan les changements utilisateur ultérieurs de CPA,
browser-tools, instructions, configuration de permissions ou compétences.
Préserver les modifications non commitées et les services existants.
Ne modifier aucun code pendant la revue. Limiter les expériences à des
fixtures jetables, sans accorder de droits locaux ni lancer d’intégration hôte
réelle ou d’installation de dépendances. Ne pas déléguer davantage.

## Exigences normatives du plan utilisateur

### Résultat et autorité

- D1 : sandbox actif, réseau fermé, `/tmp` privé par défaut.
- D2 : mêmes protections pour le shell ordinaire, ouvertures accordées
  explicitement sur cette machine.
- D3 : exécution hôte explicitement activée, contrôles de permissions conservés.
- Limiter cette version au shell. Afficher que les outils natifs de fichiers
  restent sur l’hôte et documenter leur raccordement ultérieur à la politique.
- Mémoriser les accords par projet et machine, avec option session. Après
  révocation, bloquer les nouvelles opérations et laisser terminer celles admises.
- Ajouter `/sandbox profile isolated|integrated|host`, les commandes de consultation,
  accord et révocation de capacités et un diagnostic des profils demandé/effectif,
  de la disponibilité et des opérations encore actives après révocation.
- Conserver les alias existants. Une désactivation ancienne demande explicitement
  D3 et passe les mêmes autorisations.
- Stocker les accords dans `~/.pi/agent/sandbox.capabilities.json`, séparément du
  dépôt. Vérifier propriétaire, fichier régulier, absence de lien symbolique,
  permissions initiales `0600` et écritures atomiques, comme l’autorité Docker.
- Lier les accords à l’identité locale Linux/WSL et au chemin canonique du projet.
  Ne pas réactiver automatiquement une configuration copiée vers une autre machine.
- Laisser les préférences du projet et de la session seulement restreindre les
  droits. La confiance du projet n’accorde rien. Sans UI, utiliser les accords
  existants ou bloquer avec une explication.

### L1 : résolveur commun

- Distinguer autorisations, préférences et disponibilité. Partager l’état dans
  un registre global compatible avec les instances Jiti séparées.
- Faire passer réseau, partage de `/tmp`, extensions des accès aux fichiers du
  shell et intégrations hôte par cette autorité. Préserver interdictions fixes
  et refus explicites.
- Protéger le magasin contre le shell sandboxé et les outils natifs `write`/`edit`,
  sans assimiler cette protection ciblée à une migration générale des outils de fichiers.

### L2 : runtime

- Sélectionner le backend dans le propriétaire Bash après vérification des droits.
- Séparer le profil shell de l’état moteur : D3 ne désactive pas Think-in-Code strict.
- Configurer le namespace temporaire indépendamment du profil strict. Préserver
  les conventions HOME du shell et les espaces privés de Think.
- Publier immédiatement les changements pour les nouvelles commandes. Conserver
  les anciens runtimes et ressources jusqu’à la fin des opérations admises,
  puis les libérer. Préserver délais et annulation explicite. Aucun repli hôte sur échec.

### L3 : contrat du modèle et intégrations

- Conserver `safe_bash.command`, le garde Safe Bash et la pipeline de
  `pi-permission-system`, avec sa surface de permissions `bash`.
- Ajouter `hostCapability?: "editor" | "dependencies" | "dev-services"`.
  Ce champ demande une capacité, sans jamais l’accorder. Sans champ, suivre le
  profil ordinaire. Avec champ, autoriser puis sélectionner l’intégration.
- En D2, accepter seulement une commande simple à arguments littéraux.
  Refuser pipelines, substitutions, redirections et compositions. Conserver
  le shell général dans le sandbox ou D3 explicitement choisi.
- Zed : ouvrir les fichiers du projet, résoudre un lanceur local approuvé,
  refuser les chemins sortant du projet.
- SFW : couvrir les dépendances npm et les paquets Pi. Ajouter le wrapper dans
  l’adaptateur, conserver ses mises à jour normales, arrêter après son échec,
  signaler les autres gestionnaires comme non pris en charge.
- Dev Services : transmettre les commandes simples au projet enregistré via
  le client existant, déclarer explicitement l’exécution hôte et ne pas ouvrir
  automatiquement le port général de l’API au sandbox.
- Résoudre les exécutables depuis une installation locale approuvée, sans
  accepter de programme homonyme provenant du dépôt. Superviser les opérations hôte.

### L4 : permissions et restitution

- Vérifier le contrat de permissions dans le runtime Pi. Un Git refusé reste
  refusé avec chaque capacité. Ne démarrer aucun processus avant les contrôles.
- Restituer profil, backend, capacité et namespace temporaire.
- Distinguer autorisation absente, refus utilisateur, intégration indisponible,
  préparation échouée et échec du programme.
- Préserver stdout, stderr et le code réel. Ne pas transformer automatiquement
  un message textuel en changement de statut.

### Validation et livraison

- V1 : installation neuve isolée, réseau inaccessible, `/tmp` privé, aucun hôte automatique.
- V2 : accords invalides et changement de machine refusés, aucun élargissement par le dépôt.
- V3 : permissions avant processus, refus Git conservé pour les capacités hôte.
- V4 : drainage des opérations admises, nouveaux droits immédiats, aucun repli hôte.
- V5 : Zed ciblé, SFW bénin dans un projet jetable, Dev Services avec provenance hôte.
  Distinguer refus simulés et parcours réels.
- V6 : contexte modèle exact, erreurs actionnables, limite des outils de fichiers explicite.
- Appliquer RED → GREEN → REFACTOR avec les vrais modules. Exécuter tests ciblés,
  types et runtime Pi. Vérifier les racines des paquets effectivement chargés.
- Livrer des scénarios reproductibles pour modèles économiques : réussite,
  appels inutiles, interventions humaines et compréhension du lieu d’exécution.
  Garder les appels LLM hors des tests automatiques.
- Comparer anciennes ouvertures et capacités, demander une seule décision sur
  les droits à conserver, sans conversion silencieuse. En attente, bloquer les
  nouvelles exécutions concernées, préserver sessions admises, services et données.
- Documenter réseau, `/tmp`, révocation, périmètre shell, profils, exemples et
  limites. Livrer par commits correspondant aux lots. Ne pas modifier le paquet
  de permissions ni ajouter de dépendance. Prévoir un redémarrage complet de Pi.

## Résultat demandé aux relecteurs

Rendre un rapport final complet avec le périmètre examiné, les exigences
couvertes, les constats vérifiables par gravité, les chemins et lignes exacts,
les conditions de reproduction, l’impact, une correction précise et les limites
non vérifiées. Distinguer défaut prouvé, lacune de tests et risque hypothétique.
Ne pas présenter un rapport intermédiaire comme une revue terminée.
