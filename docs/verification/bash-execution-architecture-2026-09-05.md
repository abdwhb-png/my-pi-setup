# Vérification de l'architecture d'exécution Bash — 5 septembre 2026

## Verdict

La refactorisation est acceptée dans son périmètre après correction des trois
findings de l'unique revue spécialisée. `bash-execution` est le seul propriétaire
des surfaces Bash, `sandbox` publie uniquement le runtime Zerobox atomique et
Think-in-Code dépend seulement des ports partagés. Les tests ciblés et l'E2E Pi
réel post-revue sont verts.

Les gates globaux du dépôt restent rouges à cause de changements déjà présents
hors de ce périmètre. Ils sont détaillés ci-dessous ; aucune de leurs erreurs
reproductibles ne pointe vers les nouveaux modules.

## Point de comparaison et déplacements

Avant la première modification, le statut Git détaillé et un manifeste SHA-256
de 117 fichiers suivis et non suivis ont été capturés sous
`/tmp/pi-bash-refactor-baseline.bbBz7p/`.

Les déplacements physiques ont été effectués avant les réécritures :

- `extensions/safe-bash` vers `extensions/bash-execution/safe-bash` ;
- `extensions/_shared/bash` vers
  `extensions/_shared/command-execution` ;
- les primitives neutres de `_shared/safe-execution` vers ce même module ;
- les contrats et ports partagés vers `_shared/sandbox-runtime`.

Le multiensemble des empreintes SHA-256 avant et après ces déplacements était
identique. Aucun commit intermédiaire n'a été créé.

## Ownership et dépendances

La recherche statique sur les sources de production trouve exactement :

- `bash` dans `extensions/bash-execution/builtin-bash.ts` ;
- `user_bash` dans `extensions/bash-execution/builtin-bash.ts` ;
- `safe_bash` dans `extensions/bash-execution/safe-bash/index.ts`.

Elle ne trouve aucun ancien chemin `_shared/bash` ou `_shared/safe-execution`,
aucun ancien broker `sandbox-bash`, `sandbox-analysis` ou service global Safe
Bash, et aucun import concret de Safe Bash, Bash Execution ou de
`sandbox/analysis` depuis Think-in-Code. Les anciens répertoires n'existent
plus.

Le runtime partagé utilise `Symbol.for("pi.sandbox-runtime.v2")`, publie Bash et
analyse en une affectation atomique, et protège la publication et la libération
par jeton propriétaire. Les états `enabled`, `disabled`, `uninitialized` et
`error`, le reload d'une ancienne instance et les diagnostics bornés sont
couverts par les tests publics.

## Tests ciblés

Après stabilisation et formatage des fichiers concernés :

```text
command-execution + sandbox-runtime + private-telemetry
+ bash-execution + think-in-code : 464 pass, 0 fail
sandbox                         : 165 pass, 0 fail
Total                           : 629 pass, 0 fail
```

Cette couverture inclut notamment :

- les quatre états du runtime pour `bash`, `user_bash`, `safe_bash` et Think ;
- les modes Safe Bash `replace` et `coexist` ;
- la publication atomique et l'ownership inter-reloads ;
- l'isolation bidirectionnelle des politiques et approbations Safe Bash/Think ;
- les superviseurs locaux et Zerobox indépendants ;
- les deux journaux, la redaction, les permissions, la rétention et les échecs
  d'écriture ;
- `/safe-bash-audit`, `/think-audit` et l'interdiction de tout outil pendant un
  audit Think ;
- la réinitialisation correcte du store de hooks Think entre deux
  `session_start` ;
- le script de purge en dry-run, apply, réapplication, fichiers purs, mixtes et
  événements v1.

La revue finale a signalé deux findings moyens et un faible. Chacun a été
reproduit par un test RED puis corrigé :

- une ancienne instance Sandbox nettoie maintenant ses propres services après
  la prise d'ownership d'une nouvelle instance, sans modifier son snapshot ;
- Safe Bash ignore les origines `think_execute` et `think_batch_execute` même
  lorsqu'elles utilisent le schéma v1, tout en conservant les événements v1
  sans origine ;
- la limite de 50 000 caractères couvre désormais le prompt `/think-audit`
  complet, enveloppe fixe comprise.

Le contrôle de format des fichiers concernés est vert. Oxlint ciblé termine
avec le code 0. Le typecheck complet ne rapporte aucune erreur sous
`bash-execution`, `sandbox`, `think-in-code`, `_shared/command-execution`,
`_shared/sandbox-runtime` ou `_shared/private-telemetry`.

## E2E avec le Pi installé

Commande acceptée :

```bash
./agent/extensions/think-in-code/e2e/real-pi/run.sh \
  /tmp/bash-execution-architecture-e2e-2026-09-05-v3
```

Versions observées :

- Pi `0.85.0` ;
- Bun `1.3.14` ;
- Zerobox `0.3.3-fork.8`, SHA-256
  `1623212b538f642c308250504c7a3ec6854471679e75dd4ff63b2d2bef43fcbb`.

Le test utilise la découverte normale des extensions, sans chemin d'extension
forcé. Dans une phase dédiée, le contexte provider contient exactement `bash`
et `safe_bash`. Les deux appels exécutent la même sonde et réussissent avec
`isError: false`. La sonde obtient `zerobox` uniquement parce que les deux
outils voient le `HOME` privé du runtime isolé et non le fichier de configuration
du projet dans le HOME réel. L'ancienne racine Safe Bash étant absente, cette
observation atteste aussi le chargement du nouvel entrypoint
`bash-execution/index.ts`.

La phase Think expose exactement les cinq outils suivants, sans outil `ctx_*` :

```text
think_index, think_search, think_execute, think_execute_file,
think_batch_execute
```

Ses sept appels d'outils terminent avec `isError: false`. Après la compaction
RPC réelle, le premier contexte contient un snapshot (`403` tokens estimés), le
second zéro. Les nouveaux processus de reload et de fork en contiennent aussi
zéro.

Toutes les sorties comptent zéro `extension_error` et zéro ancien symbole de
broker. Stderr contient uniquement l'avertissement CPA déjà connu de dérive de
catalogue (`54 new model(s), 4 missing fallback(s)`). Après le test, aucun
processus Pi, worker ou Zerobox correspondant ne reste vivant, aucun lease
`~/.pi/zbx/l-*` ne subsiste et la fixture `.smoke` est supprimée.

## Télémétrie et purge

Le relevé immédiatement antérieur à l'application était :

```text
files_scanned=89 files_changed=22 files_deleted=18
directories_deleted=1 think_events_removed=114 preserved_lines=3058
```

L'application a produit les mêmes nombres. Le dry-run final idempotent donne :

```text
files_scanned=71 files_changed=0 files_deleted=0
directories_deleted=0 think_events_removed=0 preserved_lines=3058
```

Aucune commande n'a été imprimée. Les 3 058 lignes Safe Bash ou historiques v1
ont été préservées. Aucun ancien événement Think n'a été migré et le nouveau
journal Think contient actuellement zéro fichier JSONL.

## Gates globaux hors périmètre

La suite complète a produit `4081 pass`, `32 fail` et `1 error` sur 4 113 tests.
Un test ciblé de 64 MiB sous Think a dépassé ponctuellement la limite de cinq
secondes pendant cette exécution chargée ; sa réexécution seule est verte en
`635.32 ms`. Les autres échecs concernent des fichiers déjà modifiés hors de la
refactorisation.

De même, `bun run typecheck` et `bun run lint` restent non nuls uniquement sur
des zones hors périmètre, dont `_shared/audit-mode`, `ai-providers`,
`audit-mode`, `ogulcancelik-pi-extensions`, `sdd-orchestrator`, `git` et
`pi-overrides`. Les contrôles ciblés des fichiers refactorisés sont verts.

## Bascule

Aucun shim d'ancien import ni fallback de politique Think vers Safe Bash n'est
conservé. Une nouvelle instance complète de Pi est requise pour charger les
nouveaux entrypoints et symboles globaux ; `/reload` n'est pas une procédure de
migration sûre.
