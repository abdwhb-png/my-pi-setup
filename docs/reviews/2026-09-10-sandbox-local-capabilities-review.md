# Revue indépendante des profils d’isolation et capacités hôte

**Révision examinée :** `aad0c85453607daa5bc9b5b9a1d56812a21496ad`  
**Base :** `6d4aa91`  
**Verdict :** `REQUEST CHANGES`  
**Voies terminées :** conformité au plan et tests; runtime et intégrations.  
**Hors périmètre à la demande de l’utilisateur :** revue de sécurité.

La correction TypeBox est valide : le test Node/Jiti charge les extensions
Sandbox et Bash Execution par le véritable chargeur Pi et vérifie le schéma
public de `safe_bash`. Le contrôle de types global passe. La revue du plan
initial relève toutefois un défaut fonctionnel bloquant dans la restitution des
erreurs de capacité, ainsi que quatre lacunes de validation et un message de
migration incorrect.

## Synthèse

| Gravité  | Nombre |
| -------- | -----: |
| CRITICAL |      0 |
| HIGH     |      1 |
| MEDIUM   |      4 |
| LOW      |      1 |

## Constats

### F1 — HIGH — Les erreurs de capacité sont masquées par `safe_bash`

**Emplacements :**

- `agent/extensions/sandbox/capabilities/authority.ts:46`
- `agent/extensions/sandbox/capabilities/runtime.ts:38`
- `agent/extensions/_shared/command-execution/core.ts:202`
- `agent/extensions/_shared/command-execution/failure.ts:148`
- `agent/extensions/bash-execution/safe-bash/index.ts:154`

`CapabilityError` distingue `authorization-required`, `migration-required`,
`machine-mismatch`, `integration-unavailable` et `unsupported-command`. Le
classificateur partagé ne reconnaît pas ce type et remplace ces erreurs par :

```text
Command failed (raw output redacted)
```

La reproduction a utilisé le vrai outil Pi `safe_bash` dans le harness, une
politique `integrated` sans capacité `editor`, puis l’appel :

```json
{ "command": "zed SYSTEM.md", "hostCapability": "editor" }
```

Le résultat public contient `isError: true`, le texte générique ci-dessus et une
provenance `unknown` pour le profil, le backend et le namespace temporaire.
Aucun processus ne démarre, mais le modèle perd la cause et l’action
`/sandbox capabilities grant editor`. Cela viole L4 et V6.

**Correction :** donner à `CapabilityError` une marque globale avec
`Symbol.for(...)`, vérifier un ensemble fermé de codes et le classifier avant le
cas `abnormal`. Associer chaque code à un message borné et actionnable. Conserver
dans la provenance le profil déjà résolu lors d’un refus de politique. Tester
chaque catégorie au point public `safe_bash`.

### F2 — MEDIUM — Un fichier Zed absent produit une erreur système générique

**Emplacement :** `agent/extensions/sandbox/capabilities/adapters.ts:171`.

Avec une capacité `editor` valide, `zed absent.ts` appelle `realpathSync()`.
`ENOENT` échappe au contrat `unsupported-command`. Après F1, ce scénario
resterait non actionnable si l’exception n’est pas normalisée.

**Correction :** convertir `ENOENT`, `ENOTDIR`, les erreurs d’accès et les
fichiers non réguliers en `CapabilityError("unsupported-command", ...)` avec le
message indiquant que Zed accepte seulement les fichiers existants du projet.
Ajouter un test public avec un fichier absent.

### F3 — MEDIUM — D2 n’est pas validé par le vrai outil Pi `bash`

**Emplacements :**

- `agent/extensions/sandbox/runtime/isolation-defaults.integration.test.ts:26`
- `agent/extensions/bash-execution/index.test.ts:171`
- `agent/extensions/sandbox/runtime/safe-bash-fork-contract.integration.test.ts:44`

Le test D1 principal appelle directement les opérations sandboxées. Le test du
propriétaire `bash` utilise des opérations simulées. Le seul parcours réunissant
le vrai `bash` et `safe_bash` est optionnel et dépend d’un service local.

Ce constat ne démontre pas un défaut runtime. Il laisse passer une régression
d’enregistrement, de hooks ou de routage du shell ordinaire D2.

**Correction :** ajouter un test `createTestSession` avec Sandbox et Bash
Execution, appeler le vrai outil `bash` dans une installation neuve, tenter un
listener hôte et une écriture interdite, puis vérifier absence de connexion,
contenu inchangé et provenance Zerobox avec `/tmp` privé.

### F4 — MEDIUM — Les succès des trois intégrations ne traversent pas Pi

**Emplacements :**

- `agent/extensions/bash-execution/capabilities.host-smoke.test.ts:12`
- `agent/extensions/bash-execution/capabilities.integration.test.ts:44`
- `agent/extensions/bash-execution/capabilities.integration.test.ts:87`

Les smokes Zed, SFW et Dev Services appellent directement
`prepareHostIntegration`. Ils ne traversent ni le schéma `safe_bash`, ni les
hooks Pi, ni la permission `bash`. Les tests Pi couvrent le refus Git et un
échec SFW simulé, mais aucun succès complet des trois capacités.

Ce constat est une lacune de preuve V5, pas un échec démontré des adaptateurs.

**Correction :** ajouter un test harness réussi par capacité avec des lanceurs
jetables approuvés et la provenance attendue. Conserver les smokes installés
optionnels, mais les déclencher par l’appel public `safe_bash`.

### F5 — MEDIUM — La révocation pendant une opération hôte n’est pas testée

**Emplacements :**

- `agent/extensions/sandbox/lifecycle.test.ts:528`
- `agent/extensions/bash-execution/capability-routing.test.ts:46`

Le drainage en vol est couvert pour une commande sandboxée. Dans le test hôte,
le processus finit avant la révocation. Le contrat V4 exige qu’une intégration
hôte déjà admise termine alors que l’appel suivant est bloqué.

**Correction :** faire démarrer une fixture Dev Services, attendre un marqueur,
révoquer pendant son exécution, vérifier que le premier appel finit et que le
second est refusé. Couvrir séparément timeout et annulation explicite.

### F6 — LOW — `migrate --session` annonce une sauvegarde inexistante

**Emplacements :**

- `agent/extensions/sandbox/capabilities/commands.ts:158`
- `agent/extensions/sandbox/capabilities/commands.ts:272`
- `agent/extensions/sandbox/capabilities/commands.ts:289`

Avec une autorité d’une autre machine, l’interface annonce que les anciens
accords seront archivés. En mode `--session`, le code ne sauvegarde ni n’archive
rien mais affiche `Migration saved`. Le fichier étranger reste inchangé.
Aucune capacité étrangère n’est activée, donc l’impact est informationnel.

**Correction :** annoncer « appliquée pour cette session, autorité étrangère
inchangée » en mode session. Réserver la promesse d’archive au mode persistant
et ajouter un test de régression.

## Conformité au plan

| Exigence            | État après revue                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| D1 / V1             | Confirmé par les tests Zerobox ciblés : réseau fermé, `/tmp` privé, aucun hôte automatique.                            |
| D2                  | Implémenté; preuve de bout en bout du vrai `bash` incomplète, voir F3.                                                 |
| D3                  | Profil hôte explicite et permission Git refusée couverts; succès des intégrations incomplets, voir F4.                 |
| L1                  | Résolveur partagé, état `Symbol.for`, autorité séparée et préférences restrictives présents. Revue de sécurité exclue. |
| L2 / V4             | Think strict, namespaces et drainage sandbox couverts; opération hôte en vol non couverte, voir F5.                    |
| L3 / V5             | Adaptateurs et argv littéral présents; succès complets hors chaîne Pi, voir F2 et F4.                                  |
| L4 / V6             | Permission avant processus et codes réels couverts; diagnostic de capacité cassé, voir F1.                             |
| Migration           | Alias et décision unique présents; message session incorrect, voir F6.                                                 |
| Modèles économiques | Scénarios livrés; campagne LLM volontairement non exécutée.                                                            |

## Vérifications indépendantes

La voie conformité a exécuté :

- suite ciblée principale : 191 réussites, aucun échec;
- contrat réel Safe Bash/Zerobox : 8 réussites, 5 parcours optionnels désactivés;
- provenance, `bash`, profils temporaires et résultats processus : 22 réussites;
- smokes hôte : 3 parcours désactivés;
- `tsc --noEmit -p tsconfig.sandbox.json` et `git diff --check` : réussis.

La voie runtime a exécuté :

- 148 tests déterministes ciblés dans 15 fichiers : tous réussis;
- `bun run typecheck` et le typecheck sandbox : réussis;
- lint ciblé : aucune erreur, avertissements existants;
- reproduction F1 au vrai outil Pi : défaut confirmé.

Une commande runtime trop large a rencontré des délais Docker puis a été
arrêtée avec le code 137. Elle ne sert pas de preuve d’acceptation. Les smokes
réels Zed, SFW réseau et Dev Services, les services hôte et la campagne LLM
n’ont pas été exécutés pendant la revue.

## Recommandation finale

Corriger F1 avant de considérer la livraison conforme : le modèle doit recevoir
la cause et l’action à entreprendre lorsqu’une capacité manque. Corriger F2 et
F6 dans le même lot de restitution. Ajouter ensuite les trois validations de
bout en bout F3 à F5. Le verdict pourra passer à `APPROVE` après ces corrections
et une nouvelle revue indépendante sans constat HIGH.

## Remédiation du 10 septembre 2026

Les six constats ont été corrigés et vérifiés dans le checkout d’origine. Le
verdict ci-dessus décrit la révision examinée par la revue indépendante; cette
section consigne les corrections ultérieures sans remplacer ce verdict par une
auto-approbation.

| Constat | Correction et preuve                                                                                                                                                                                                                                                   |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1      | `CapabilityError` utilise une marque globale, un ensemble fermé de codes et des diagnostics bornés. Le classificateur partagé conserve les messages actionnables et la provenance connue. Un test du vrai `safe_bash` couvre les six codes sans démarrer de processus. |
| F2      | L’adaptateur Zed normalise les chemins absents, inaccessibles, non réguliers ou hors projet en `unsupported-command`. Le cas fichier absent traverse le point public `safe_bash`.                                                                                      |
| F3      | Un test déterministe charge Sandbox et Bash Execution, appelle le vrai `bash` en profil intégré et vérifie réseau hôte inaccessible, autorité inchangée, backend Zerobox et `/tmp` privé.                                                                              |
| F4      | Les trois intégrations réussies traversent désormais le schéma public `safe_bash`, les hooks Pi et la permission `bash`. Les smokes installés optionnels utilisent aussi ce point public.                                                                              |
| F5      | Une fixture Dev Services reste active pendant la révocation : l’opération admise termine, l’appel suivant est refusé et le compteur revient à zéro. Timeout et annulation explicite sont couverts séparément.                                                          |
| F6      | `migrate --session` annonce une application de session et laisse l’autorité étrangère inchangée. Seule la migration persistante promet une sauvegarde et un archivage.                                                                                                 |

Une clarification ultérieure a supprimé le nom Zed du contrat `editor`. Les
nouvelles autorités enregistrent un `launcher` local sélectionné et le modèle
utilise `editor <fichier>`. Zed reste un fournisseur compatible et son ancienne
forme d’autorité reste lisible. Un test Pi réussi utilise un faux lanceur dont
le nom ne correspond à aucun éditeur connu.

Les vérifications finales donnent :

- suite transversale : **624 réussites, 8 parcours optionnels désactivés, aucun échec**, sur 632 tests dans 63 fichiers;
- suite ciblée de remédiation : **269 réussites, 8 parcours optionnels désactivés, aucun échec**;
- dernier contrôle F1/F2 après refactor : **36 réussites, aucun échec**;
- typecheck global et typecheck Sandbox : réussis;
- lint des fichiers de remédiation : aucune erreur; avertissements antérieurs conservés dans `authority.ts`.

Le lint global reste rouge sur des erreurs hors périmètre dans
`pi-overrides/pi-file-resolver.ts`, `flow-title.ts`, `_shared/config-loader.ts`
et `ai-providers/commands/providers.ts`. Les trois smokes hôte installés n’ont
pas été relancés pendant la remédiation; ils restent optionnels et leurs
derniers parcours réels réussis sont documentés dans le bilan de livraison.
