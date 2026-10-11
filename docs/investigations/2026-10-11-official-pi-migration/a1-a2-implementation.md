# A1/A2 — frontière commune sur pi-subagents 0.73.1

Date : 11 octobre 2026. L’implémentation et les corrections ont d’abord été qualifiées localement. La publication et l’installation GitHub, autorisées ensuite par l’utilisateur, sont décrites en P1–P4. Les décisions utilisateur remplacent les options ouvertes de l’enquête : seul pi-subagents mis à jour reste candidat pour la suite. Le fork pi-core est conservé et sa fusion avec l’officiel appartient à une étape ultérieure.

## Changements

- **D1 — Propriétaire commun.** `agent/extensions/_shared/subagents/index.ts` expose le contrat de délégation. SDD, la recherche et la vérification Brainstorm, les restrictions, le preflight, le conseil de fallback, l’overview et le wait guard utilisent ce propriétaire. Les transports foreground/RPC, les événements et les formats d’artefacts restent derrière cette frontière. Les états métier restent dans leurs extensions. L’overview et le wait guard restent configurés comme auparavant.
- **D2 — Résolution canonique.** Dans `~/engineering/pi-integrations/pi-subagents/src/agents/agents.ts`, les overrides des builtin sont appliqués dans l’ordre builtin → utilisateur → projet. Un projet qui ne définit que les outils conserve le modèle et le thinking utilisateur. Le résolveur existant conserve la provenance par champ, les variantes par provider, les scopes et la politique `disableThinking`. Pour un builtin, `thinking: false` efface le champ selon le contrat existant du package.
- **D3 — Exécution native.** Le package conserve la découverte, les modèles, les contrôles, les sessions enfant et la reprise. Il n’existe aucun deuxième registre d’exécution, backend générique ou pool ajouté. Les workflows JavaScript natifs et Fleet restent disponibles. Le fallback reste un conseil éphémère au parent, sans retry automatique.
- **D4 — Frontière vérifiée.** Le classificateur d’imports refuse `pi-subagents` et ses sous-chemins dans les consommateurs de production. Les imports natifs sont autorisés dans le propriétaire commun et dans les tests de compatibilité. Les anciens snapshots SDD restent lisibles.

## Contrat

| Code | API | Comportement |
|---|---|---|
| C1 | `run(request, options)` | Foreground avec corrélation request/owner/node, progrès, résultat texte ou structuré et usage connu. |
| C2 | `start(request)` | Agent détaché ou workflow déclaratif. Rend un `RunRef` lié à l’identité retournée par le runtime. |
| C3 | `inspect(ref)` / `wait(ref)` | Observation normalisée, événement terminal ou récupération depuis les artefacts du moteur. Un timeout/abort d’observation ne stoppe pas l’enfant. |
| C4 | `control(ref, command)` | Steer, interrupt ou stop. L’accusé de réception ne constitue pas une preuve de terminaison du processus. |
| C5 | `resume(ref, message)` | Reprise native avec le contrat enfant persisté, nouvelle référence et `resumedFrom`. Aucun modèle courant n’est réinjecté. |
| C6 | `subscribe(listener, ref?)` | Observation à la demande, corrélation session/run, déduplication et replay borné. Les consommateurs foreground/statut seuls ne retiennent pas les completions async étrangères. |
| C7 | `preflight(request, {projectTrusted?})` / `restrict(policy)` | Export public du package configuré selon la décision de confiance du runtime, plafond natif enregistré sous la clé fichier d’abord. Brainstorm plafonne les identités `allowedAgents`. Son allowlist read-only d’outils est transmise séparément par le binding tool-groups. |

La session propriétaire provient du `ping` natif, avec le fichier de session quand il existe. Un contrôle ou une reprise avec une référence étrangère est rejeté avant l’appel natif. Une mesure d’usage absente reste absente. Les contrôles et résultats métier ne remplacent pas les preuves natives de fermeture des processus et des leases.

Les workflows contiennent des stages ordonnés, chaque stage étant un ensemble parallèle d’items à clé unique. `{outputs.key}` sérialise la valeur structurée d’un stage précédent. Les références inconnues ou sans valeur structurée échouent explicitement. Un stage en échec arrête les suivants et conserve les résultats déjà obtenus. La vérification Brainstorm conserve aussi les succès des autres vérificateurs lorsqu’un vérificateur échoue et que l’avis n’a pas été lancé.

Le lecteur durable vérifie l’identifiant exact, la session, les versions de replay/receipt/archive, les bornes de lecture et l’absence de liens symboliques. Il récupère les résultats inline et les références de sortie publiées par le moteur. Il réutilise le parseur public Pi pour les sessions enfant. Il ne scanne pas les répertoires et ne reconstruit pas l’état d’exécution. Les lectures sont limitées à 1 MiB par fichier. Au-delà de la rétention native ou en présence d’un artefact absent/corrompu, l’observation ne peut pas inventer le résultat perdu.

Le protocole de fichiers est celui de 0.73.1. Le root vient de `PI_SUBAGENTS_TEMP_ROOT` ou du scope UID sous le répertoire temporaire sur le runtime Linux actuel. Une autre plateforme sans UID exige un root explicite. Le preflight résout la racine physique déclarée dans les packages et refuse plusieurs propriétaires distincts. Les consommateurs disposant d’un contexte transmettent `ctx.isProjectTrusted()`, y compris pour une approbation de session. Sans contexte explicite, le résolveur réutilise la décision de confiance persistée du propriétaire central de configuration. Le parcours filtre le scope projet avant de lire ses settings, de résoudre ses packages ou d’ouvrir leurs métadonnées. Les ceilings utilisent le registre global public, partagé entre copies de la même version du package.

## Qualification et baseline

Les fixtures utilisent le daily launcher et son core promu `0.87.1-00c5e7e300ba-51024884e6e0`, le package installé 0.73.1 comme référence, `dist-pkg` du correctif comme candidat, un fournisseur fictif déterministe et le vrai adaptateur MCP 3.0.0 relié à un serveur local. Chaque fixture possède son HOME, agentDir, projet et stockage de runs. Aucun appel fournisseur payant ni installation n’est effectué.

**V1 — Contrat enfant réel.** Le preflight du candidat résout le bon package. Les appels foreground programmatiques, async, outil LLM direct et workflow builtin utilisent réellement le modèle cible et le thinking `high`, avec les outils prévus. Après modification du modèle et du thinking dans la configuration temporaire, une reprise conserve ceux de l’enfant initial et sa lignée. Une nouvelle instance du client récupère aussi les résultats structurés terminés.

**V2 — Mesures.** Le runner effectue cinq échauffements puis vingt mesures par scénario et par bras, en alternant référence/candidat avec des parents conservés. Les cinq scénarios sont foreground, async simple, parallèle de trois enfants, stage dépendant et interrupt/resume. Les mesures portent sur la préparation, le premier appel fournisseur, l’événement de completion, les PIDs, le runtime et les appels MCP. Le RSS est échantillonné lors des appels fournisseur, ce n’est pas un pic mémoire continu. Le nombre de connexions réseau n’est pas instrumenté et vaut `null`, jamais zéro par défaut. Ces premières mesures ont été relevées pendant les vérifications locales et restent descriptives.

Le foreground mesuré utilise `read`. Avec cette version, le chemin foreground testé ne rendait pas le direct-tool MCP disponible. Les scénarios async utilisent le vrai MCP. L’async observé tourne sous Node et le parent/foreground sous Bun. A1/A2 ne modifie pas ce choix de runtime du package.

Les [200 mesures et la qualification](./a1-a2-baseline.json) sont conservées avec les racines réellement chargées. Elles précèdent les corrections de revue ci-dessous et n’ont pas été remesurées après celles-ci. Le scénario interrupt/resume a été remesuré après correction de la fixture pour attendre une réponse MCP effective avant l’interruption. Les latences ci-dessous vont de la demande à l’événement de completion, en millisecondes. Le p95 utilise le rang supérieur sur vingt mesures.

| Scénario | Référence p50 | Référence p95 | Candidat p50 | Candidat p95 | Processus enfants | Appels MCP |
|---|---:|---:|---:|---:|---:|---:|
| Foreground | 104 | 147 | 102 | 170 | 0 | 0 |
| Async simple | 3775 | 7808 | 3555 | 8732 | 1 | 1 |
| Parallèle × 3 | 6044 | 9823 | 6135 | 8941 | 3 | 3 |
| Stage dépendant | 11786 | 29773 | 11864 | 26570 | 4 | 4 |
| Interrupt/resume | 5012 | 6898 | 5280 | 6635 | 2 | 1 |

Les médianes sont proches et les workflows présentent une forte dispersion. Cette baseline ne démontre ni un gain de performance ni une stabilité suffisante pour une promotion quotidienne. Les nombres de processus et d’appels MCP sont identiques entre les deux bras pour chaque scénario.

Reproduction depuis `~/.pi/agent`, avec le candidat construit dans son propre dépôt par `npm run build:pkg` :

```sh
PI_SUBAGENTS_CANDIDATE_ROOT="$HOME/engineering/pi-integrations/pi-subagents/dist-pkg" PI_BASELINE_OUTPUT=/tmp/pi-delegation-baseline.json bun tooling/subagents/baseline.ts
PI_SUBAGENTS_CANDIDATE_ROOT="$HOME/engineering/pi-integrations/pi-subagents/dist-pkg" PI_BASELINE_OUTPUT=/tmp/pi-delegation-qualification.json PI_BASELINE_SAMPLES=0 PI_BASELINE_WARMUPS=0 PI_BASELINE_SCENARIOS=foreground PI_BASELINE_QUALIFICATION=extended bun tooling/subagents/baseline.ts
```

## Limites de validation

**V3 — Typecheck local.** Le seul échec restant dans le checkout courant concerne `pi-mcp-adapter/unix-socket-transport.ts`, avec `string | NonSharedBuffer` passé à une API Buffer. Le même diagnostic a été reproduit sur le worktree intact. Ce package géré n’a pas été modifié.

**V4 — Lint du package source.** Le lint des deux fichiers touchés rapporte 301 diagnostics, identiques après normalisation des positions sur le tag intact et sur le candidat. Les règles ne sont pas supprimées. Le correctif n’ajoute aucun diagnostic à ces fichiers. Le lint local de la frontière commune accepte des avertissements de parsing aux frontières de packages.

**V5 — Tests de cycle et concurrence.** Le test natif installé du cycle des tool-groups échoue au rechargement du ceiling, également sur le worktree intact. Un test de concurrence de `generated-tool-settings` a rencontré `ELOCKED` dans une passe groupée puis passé isolément et dans la dernière passe groupée. La première passe d’intégration du package en parallèle rapporte 50 échecs et un test annulé, avec de nombreux timeouts de démarrage ou de settlement. Le job resté actif a été interrompu. La passe complète séquentielle réussit avec 1 107 tests passés et 7 ignorés. Cette réussite ne prouve pas la stabilité de la commande parallèle par défaut. Les trois premiers scénarios en échec ont aussi passé isolément sur le tag intact puis sur le candidat.

## Bilan des commandes

| Code | Vérification | Résultat |
|---|---|---|
| V6 | Tests locaux de la frontière, SDD, Brainstorm, addons et classificateur | 773 passés, 2 ignorés, 0 échec, 62 fichiers. Les deux tests désactivés exigent un flag d’intégration explicite. |
| V7 | Tests du package source | Passe unitaire initiale : 3 430 passés, 13 ignorés, 0 échec. Après ajout de la matrice de provenance : 130 tests ciblés passés, 0 échec. |
| V8 | Intégration native complète séquentielle | 1 107 passés, 7 ignorés, 0 échec, 48 suites, environ vingt minutes. La commande parallèle initiale reste en échec, voir V5. |
| V9 | Build et diagnostics | `npm run build:pkg` et `npm run typecheck` passent dans le dépôt source. La frontière d’imports, le lint ciblé et `git diff --check` passent. Le lint conserve des avertissements. Le typecheck local reste bloqué par V3. |

Commandes finales des suites depuis leur racine respective :

```sh
# Depuis ~/.pi/agent
bun test --isolate extensions/_shared/subagents extensions/brainstorm-forcer extensions/sdd-orchestrator extensions/pi-subagents-addons tooling/extension-boundaries/extension-boundaries.test.mjs
bun run lint:boundaries
bun run typecheck

# Depuis ~/engineering/pi-integrations/pi-subagents
npm run typecheck
node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/unit/agent-overrides.test.ts test/unit/agent-disabled.test.ts test/unit/agent-eject-disable.test.ts test/unit/model-scope.test.ts
node --experimental-strip-types --import ./test/support/register-loader.mjs --test --test-concurrency=1 test/integration/*.test.ts
```

La suite agent entière et le lint agent entier n’ont pas été relancés. Les vérifications portent sur les consommateurs modifiés, leurs contrats partagés et le graphe global des frontières. Aucun résultat de ces fixtures ne vaut validation avec un fournisseur distant réel.

À la fin de cette première qualification, le candidat n’était ni publié ni installé. Les settings et changements personnels préexistants étaient conservés. Le correctif source restait sur la branche locale `codex/a1-a2-delegation` dans pi-integrations, sur la base 0.73.1. La publication et l’installation ultérieures sont décrites ci-dessous.


## Corrections après la revue L1–L5

Les findings F1–F8 ont été corrigés localement à la demande de l’utilisateur. Le rapport de revue initial reste historique. Aucune nouvelle revue déléguée n’a été lancée.

| Code | Correctif et régression |
|---|---|
| F1 | Le `session_start` Brainstorm diffère l’attachement pour laisser Pi initialiser le contexte natif. Un échec retire le run incomplet et conserve un avertissement ainsi que le pending métier pour retry. L’attachement inspecte aussi les artefacts natifs afin de récupérer une completion publiée avant l’abonnement. Tests du retry, de la récupération durable et de l’ordre des handlers via le vrai SDK Pi avec un transport déterministe. |
| F2 | La confiance persistée et la décision explicite du contexte atteignent le preflight et l’overview. Tests projet approuvé seul, veto explicite, approbation de session, plusieurs propriétaires physiques et déduplication des alias physiques. |
| F3 | Le filtre est appliqué dans le parcours canonique avant toute lecture du scope ignoré. Une fixture avec `package.json` FIFO reproduisait le blocage avant correction et termine maintenant sans ouvrir le FIFO. |
| F4 | Les flags natifs `interrupted` et `stopped` sont normalisés. Le replay hydrate les outcomes manquants depuis les steps du statut corrélé, sans remplacer une identité enfant exacte par une autre tentative du même workflow. La parité événement/payload/replay paused et stopped est vérifiée avec les vrais `toWaitCompletion` et `writeCompletionReplay` installés. |
| F5 | Inscription, lookup et preflight Brainstorm utilisent la clé native commune `sessionFile ?? sessionId`. L’UUID métier reste dans les snapshots. Test d’une session persistée dont fichier et UUID diffèrent, avec le vrai registre public de plafonds et vérification de sa libération. |
| F6 | Les listeners async sont installés à la demande. Les événements ne sont retenus que pour les références observées ou pendant la corrélation d’un reçu de lancement/reprise. Un résultat étranger ne peut plus évincer un terminal possédé. Les completions avant reçu et les diagnostics restent couverts. |
| F7 | Les attentes d’un même run partagent leur boucle de récupération dans une instance. Les validations de session simultanées partagent le ping en cours. Chaque timeout et abort demeure indépendant, et le dernier départ arrête le polling sans stopper l’enfant. |
| F8 | Le guard collecte les lookups littéraux `import.meta.resolve`. Le résolveur privé de l’overview est supprimé. Sa racine vient du propriétaire commun, avec la confiance du contexte. Le rendu d’un builtin d’un package projet temporaire et le graphe d’imports sont testés. |

**V10 — Validation des corrections.** La passe groupée exécute 806 tests passés, 2 ignorés, zéro échec et 3 354 assertions sur 66 fichiers. Elle inclut `_shared/package-install`, la frontière subagents, Brainstorm, SDD, les addons et le classificateur. Après le dernier ajustement de dispatch des listeners et de placement du helper de l’overview, les 57 tests concernés passent de nouveau. Le graphe global des frontières et le lint ciblé passent avec des avertissements. Le typecheck retrouve uniquement V3. Les fichiers personnels protégés conservent leurs 20 empreintes de revue.

**V11 — Qualification actuelle.** Le runner existant a relancé la qualification étendue avec zéro mesure et zéro échauffement. Ses six preuves couvrent le preflight, l’outil direct, le foreground, l’async, le workflow et la reprise avec le vrai candidat 0.73.1 et le daily core 0.87.1. Le modèle, le thinking, les outils, la lignée et la récupération durable passent. Les [preuves et mesures d’observation](./a1-a2-corrections-validation.json) conservent les racines chargées. Aucun fournisseur distant n’est utilisé.

**V12 — Observation mesurée.** Trois consommateurs sans intérêt async recevaient 384 appels de handlers et rejouaient chacun une completion étrangère. Après correction, les mêmes 128 événements ne déclenchent aucun handler dans ces consommateurs et aucun replay étranger. Huit attentes concurrentes de 1 050 ms sur le même run passent de 48 pings et 40 statuts à 6 pings et 5 statuts, avec huit timeouts dans les deux cas. Les échantillons heap/RSS sont conservés dans l’artefact, mais ne démontrent pas un gain mémoire physique stable. Le temps d’émission inclut la génération des données et ne mesure pas isolément le CPU des handlers. La période de récupération reste 250 ms, partagée par run dans une instance.

La baseline complète de lancement, la suite native séquentielle de vingt minutes, la suite agent entière et le lint agent entier n’ont pas été relancés pour ces corrections. Les limites V3–V5 restent visibles. La limite de cleanup des PIDs non observés par le fournisseur, signalée dans la revue, reste une qualification de panne à effectuer. Aucune fuite n’a été démontrée.

## Publication et installation GitHub

**P1 — Fork publié.** Le commit `c0ae7d70464d15eeac1944d7d5d8f2c4bcf00d5e` est publié sur `abdwhb-png/pi-subagents`, branche `codex/a1-a2-delegation`, avec le tag annoté `v0.73.1-a1a2.1`. Le tag et sa cible ont été vérifiés par l’API GitHub avant installation. Le manifeste conserve la version upstream `0.73.1`. Le tag et le SHA identifient la révision corrigée du fork.

**P2 — Installation possédée par Pi.** Le daily CLI a installé `git:github.com/abdwhb-png/pi-subagents@v0.73.1-a1a2.1`, puis retiré `npm:pi-subagents@0.73.1`. L’installation des dépendances est passée par le `npmCommand` existant, `sfw -- bun`, et quatre postinstallations sont restées bloquées par Bun. Une seule source pi-subagents est déclarée. `pi list`, le HEAD du clone et le lien `agent/node_modules/pi-subagents` confirment la racine `~/.pi/agent/git/github.com/abdwhb-png/pi-subagents`. Le core quotidien reste `0.87.1-00c5e7e300ba-51024884e6e0`. Seule la liste `packages` des settings a changé, avec le repositionnement habituel de tool-groups en dernier. Le retrait npm a retiré sa dépendance du manifeste géré et ses entrées de lock inutiles. La version `yaml@2.9.0`, déjà verrouillée auparavant, devient celle du root npm à la place de `2.8.3`. Le CLI Git calcule son dossier avec l’hôte et le chemin du dépôt, sans la référence. Le tag apparaît donc dans la déclaration, pas dans le dossier d’installation.

**P3 — Racine installée qualifiée.** Les 62 tests d’overrides du dépôt source et son typecheck passent à nouveau. Le lint retrouve les 301 diagnostics V4. La qualification étendue passe d’abord depuis le dépôt source, puis depuis le clone Git installé. Ses six preuves couvrent preflight, outil direct, foreground, async, workflow et interrupt/resume avec modèle, thinking, outils et récupération durable. Les [preuves de provenance et observations fournisseur](./a1-a2-github-installation.json) conservent la racine et le SHA. Aucun fournisseur distant payant n’est appelé et aucune baseline de latence n’est remesurée.

**P4 — Fixture runtime adaptée au package Git.** La première passe de 808 tests rapporte 805 succès, deux tests ignorés et un échec de fixture. Cette fixture chargeait le fichier privé `src/extension/index.js`, absent du dépôt Git. Elle charge désormais l’entrée publique résolue du package par le chargeur Pi. Son sous-processus dédié conserve l’isolation des globals. Le flag Bun 1.3.14 `--isolate` provoquait dans ce sous-processus l’appel de la factory avant la fin de son initialisation asynchrone. Le même scénario passe sans ce flag, avec les quatre tests runtime internes et leurs 30 assertions, puis le wrapper passe avec ses deux assertions. Les 805 autres tests n’ont pas été relancés après cette modification de fixture. Le graphe des frontières passe avec ses avertissements et le typecheck du harness reste limité à V3. Les fichiers personnels protégés, y compris la suppression préexistante de `agent/SYSTEM.md`, sont conservés. Une session Pi déjà ouverte doit être rechargée pour utiliser la nouvelle déclaration.

Commandes de remplacement exécutées depuis `~/.pi` :

```sh
pi install git:github.com/abdwhb-png/pi-subagents@v0.73.1-a1a2.1
pi remove npm:pi-subagents@0.73.1
pi list
```

Retour à la distribution npm, si demandé, en installant d’abord la source de remplacement :

```sh
pi install npm:pi-subagents@0.73.1
pi remove git:github.com/abdwhb-png/pi-subagents@v0.73.1-a1a2.1
```
