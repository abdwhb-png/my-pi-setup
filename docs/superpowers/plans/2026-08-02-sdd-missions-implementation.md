<!-- markdownlint-disable MD013 -->

# SDD Missions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construire une extension Pi `sdd-missions` qui transforme un objectif explicite en mission SDD planifiée, approuvée une fois, exécutée et validée de façon autonome, puis auto-applique son delta local validé sans commit.

**Architecture:** Une nouvelle extension mission-native possède le cycle de vie, les artefacts sous `<cwd>/.pi/sdd-missions/<mission-id>/`, la délégation durable, les Task Packets, les milestones, les validations et la livraison. `sdd-orchestrator` reste chargé uniquement pendant la construction comme donneur de transport, de worktree/locking et d'UI; aucune abstraction task-centric n'entre dans le nouveau domaine. Après parité et résolution des runs legacy, le cutover supprime entièrement l'ancien package, son rôle et ses agents spécifiques, tout en laissant `.sdd/` comme archive inerte.

**Tech Stack:** TypeScript strict, Pi `0.83.x`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `pi-subagents` delegation protocol v2 pour les nouvelles missions, TypeBox, Bun `1.3.x`, `bun:test`, `@abdwhb-png/pi-test-harness`, Git worktrees, `flock`, Oxlint.

## Global Constraints

- Exécuter depuis `~/.pi/agent`; Bun doit charger `agent/bunfig.toml`.
- Ne lancer ni commande `dev` ni commande `build`.
- Respecter RED → GREEN → REFACTOR pour chaque tâche. Aucune ligne de production avant l'observation du test rouge correspondant.
- Importer les modules réels dans les tests. Utiliser `mock.module()` avant un `await import()` dynamique seulement aux frontières Pi qui exigent un mock.
- Préserver tous les changements préexistants. Au moment de cette planification, `MEMORY.md`, `agent/extensions/subagent/config.json`, `agent/pi-session-recall.json` et `agent/prompts/delegate-subagents.md` sont modifiés hors de ce chantier. Refaire `git status --short` avant chaque commit et ne jamais les embarquer accidentellement.
- Ne jamais hardcoder `/home/<user>` dans un fichier suivi. Utiliser `~/...` dans la documentation et `homedir()`/`getAgentDir()` avant les I/O.
- La racine reste toujours `<cwd>/.pi/sdd-missions/<mission-id>/`; dans ce dépôt dont le cwd est `~/.pi`, le chemin concret est `~/.pi/.pi/sdd-missions/<mission-id>/`.
- Une tentative de recherche, planification, implémentation, correction ou validation utilise toujours `context: "fresh"`, un nouveau `requestId` et aucun transcript/session file antérieur.
- Les sorties de sous-agents sont des résultats structurés validés puis persistés par le contrôleur. Les agents ne possèdent pas `write_plan`, `edit_plan`, un shell d'écriture arbitraire d'artefacts de mission, ni un tool `subagent`.
- Les erreurs de transport, timeout, corrélation et structured output consomment uniquement le budget `infrastructure`; elles ne créent jamais de finding fonctionnel ni de correction de code.
- Le modèle utilisé pour borner un Task Packet doit être résolu dans le catalogue Pi courant. Ne jamais inventer `contextWindow`, `maxTokens`, un niveau de capacité ou un ordre d'escalade.
- L'intensité confirmée est un plancher. Un composant peut être élevé avec justification persistée, jamais abaissé silencieusement.
- `sdd-orchestrator` ne reçoit aucune nouvelle feature. Il ne change que pour extraire une primitive neutre ou maintenir sa compilation pendant la coexistence.
- Le cutover ne purge jamais `agent/.sdd/`. Cette purge est destructive et reste une opération séparée nécessitant une autorisation explicite.
- L'ancienne queue `sdd-mqxpovpu-8m9fgo` est actuellement `queued` à `0/8`; elle doit être explicitement résolue avant la suppression du package legacy.
- Les commits proposés ci-dessous sont locaux. Ne pas pousser, merger ou déployer.

## File Structure

### Primitive partagée extraite du donneur

- `agent/extensions/_shared/orchestration/delegation-client.ts` — transport Pi events v1/v2, validation des payloads, corrélation, deadline, annulation et disposal.
- `agent/extensions/_shared/orchestration/delegation-client.test.ts` — contrats du transport neutre, y compris v1 legacy et v2 mission.
- `agent/extensions/sdd-orchestrator/delegation-client.ts` — re-export de compatibilité temporaire; supprimé avec l'ancien package au cutover.

### Nouveau package `sdd-missions`

- `agent/extensions/sdd-missions/package.json` — package Pi et entrypoint.
- `agent/extensions/sdd-missions/types.ts` — types métier mission, milestone, feature, assertion, budget, délégation, baseline et delivery.
- `agent/extensions/sdd-missions/schemas.ts` — schémas TypeBox stricts et parseurs des résultats externes.
- `agent/extensions/sdd-missions/artifact-store.ts` — racine `<cwd>/.pi/sdd-missions`, confinement, CAS revision, journal append-only et projections.
- `agent/extensions/sdd-missions/state-machine.ts` — transitions légales et reducer idempotent.
- `agent/extensions/sdd-missions/budgets.ts` — compteurs indépendants et politique d'épuisement.
- `agent/extensions/sdd-missions/config.ts` — agents, routes de modèles explicites, timeouts, parallélisme et réserves de contexte.
- `agent/extensions/sdd-missions/model-policy.ts` — résolution factuelle d'un modèle Pi et sélection du prochain modèle explicitement configuré.
- `agent/extensions/sdd-missions/intensity.ts` — signaux versionnés et recommandation déterministe `light|standard|critical`.
- `agent/extensions/sdd-missions/baseline.ts` — inventaire Git, digests, sélection explicite des untracked et empreinte source.
- `agent/extensions/sdd-missions/workspace.ts` — worktree isolé matérialisé depuis le baseline, delta mission et auto-apply idempotent.
- `agent/extensions/sdd-missions/task-compiler.ts` — readiness gate et Task Packets bornés selon le modèle résolu.
- `agent/extensions/sdd-missions/delegation-gateway.ts` — protocole durable `planned → dispatched → terminal → applied` autour du transport partagé.
- `agent/extensions/sdd-missions/prompts.ts` — requêtes structurées par rôle, sans dump global des artefacts.
- `agent/extensions/sdd-missions/reconnaissance.ts` — reconnaissance courte et recommandation d'intensité.
- `agent/extensions/sdd-missions/planning-coordinator.ts` — recherches spécialisées, contrat de validation puis plan milestones/features.
- `agent/extensions/sdd-missions/execution-engine.ts` — scheduling, workers frais, TDD, self-verification et review locale critical.
- `agent/extensions/sdd-missions/validation-engine.ts` — scrutiny, black-box, fix features append-only et revalidation complète.
- `agent/extensions/sdd-missions/mission-runner.ts` — boucle autonome, reprise, pause, cancel, needs_decision, validation finale et livraison.
- `agent/extensions/sdd-missions/activity-store.ts` — projection live éphémère et redacted.
- `agent/extensions/sdd-missions/activity-ui.ts` — widget et overlay framed responsive.
- `agent/extensions/sdd-missions/review-ui.ts` — confirmation d'intensité et approbation native unique; fallback RPC-safe.
- `agent/extensions/sdd-missions/extension-tools.ts` — commande `/sdd-mission`, injection de statut et restrictions de tools.
- `agent/extensions/sdd-missions/index.ts` — composition runtime et entrypoint minimal.
- `agent/extensions/sdd-missions/*.test.ts` — tests ciblés colocated; `pi-runtime.integration.test.ts` pour la vraie frontière Pi.

### Agents à contexte frais

- `agent/agents/sdd-mission-researcher.md` — exploration read-only d'une seule question.
- `agent/agents/sdd-mission-contract-planner.md` — écrit uniquement un contrat de validation structuré.
- `agent/agents/sdd-mission-planner.md` — produit le graphe initial contre le contrat figé.
- `agent/agents/sdd-mission-worker.md` — implémente une feature ou fix feature bornée, TDD obligatoire.
- `agent/agents/sdd-mission-code-validator.md` — scrutiny read-only.
- `agent/agents/sdd-mission-behavior-validator.md` — validation black-box read-only selon les commandes autorisées.

### Surfaces de cutover

- Supprimer `agent/extensions/sdd-orchestrator/` en entier après le gate legacy.
- Supprimer `agent/roles/sdd-plan.md` et les agents legacy spécifiques.
- Mettre à jour `agent/settings.json`, `agent/settings.example.json`, `agent/prompts/delegate-subagents.md`, `agent/extensions/brainstorm-forcer/verification.test.ts` et les docs actives.
- Conserver les tool groups génériques et les documents historiques; les marquer superseded lorsque nécessaire au lieu de réécrire l'histoire.

---

### Task 1: Extraire le transport de délégation neutre sans casser le donneur

**Files:**

- Create: `agent/extensions/_shared/orchestration/delegation-client.test.ts`
- Create: `agent/extensions/_shared/orchestration/delegation-client.ts`
- Modify: `agent/extensions/sdd-orchestrator/delegation-client.ts`

- [ ] Écrire d'abord un test rouge qui importe le futur module partagé et couvre une requête v2 corrélée :

```ts
test("correlates a v2 response by owner, node, and request id", async () => {
    const events = new FakeEventBus();
    const client = new DelegationClient(events);
    const result = client.run({
        version: 2,
        requestId: "mission-1:feature-1:worker:1",
        ownerRunId: "mission-1",
        nodeId: "feature-1",
        agent: "sdd-mission-worker",
        task: "Implement feature-1",
        context: "fresh",
        cwd: "/tmp/worktree",
        result: { kind: "structured", schema: { type: "object" } },
    });

    events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, completedV2Response());
    await expect(result).resolves.toMatchObject({
        requestId: "mission-1:feature-1:worker:1",
        ownerRunId: "mission-1",
        nodeId: "feature-1",
        status: "completed",
    });
});
```

- [ ] Lancer `bun test extensions/_shared/orchestration/delegation-client.test.ts` et constater l'échec d'import du module absent.
- [ ] Déplacer le code validé de `sdd-orchestrator/delegation-client.ts` vers le module partagé, conserver la validation whitelist des payloads, et ajouter les unions/parseurs v2 depuis les types publics `pi-subagents/delegation`.
- [ ] Réduire le fichier legacy à ce re-export temporaire :

```ts
export * from "../_shared/orchestration/delegation-client.ts";
```

- [ ] Porter les tests legacy de corrélation, malformed payload, timeout, abort, late response et disposal vers le test partagé. Garder un test v1 pour prouver que `sdd-orchestrator` reste fonctionnel pendant la transition.
- [ ] Lancer `bun test extensions/_shared/orchestration/delegation-client.test.ts extensions/sdd-orchestrator/delegation-client.test.ts` et attendre deux suites vertes.
- [ ] Lancer `bun test --isolate extensions/sdd-orchestrator` pour vérifier que l'extraction n'a pas régressé le donneur.
- [ ] Refactorer uniquement les duplications du parseur v1/v2; relancer les deux commandes précédentes.
- [ ] Commit :

```bash
git add agent/extensions/_shared/orchestration agent/extensions/sdd-orchestrator/delegation-client.ts
git commit -m "refactor: share correlated delegation transport"
```

### Task 2: Définir le domaine mission-native et ses schémas stricts

**Files:**

- Create: `agent/extensions/sdd-missions/package.json`
- Create: `agent/extensions/sdd-missions/types.ts`
- Create: `agent/extensions/sdd-missions/schemas.ts`
- Create: `agent/extensions/sdd-missions/schemas.test.ts`

- [ ] Écrire des tests rouges qui exigent les phases, les états de feature, les six budgets locaux plus le global, le graphe milestones/features et le contrat d'assertions. Rejeter les propriétés inconnues et les IDs traversal-shaped.
- [ ] Lancer `bun test extensions/sdd-missions/schemas.test.ts`; l'import doit échouer avant création des sources.
- [ ] Définir le noyau sans importer `ParsedPlan`, `DraftManifest`, `RunSnapshot`, `TaskState` ou `ProfileBudget` :

```ts
export type MissionPhase =
    | "created"
    | "recognizing"
    | "awaiting_intensity_confirmation"
    | "exploring"
    | "planning"
    | "awaiting_approval"
    | "executing"
    | "validating_milestone"
    | "executing_fix_features"
    | "validating_mission"
    | "applying"
    | "paused"
    | "needs_decision"
    | "cancelled"
    | "failed"
    | "completed";

export type SddIntensity = "light" | "standard" | "critical";
export type FeatureState =
    | "planned"
    | "ready"
    | "implementing"
    | "self_verifying"
    | "completed";

export type BudgetBucket =
    | "exploration"
    | "planning"
    | "implementation"
    | "correction"
    | "validation"
    | "infrastructure"
    | "mission";
```

- [ ] Définir `MissionSnapshotV1`, `MilestoneV1`, `FeatureV1`, `ValidationAssertionV1`, `ValidationContractV1`, `MissionPlanV1`, `TaskPacketV1`, `MissionDelegationV1`, `BaselineV1` et `DeliveryReceiptV1` avec discriminants `version: 1`.
- [ ] Définir des schémas TypeBox `additionalProperties: false`, puis des parseurs qui retournent une union `{ ok: true; value } | { ok: false; issues }` au lieu de caster une sortie inconnue.
- [ ] Déclarer `package.json` avec `name: "sdd-missions"` et `pi.extensions: ["./index.ts"]`; ne pas encore créer l'entrypoint.
- [ ] Lancer `bun test extensions/sdd-missions/schemas.test.ts`; tous les cas valides et invalides doivent passer.
- [ ] Lancer `bun run typecheck`; il doit être vert avant commit.
- [ ] Commit :

```bash
git add agent/extensions/sdd-missions/package.json agent/extensions/sdd-missions/types.ts agent/extensions/sdd-missions/schemas.ts agent/extensions/sdd-missions/schemas.test.ts
git commit -m "feat: define sdd mission contracts"
```

### Task 3: Construire l'Artifact Store centralisé et inviolable

**Files:**

- Create: `agent/extensions/sdd-missions/artifact-store.ts`
- Create: `agent/extensions/sdd-missions/artifact-store.test.ts`

- [ ] Écrire les tests rouges avec dépôts temporaires pour la racine exacte `.pi/sdd-missions/<mission-id>/`, l'arborescence approuvée, la CAS revision, le journal hash-chain, la reconstruction de snapshot, les symlinks, le traversal, la corruption et l'altération d'un artefact figé.
- [ ] Lancer `bun test extensions/sdd-missions/artifact-store.test.ts` et constater l'échec d'import.
- [ ] Implémenter l'API suivante en adaptant les patterns `canonicalJson`, temp+rename, tickets et symlink guards du donneur, sans importer `SddStore` :

```ts
export interface MissionArtifactStore {
    create(input: CreateMissionInput): MissionSnapshotV1;
    load(missionId: string): MissionSnapshotV1 | null;
    list(): MissionSnapshotV1[];
    append(event: MissionEventV1, expectedRevision: number): MissionSnapshotV1;
    writeResearch(result: ResearchDigestV1): ArtifactReceipt;
    freezeApproval(bundle: ApprovedMissionBundleV1): ArtifactReceipt;
    writeFeatureResult(result: FeatureResultV1): ArtifactReceipt;
    writeValidation(result: ValidationResultV1): ArtifactReceipt;
    writeDelivery(receipt: DeliveryReceiptV1): ArtifactReceipt;
    rebuild(missionId: string): MissionSnapshotV1;
}
```

- [ ] Créer exactement `mission.json`, `baseline.json`, `brief.md`, `intensity.json`, `validation-contract.json`, `plan.json`, `events.jsonl`, `snapshot.json`, `research/`, `features/`, `validations/`, `evidence/` et `delivery/` sous la mission.
- [ ] Refuser toute racine `.pi/sdd-missions` ou mission traversée par un symlink; vérifier le propriétaire, le digest figé et `expectedRevision` avant écriture.
- [ ] Écrire l'événement complet et fsync-compatible avant de remplacer `snapshot.json`; chaque record contient `sequence`, `previousDigest`, `eventDigest`, `snapshotDigest` et `timestamp`.
- [ ] Exclure par construction `.pi/sdd-missions/` des API de fichiers source; l'Artifact Store n'accepte que des chemins relatifs d'artefacts connus.
- [ ] Lancer `bun test extensions/sdd-missions/artifact-store.test.ts`; attendre vert.
- [ ] Refactorer les helpers de canonicalisation/atomic write seulement à l'intérieur de `sdd-missions` tant qu'un second consommateur neutre n'existe pas.
- [ ] Commit :

```bash
git add agent/extensions/sdd-missions/artifact-store.ts agent/extensions/sdd-missions/artifact-store.test.ts
git commit -m "feat: add durable mission artifact store"
```

### Task 4: Implémenter la machine d'états, l'append-only graph et les budgets séparés

**Files:**

- Create: `agent/extensions/sdd-missions/state-machine.ts`
- Create: `agent/extensions/sdd-missions/state-machine.test.ts`
- Create: `agent/extensions/sdd-missions/budgets.ts`
- Create: `agent/extensions/sdd-missions/budgets.test.ts`

- [ ] Écrire des tests rouges pour toutes les transitions du cycle nominal, pause/resume, états terminaux, `needs_decision`, ajout de fix feature, split append-only, réponse dupliquée et mauvaise revision.
- [ ] Ajouter des tests rouges prouvant qu'un coût `structured_output_failed` touche `infrastructure` et `mission`, jamais `correction` ou `implementation`, et qu'aucun compteur unique `launches` n'existe.
- [ ] Lancer `bun test extensions/sdd-missions/state-machine.test.ts extensions/sdd-missions/budgets.test.ts`; constater les imports absents.
- [ ] Définir une transition événementielle exhaustive :

```ts
export function transitionMission(
    snapshot: MissionSnapshotV1,
    event: MissionEventV1,
): MissionSnapshotV1;

export function consumeBudget(
    budgets: MissionBudgetsV1,
    charge: { bucket: Exclude<BudgetBucket, "mission">; units: number; reason: string },
): MissionBudgetsV1;
```

- [ ] Encoder les seuls arcs autorisés. `completed`, `failed` et `cancelled` n'ont aucun arc sortant; `paused` conserve `pausedFrom`; `needs_decision` ne reprend qu'avec une décision typée liée au blocker courant.
- [ ] Autoriser après approbation uniquement `feature-added` avec `kind: "fix"`, `feature-split` qui conserve le parent comme superseded, et élévation d'intensité justifiée. Toute mutation de goal, contraintes ou assertion figée produit `needs_decision`.
- [ ] Dédupliquer par `event.idempotencyKey`; rejeter la même clé si le payload diffère.
- [ ] Lancer les deux tests jusqu'au vert puis `bun test extensions/sdd-missions/{schemas,artifact-store,state-machine,budgets}.test.ts`.
- [ ] Commit :

```bash
git add agent/extensions/sdd-missions/state-machine.ts agent/extensions/sdd-missions/state-machine.test.ts agent/extensions/sdd-missions/budgets.ts agent/extensions/sdd-missions/budgets.test.ts
git commit -m "feat: add mission reducer and budget ledger"
```

### Task 5: Résoudre factuellement modèles, routes et intensité

**Files:**

- Create: `agent/extensions/sdd-missions/config.ts`
- Create: `agent/extensions/sdd-missions/config.test.ts`
- Create: `agent/extensions/sdd-missions/model-policy.ts`
- Create: `agent/extensions/sdd-missions/model-policy.test.ts`
- Create: `agent/extensions/sdd-missions/intensity.ts`
- Create: `agent/extensions/sdd-missions/intensity.test.ts`

- [ ] Écrire les tests rouges de merge global/project pour `sddMissions`, de lecture normalisée de `subagent.agentOverrides`, de résolution exacte dans `ctx.modelRegistry.getAvailable()`, de route introuvable et d'escalade suivant uniquement l'ordre configuré.
- [ ] Écrire une table de cas rouge pour le rules engine : petites modifications locales sans surface runtime → `light`; multi-module ou migration → au moins `standard`; auth, données, sécurité, concurrence, delivery ou plusieurs surfaces runtime → `critical`.
- [ ] Lancer les trois tests ciblés et observer les imports absents.
- [ ] Implémenter :

```ts
export interface MissionModelRoute {
    readonly agent: string;
    readonly candidates: readonly string[];
}

export interface ResolvedMissionModel {
    readonly reference: string;
    readonly provider: string;
    readonly id: string;
    readonly contextWindow: number;
    readonly maxTokens: number;
    readonly routeIndex: number;
}
```

- [ ] Résoudre chaque candidate avec `findExactModelReferenceMatch(reference, modelRegistry.getAvailable())`. Persister les valeurs réelles du `Model`; ne jamais fournir de fallback numérique.
- [ ] Si aucun modèle configuré n'est disponible, produire `needs_decision` avant toute délégation. Une tentative répétée peut avancer vers `routeIndex + 1`; elle ne qualifie jamais ce modèle de « plus fort » sans configuration explicite.
- [ ] Définir les signaux d'intensité versionnés (`changedSurfaceCount`, `runtimeBoundaryCount`, `dataMigration`, `authOrSecurity`, `concurrency`, `delivery`, `unknownDecisionCount`, `blackBoxRequired`) avec cet ordre déterministe : `critical` si l'un de `dataMigration|authOrSecurity|concurrency|delivery` est vrai, ou si `blackBoxRequired` et `runtimeBoundaryCount >= 2`; sinon `standard` si `changedSurfaceCount >= 2`, `runtimeBoundaryCount >= 1` ou `unknownDecisionCount >= 1`; sinon `light`. Retourner recommandation, preuves et rule IDs.
- [ ] Garantir `effectiveIntensity = max(confirmedFloor, localElevation)` avec ordre `light < standard < critical`.
- [ ] Après production du plan, dériver les caps approuvés avec `F = featureCount`, `M = milestoneCount`, `C = criticalFeatureCount` :

| Intensité | Exploration | Planning | Implementation | Correction | Validation | Infrastructure |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| light | 1 | 2 | `F` | `max(1, ceil(F × 0.25))` | `2 × M` | `max(2, ceil(functional × 0.10))` |
| standard | 3 | 3 | `2 × F` | `max(2, ceil(F × 0.50))` | `4 × M` | `max(4, ceil(functional × 0.15))` |
| critical | 5 | 4 | `3 × F` | `max(3, F)` | `6 × M + C` | `max(6, ceil(functional × 0.20))` |

`functional` est la somme des cinq premiers caps et le cap global `mission` est leur somme avec `infrastructure`. Ces valeurs restent configurables mais leur valeur effective est figée dans le bundle d'approbation.
- [ ] Lancer `bun test extensions/sdd-missions/{config,model-policy,intensity}.test.ts`, puis les tests Tasks 2–4.
- [ ] Commit :

```bash
git add agent/extensions/sdd-missions/config.ts agent/extensions/sdd-missions/config.test.ts agent/extensions/sdd-missions/model-policy.ts agent/extensions/sdd-missions/model-policy.test.ts agent/extensions/sdd-missions/intensity.ts agent/extensions/sdd-missions/intensity.test.ts
git commit -m "feat: add factual mission model and intensity policies"
```

### Task 6: Adapter le worktree donneur aux baselines propres et sales

**Files:**

- Create: `agent/extensions/sdd-missions/baseline.ts`
- Create: `agent/extensions/sdd-missions/baseline.test.ts`
- Create: `agent/extensions/sdd-missions/workspace.ts`
- Create: `agent/extensions/sdd-missions/workspace.test.ts`

- [ ] Écrire des tests rouges sur des dépôts temporaires couvrant : HEAD propre, tracked modifié, deletion, untracked explicitement inclus, untracked exclu, fichier ignoré, candidat secret, `.pi/sdd-missions`, binaire, source drift, patch conflict, interrupted delivery et double apply.
- [ ] Ajouter un test rouge inter-processus qui reprend le pattern du donneur : un processus tient le `flock`, le second reçoit une erreur de lock stable, puis un successeur récupère après kill du propriétaire.
- [ ] Lancer `bun test extensions/sdd-missions/baseline.test.ts extensions/sdd-missions/workspace.test.ts`; constater l'échec.
- [ ] Implémenter les frontières suivantes en reprenant seulement les commandes Git argv, le patch binaire, le ledger, les checkpoints et `flock` de `sdd-orchestrator/workspace.ts` :

```ts
export function captureBaseline(
    cwd: string,
    input: { includeUntracked: readonly string[] },
): BaselineV1;

export class MissionWorkspaceManager {
    prepare(missionRoot: string, baseline: BaselineV1): Promise<MissionWorkspaceV1>;
    resolveExecutionCwd(workspace: MissionWorkspaceV1, sourceCwd: string): string;
    computeDelta(workspace: MissionWorkspaceV1): Promise<MissionDeltaV1>;
    apply(workspace: MissionWorkspaceV1, baseline: BaselineV1): Promise<DeliveryReceiptV1>;
}
```

- [ ] Capturer le commit, les statuts Git, les digests des tracked dirty et uniquement les untracked explicitement inclus. Refuser l'inclusion d'ignored, `.pi/sdd-missions`, des répertoires configurés `node_modules|dist|build|coverage|.next|.turbo|target`, et des candidats secrets `.env`, `.env.*` sauf `.env.example|.env.sample|.env.template`, `*.pem|*.key|*.p12|*.pfx`, `id_rsa`, `id_ed25519`, `credentials.json`, `service-account*.json`. Afficher chaque exclusion et sa rule ID dans le bundle d'approbation.
- [ ] Créer le worktree depuis le commit, puis matérialiser exactement le baseline approuvé avant le premier writer. Le delta final est calculé contre cet état matérialisé, pas contre `HEAD` seul.
- [ ] Placer le worktree sous `$XDG_STATE_HOME/pi/sdd-missions/worktrees/<repo-digest>/<mission-id>` ou le fallback basé sur `homedir()`. Garder ledgers, digests et receipts sous la racine de mission.
- [ ] Avant apply : recalculer l'empreinte pertinente, vérifier le patch sans mutation, enregistrer l'intent, appliquer sans staging/commit, puis enregistrer `applied` et le digest. Sur dérive ou collision : source inchangée, workspace conservé, `needs_decision`.
- [ ] Lancer les deux tests jusqu'au vert, puis l'ancienne `workspace.test.ts` pour prouver que le donneur n'a pas été modifié.
- [ ] Commit :

```bash
git add agent/extensions/sdd-missions/baseline.ts agent/extensions/sdd-missions/baseline.test.ts agent/extensions/sdd-missions/workspace.ts agent/extensions/sdd-missions/workspace.test.ts
git commit -m "feat: isolate missions from approved dirty baselines"
```

### Task 7: Compiler des Task Packets étroits et model-aware

**Files:**

- Create: `agent/extensions/sdd-missions/task-compiler.ts`
- Create: `agent/extensions/sdd-missions/task-compiler.test.ts`

- [ ] Écrire les tests rouges du readiness gate : objectif multiple, feature trop large, assertion sans méthode, dependency non satisfaite, fichier hors scope, décision interdite absente et paquet dépassant la limite du modèle.
- [ ] Écrire un test rouge prouvant qu'un modèle à petit `contextWindow` reçoit uniquement les preuves référencées et jamais `events.jsonl`, tous les résultats de recherche ou le transcript de la tentative précédente.
- [ ] Lancer `bun test extensions/sdd-missions/task-compiler.test.ts` et constater l'échec.
- [ ] Implémenter :

```ts
export interface CompileTaskPacketInput {
    readonly mission: ApprovedMissionViewV1;
    readonly feature: FeatureV1;
    readonly satisfiedDependencies: readonly FeatureEvidenceRefV1[];
    readonly applicableInstructions: readonly RepositoryInstructionV1[];
    readonly evidence: readonly EvidenceExcerptV1[];
    readonly model: ResolvedMissionModel;
}

export type CompileTaskPacketResult =
    | { readonly ready: true; readonly packet: TaskPacketV1; readonly estimatedTokens: number }
    | { readonly ready: false; readonly reasons: readonly ReadinessFailureV1[] };
```

- [ ] Le paquet contient exactement : objectif/résultat unique, feature ou question, assertions, dépendances satisfaites, fichiers/interfaces autorisés, instructions applicables, preuves nécessaires, commandes de vérification, décisions interdites et output schema.
- [ ] Estimer avec l'utilitaire public Pi `estimateTokens` sur le message réellement sérialisé. Calculer la limite à partir de `contextWindow` et des réserves `outputReserveTokens`, `toolReserveTokens`, `workspaceReserveRatio` validées par config; refuser/redécouper avant lancement si elle est dépassée.
- [ ] Ne jamais joindre de chemin de session, output complet précédent ou chaîne de raisonnement. Après échec, compiler seulement les erreurs observées, diff, findings et commandes persistés.
- [ ] Lancer le test jusqu'au vert puis `bun run typecheck`.
- [ ] Commit :

```bash
git add agent/extensions/sdd-missions/task-compiler.ts agent/extensions/sdd-missions/task-compiler.test.ts
git commit -m "feat: compile bounded mission task packets"
```

### Task 8: Encapsuler la délégation dans un protocole durable et idempotent

**Files:**

- Create: `agent/extensions/sdd-missions/delegation-gateway.ts`
- Create: `agent/extensions/sdd-missions/delegation-gateway.test.ts`

- [ ] Écrire les tests rouges pour `request_planned → request_dispatched → terminal_response_recorded → response_applied`, réponse terminale déjà disponible au restart, réponse dupliquée, writer incertain, timeout, invalid structured output et corrélation owner/node/request incorrecte.
- [ ] Lancer `bun test extensions/sdd-missions/delegation-gateway.test.ts`; constater l'échec.
- [ ] Implémenter une seule API externe :

```ts
export interface MissionDelegationGateway {
    execute<T>(request: MissionDelegationRequestV1<T>): Promise<MissionDelegationOutcomeV1<T>>;
    reconcile(requestId: string): MissionDelegationReconciliationV1;
    cancel(requestId: string): void;
    dispose(): void;
}
```

- [ ] Persister `request_planned` avec mission/entity/stage/attempt, agent, modèle résolu, digest du Task Packet et idempotency key avant l'event Pi. Persister `request_dispatched` immédiatement avant `emit`.
- [ ] Utiliser une requête `SubagentDelegationV2Request` avec `ownerRunId = missionId`, `nodeId = entityId`, `context: "fresh"` et `result.kind = "structured"`.
- [ ] Valider le résultat localement, puis persister la réponse terminale brute bornée/redacted avant toute transition fonctionnelle. Une deuxième application de la même réponse est no-op.
- [ ] Appliquer la récupération déterministe : validation locale → une réparation de protocole bornée → remplacement frais suivant la route configurée → `needs_decision` après échecs indépendants répétés.
- [ ] Si un writer `request_dispatched` n'a aucune preuve terminale et peut encore écrire, retourner `uncertain_writer`; ne jamais le relancer automatiquement.
- [ ] Lancer le test jusqu'au vert et la suite du transport partagé.
- [ ] Commit :

```bash
git add agent/extensions/sdd-missions/delegation-gateway.ts agent/extensions/sdd-missions/delegation-gateway.test.ts
git commit -m "feat: persist mission delegation boundaries"
```

### Task 9: Ajouter reconnaissance bornée et confirmation d'intensité

**Files:**

- Create: `agent/extensions/sdd-missions/prompts.ts`
- Create: `agent/extensions/sdd-missions/prompts.test.ts`
- Create: `agent/extensions/sdd-missions/reconnaissance.ts`
- Create: `agent/extensions/sdd-missions/reconnaissance.test.ts`
- Create: `agent/agents/sdd-mission-researcher.md`

- [ ] Écrire les tests rouges : la reconnaissance ne mute rien, pose seulement des questions factuelles bornées, persiste ses digests, produit les signaux du rules engine et s'arrête à `awaiting_intensity_confirmation`.
- [ ] Vérifier dans le test d'agent que le frontmatter contient `defaultContext: fresh`, `acceptanceRole: read-only`, aucun `write`, aucun `subagent`, et uniquement des tools inspect/research nécessaires.
- [ ] Lancer les tests ciblés et constater les échecs.
- [ ] Construire la requête de reconnaissance depuis le goal, le cwd, les instructions repo applicables, l'état Git et les surfaces détectées. Ne pas inclure les futurs artefacts vides ni toute la session principale.
- [ ] Limiter la reconnaissance par budget/intensité initiale fixe de bootstrap : inspection locale de structure, test/lint/typecheck disponibles, risques et incertitudes. Elle ne décide pas encore la feature graph.
- [ ] Écrire `brief.md`, `research/reconnaissance.json` et `intensity.json` avec recommendation, rules déclenchées, preuves et `confirmed: false`.
- [ ] Exposer `confirmIntensity(missionId, selected, actor)` qui persiste `confirmedFloor` et une justification obligatoire si le choix diffère de la recommandation.
- [ ] Lancer `bun test extensions/sdd-missions/prompts.test.ts extensions/sdd-missions/reconnaissance.test.ts`; attendre vert.
- [ ] Commit :

```bash
git add agent/extensions/sdd-missions/prompts.ts agent/extensions/sdd-missions/prompts.test.ts agent/extensions/sdd-missions/reconnaissance.ts agent/extensions/sdd-missions/reconnaissance.test.ts agent/agents/sdd-mission-researcher.md
git commit -m "feat: recommend and confirm mission intensity"
```

### Task 10: Intégrer exploration, contrat de validation, plan et approbation unique

**Files:**

- Create: `agent/extensions/sdd-missions/planning-coordinator.ts`
- Create: `agent/extensions/sdd-missions/planning-coordinator.test.ts`
- Create: `agent/agents/sdd-mission-contract-planner.md`
- Create: `agent/agents/sdd-mission-planner.md`

- [ ] Écrire les tests rouges pour : questions d'exploration distinctes, un contexte frais par question, digests plutôt que transcripts, contrat produit avant plan, couverture assertion→milestone, dépendances acycliques, budgets initialisés et bundle d'approbation stable.
- [ ] Ajouter un test rouge qui rejette un plan si une feature n'a pas d'assertion, vérification, scope de fichiers/interfaces ou décisions interdites.
- [ ] Lancer `bun test extensions/sdd-missions/planning-coordinator.test.ts`; constater l'échec.
- [ ] Implémenter la séquence exacte :

```text
exploration questions
  -> research digests
  -> validation-contract.json
  -> milestone/feature plan.json
  -> baseline.json
  -> approval bundle digest
  -> awaiting_approval
```

- [ ] Déléguer chaque question à une tentative fraîche et bornée. Le coordinator agrège `{facts, sources, uncertainties, missionImpact}`; il ne persiste pas les raisonnements ni ne réinjecte les transcriptions.
- [ ] Faire produire le contrat avant le plan. Chaque assertion a `id`, expected behavior, preconditions, validation method, expected evidence, responsible milestone et coverage status.
- [ ] Faire produire le plan ensuite avec milestones cohérentes et features ayant dependencies, assertions, file/interface scope, verify commands et forbidden decisions.
- [ ] Construire un bundle immuable contenant goal, contraintes, intensity floor, research digests, contrat, plan initial, budgets, baseline et `autoApplyAuthorized: true`.
- [ ] Après `approveMission(bundleDigest, actor)`, écrire tous les artefacts figés atomiquement et passer à `executing`. Toute différence de digest est refusée.
- [ ] Lancer le test jusqu'au vert et les tests Tasks 2–9.
- [ ] Commit :

```bash
git add agent/extensions/sdd-missions/planning-coordinator.ts agent/extensions/sdd-missions/planning-coordinator.test.ts agent/agents/sdd-mission-contract-planner.md agent/agents/sdd-mission-planner.md
git commit -m "feat: plan and freeze approved missions"
```

### Task 11: Exécuter les features avec scheduling sûr et contextes frais

**Files:**

- Create: `agent/extensions/sdd-missions/execution-engine.ts`
- Create: `agent/extensions/sdd-missions/execution-engine.test.ts`
- Create: `agent/agents/sdd-mission-worker.md`

- [ ] Écrire les tests rouges pour dependencies, scopes d'écriture disjoints, max concurrency par intensité, readiness refusal, TDD evidence, critical local review gate, blocked decision et nouveau request/session par tentative.
- [ ] Ajouter un test qui place un marqueur unique dans le résultat de tentative 1 et vérifie que le texte de requête de tentative 2 ne le contient pas; seuls finding/diff/erreurs persistés sont présents.
- [ ] Lancer `bun test extensions/sdd-missions/execution-engine.test.ts`; constater l'échec.
- [ ] Implémenter :

```ts
export function selectReadyFeatureBatch(
    plan: MissionPlanV1,
    snapshot: MissionSnapshotV1,
    maxConcurrentWriters: number,
): readonly FeatureV1[];

export class MissionExecutionEngine {
    runFeature(missionId: string, featureId: string): Promise<FeatureExecutionOutcomeV1>;
    runReadyBatch(missionId: string): Promise<readonly FeatureExecutionOutcomeV1[]>;
}
```

- [ ] Deux writers ne se chevauchent que si dependencies satisfaites et scopes d'écriture disjoints. Une interface partagée, un chemin parent ou un scope inconnu impose la sérialisation.
- [ ] Compiler le Task Packet avant chaque launch; si `ready: false`, append split/clarification autorisé ou passer `needs_decision`, jamais lancer une tâche ambiguë.
- [ ] Le worker suit RED-GREEN-REFACTOR et retourne changed files, failing test observed, commands, validation output et residual risks selon le schema. L'engine vérifie que le delta reste dans l'allowlist.
- [ ] Les features `critical` reçoivent une review locale read-only fraîche; les autres attendent la validation milestone.
- [ ] Le frontmatter worker expose seulement inspect/lens-write/implement, `defaultContext: fresh`, aucun `subagent`, aucun tool d'artefact mission.
- [ ] Lancer le test jusqu'au vert puis `bun run typecheck`.
- [ ] Commit :

```bash
git add agent/extensions/sdd-missions/execution-engine.ts agent/extensions/sdd-missions/execution-engine.test.ts agent/agents/sdd-mission-worker.md
git commit -m "feat: execute bounded mission features"
```

### Task 12: Valider les milestones et convertir les findings en fix features

**Files:**

- Create: `agent/extensions/sdd-missions/validation-engine.ts`
- Create: `agent/extensions/sdd-missions/validation-engine.test.ts`
- Create: `agent/agents/sdd-mission-code-validator.md`
- Create: `agent/agents/sdd-mission-behavior-validator.md`

- [ ] Écrire les tests rouges pour scrutiny + black-box indépendants, méthodes navigateur/TUI/service conditionnelles, finding blocking, fix feature append-only, revalidation du milestone entier et erreur de protocole sans fix feature.
- [ ] Ajouter un test rouge où le validator retourne du JSON invalide : le budget infrastructure augmente, `correction` reste inchangé, aucun writer n'est lancé.
- [ ] Lancer `bun test extensions/sdd-missions/validation-engine.test.ts`; constater l'échec.
- [ ] Définir :

```ts
export class MissionValidationEngine {
    validateMilestone(missionId: string, milestoneId: string): Promise<MilestoneValidationOutcomeV1>;
    validateMission(missionId: string): Promise<MissionValidationOutcomeV1>;
    compileFixFeature(finding: BlockingFindingV1): FeatureV1;
}
```

- [ ] Lancer deux contextes frais distincts : code scrutiny et comportement black-box. Ne lancer navigateur, TUI ou service réel que si `validation-contract.json` le demande et que le readiness check de l'environnement passe.
- [ ] Une fix feature référence exactement `findingId`, `assertionId`, validator request, fichiers/interfaces autorisés et verify commands. Elle ne peut modifier goal, contrainte ou contrat.
- [ ] Après toute correction, repasser toutes les assertions du milestone, pas uniquement celle qui a échoué.
- [ ] Un résultat `blocked` sans finding valide devient un problème de protocole. Un véritable blocker hors contrat devient `needs_decision`.
- [ ] Les validator agents sont read-only, `defaultContext: fresh`, sans tool d'écriture source et sans délégation.
- [ ] Lancer le test jusqu'au vert et les tests execution/gateway/budgets.
- [ ] Commit :

```bash
git add agent/extensions/sdd-missions/validation-engine.ts agent/extensions/sdd-missions/validation-engine.test.ts agent/agents/sdd-mission-code-validator.md agent/agents/sdd-mission-behavior-validator.md
git commit -m "feat: validate mission milestones with fix features"
```

### Task 13: Orchestrer la mission autonome, la reprise et la livraison

**Files:**

- Create: `agent/extensions/sdd-missions/mission-runner.ts`
- Create: `agent/extensions/sdd-missions/mission-runner.test.ts`

- [ ] Écrire les tests rouges du cycle complet, pause/resume, cancel, budget global, restart après dispatch, restart après terminal record, restart après apply, uncertain writer et auto-apply sans seconde approbation.
- [ ] Lancer `bun test extensions/sdd-missions/mission-runner.test.ts`; constater l'échec.
- [ ] Implémenter une boucle déterministe qui avance jusqu'au prochain gate utilisateur réel ou état terminal :

```ts
export class MissionRunner {
    start(goal: string, ctx: ExtensionContext): Promise<MissionSnapshotV1>;
    continue(missionId: string, ctx: ExtensionContext): Promise<MissionSnapshotV1>;
    pause(missionId: string, actor: string): MissionSnapshotV1;
    resume(missionId: string, ctx: ExtensionContext): Promise<MissionSnapshotV1>;
    cancel(missionId: string, actor: string): Promise<MissionSnapshotV1>;
    reconcile(missionId: string): MissionSnapshotV1;
}
```

- [ ] `start` crée la mission puis lance reconnaissance. `continue` appelle le composant correspondant à la phase; il ne demande jamais au LLM de choisir une transition.
- [ ] S'arrêter uniquement à confirmation d'intensité, approbation, permission/secret manquant, action irréversible hors autorité, scope/contract change, uncertain writer, blocage indépendant répété ou budget global épuisé.
- [ ] Après validation mission, passer à `applying` et appeler `workspace.apply` parce que l'approbation initiale contient `autoApplyAuthorized: true`. Ne créer ni commit ni push.
- [ ] Au restart, lire d'abord le journal et les réponses terminales corrélées. Ne recompter aucun budget et ne recréer aucun finding/delivery receipt.
- [ ] Ignorer tout `session_start` dans un enfant lorsque `PI_SUBAGENT_CHILD === "1"`.
- [ ] Lancer le test jusqu'au vert, puis tous les tests `extensions/sdd-missions` existants.
- [ ] Commit :

```bash
git add agent/extensions/sdd-missions/mission-runner.ts agent/extensions/sdd-missions/mission-runner.test.ts
git commit -m "feat: run and resume autonomous sdd missions"
```

### Task 14: Réutiliser les framed boxes pour review, live activity et widget

**Files:**

- Create: `agent/extensions/sdd-missions/review-ui.ts`
- Create: `agent/extensions/sdd-missions/review-ui.test.ts`
- Create: `agent/extensions/sdd-missions/activity-store.ts`
- Create: `agent/extensions/sdd-missions/activity-store.test.ts`
- Create: `agent/extensions/sdd-missions/activity-ui.ts`
- Create: `agent/extensions/sdd-missions/activity-ui.test.ts`

- [ ] Écrire les tests rouges pour l'écran de confirmation d'intensité, l'approbation montrant toutes les valeurs figées, le fallback non-TUI, le widget borné, redaction, stale updates, reload history notice, low width/height et dispose.
- [ ] Porter les tests d'interaction du donneur : navigation/dismissal legacy et Kitty CSI-u, visual-row scrolling, sélection clampée et `requestRender()` après chaque état visible.
- [ ] Lancer les trois tests ciblés et constater les échecs.
- [ ] Construire review/live avec `../_shared/ui/framed-panels.ts`, `focus-navigation.ts`, `ui-colors.ts` et `../_shared/redaction.ts`; ne copier aucune primitive framed.
- [ ] L'approbation affiche goal/contraintes, intensity floor, research digests, assertions, milestones/features, budgets, baseline inclusions/exclusions et auto-apply. Le résultat est `{ type: "approve"; bundleDigest; actor } | { type: "cancel" }`.
- [ ] En TUI utiliser `ctx.ui.custom`; en RPC/print/json utiliser uniquement `ctx.ui.select`, `confirm`, `input` ou notification textuelle selon `ctx.hasUI`. Ne jamais appeler `custom` hors TUI.
- [ ] L'activité live reste en mémoire. Elle corrèle mission/milestone/feature/request, borne tools/output, refuse les révisions anciennes et ne peut pas appeler l'Artifact Store.
- [ ] Le widget `sdd-missions-live` montre phase, milestone, feature/validator et budgets; après reload il n'invente pas d'historique live.
- [ ] Lancer les tests jusqu'au vert puis les tests partagés framed/redaction.
- [ ] Commit :

```bash
git add agent/extensions/sdd-missions/review-ui.ts agent/extensions/sdd-missions/review-ui.test.ts agent/extensions/sdd-missions/activity-store.ts agent/extensions/sdd-missions/activity-store.test.ts agent/extensions/sdd-missions/activity-ui.ts agent/extensions/sdd-missions/activity-ui.test.ts
git commit -m "feat: add framed mission review and live activity"
```

### Task 15: Enregistrer `/sdd-mission` et imposer le flow déterministe

**Files:**

- Create: `agent/extensions/sdd-missions/extension-tools.ts`
- Create: `agent/extensions/sdd-missions/extension-tools.test.ts`
- Create: `agent/extensions/sdd-missions/index.ts`
- Create: `agent/extensions/sdd-missions/index.test.ts`

- [ ] Écrire les tests rouges affirmant une seule commande `sdd-mission`, ses sous-commandes, l'absence de nouveaux tools `prepare/approve/apply`, l'injection compacte de phase et le blocage de `write_plan`, `edit_plan` et `subagent` dans la session propriétaire.
- [ ] Ajouter un test Jiti rouge et un test de composition runtime avec Store, Gateway, Workspace, Coordinator, Engines, Runner et Activity.
- [ ] Lancer `bun test extensions/sdd-missions/extension-tools.test.ts extensions/sdd-missions/index.test.ts`; constater les échecs.
- [ ] Enregistrer exactement :

```text
/sdd-mission <goal>
/sdd-mission status [id]
/sdd-mission review [id]
/sdd-mission pause [id]
/sdd-mission resume [id]
/sdd-mission cancel [id]
/sdd-mission live [id]
```

- [ ] La commande nue démarre immédiatement reconnaissance → confirmation intensité → exploration/planning → approbation → exécution autonome. Elle ne demande aucun `/prepare`, polling ou changement de rôle.
- [ ] Les outputs structurés de sous-agents sont ingérés par le Gateway puis écrits par l'Artifact Store; ne pas enregistrer `write_plan`/`edit_plan` alternatifs pour les missions.
- [ ] Dans `tool_call`, bloquer les tools génériques de planification/délégation uniquement pour la session propriétaire d'une mission active. Ne pas appliquer ce hook aux enfants `PI_SUBAGENT_CHILD` ni aux opérations non liées à la mission.
- [ ] Dans `context`/`before_agent_start`, remplacer l'ancien statut par un message display-only compact : mission, phase, prochain gate, artefact attendu et action autorisée.
- [ ] Au `session_start` startup/reload/resume, réconcilier seulement les missions du `ctx.cwd`; au shutdown, retirer widget/subscriptions et disposer le transport.
- [ ] Lancer les tests jusqu'au vert, `bun run typecheck`, puis `bun test --isolate extensions/sdd-missions`.
- [ ] Commit :

```bash
git add agent/extensions/sdd-missions/extension-tools.ts agent/extensions/sdd-missions/extension-tools.test.ts agent/extensions/sdd-missions/index.ts agent/extensions/sdd-missions/index.test.ts
git commit -m "feat: register deterministic sdd mission flow"
```

### Task 16: Prouver les scénarios complets et la vraie frontière Pi

**Files:**

- Create: `agent/extensions/sdd-missions/sdd-missions.integration.test.ts`
- Create: `agent/extensions/sdd-missions/pi-runtime.integration.test.ts`

- [ ] Écrire d'abord un scénario rouge multi-milestones avec un modèle à petit contexte, une feature critical, un finding bloquant, une fix feature, revalidation, validation mission et auto-apply sur baseline dirty.
- [ ] Ajouter des scénarios rouges restart/cancel/late response, protocole invalide réparé puis remplacé, deux writers disjoints, overlap sérialisé et source drift avant apply.
- [ ] Ajouter un test Pi harness rouge qui exécute `/sdd-mission status` ou la frontière command correspondante dans une vraie session et vérifie que le résultat n'est pas mocked.
- [ ] Lancer les deux tests et observer les échecs fonctionnels avant les derniers ajustements d'intégration.
- [ ] Compléter uniquement le wiring nécessaire. Les assertions obligatoires sont :

```ts
expect(allRequests.every((request) => request.context === "fresh")).toBe(true);
expect(new Set(allRequests.map((request) => request.requestId)).size).toBe(allRequests.length);
expect(snapshot.budgets.infrastructure.used).toBeGreaterThan(0);
expect(snapshot.budgets.correction.used).toBe(1);
expect(snapshot.phase).toBe("completed");
expect(readFileSync(sourceFile, "utf8")).toContain("validated mission change");
expect(git(source, ["log", "-1", "--pretty=%s"])).toBe(originalCommitSubject);
```

- [ ] Vérifier qu'un marker de transcript de tentative 1 est absent de toutes les requêtes suivantes.
- [ ] Vérifier que `.pi/sdd-missions` n'apparaît dans aucun patch et qu'une erreur d'observer ne change ni snapshot ni verdict.
- [ ] Lancer `bun test --isolate extensions/sdd-missions` puis `bun run typecheck`.
- [ ] Commit :

```bash
git add agent/extensions/sdd-missions/sdd-missions.integration.test.ts agent/extensions/sdd-missions/pi-runtime.integration.test.ts
git commit -m "test: prove end-to-end sdd mission execution"
```

### Task 17: Effectuer le cutover et supprimer `sdd-orchestrator`

**Files:**

- Create: `agent/extensions/sdd-missions/legacy-cutover.ts`
- Create: `agent/extensions/sdd-missions/legacy-cutover.test.ts`
- Create: `agent/extensions/sdd-missions/cutover.integration.test.ts`
- Modify: `agent/settings.json`
- Modify: `agent/settings.example.json`
- Modify: `agent/prompts/delegate-subagents.md`
- Modify: `agent/extensions/brainstorm-forcer/verification.test.ts`
- Modify: `docs/adr/ADR-011-sdd-live-run-observability.md`
- Modify: `docs/plans/2026-07-21-modular-deterministic-sdd-design.md`
- Modify: `docs/plans/2026-07-22-sdd-validation-agents-design.md`
- Delete: `agent/extensions/sdd-orchestrator/`
- Delete: `agent/roles/sdd-plan.md`
- Delete: `agent/agents/sdd-orchestrator.md`
- Delete: `agent/agents/orchestration-assessor.md`
- Delete: `agent/agents/sdd-worker.md`
- Delete: `agent/agents/sdd-combined-reviewer.md`
- Delete: `agent/agents/sdd-spec-reviewer.md`
- Delete: `agent/agents/sdd-quality-reviewer.md`

- [ ] Écrire un test rouge de préflight avec fixtures `.sdd` : `completed`, `failed`, `cancelled` et ancien `needs_input` sans transition sortante sont archivables; queue/progress `queued` bloque le cutover et retourne le run ID exact.
- [ ] Écrire un test d'absence rouge qui échouera tant que l'ancien package existe et qui recherche les huit tools (`sdd_prepare`, `sdd_submit`, `sdd_approve`, `sdd_status`, `sdd_result`, `sdd_apply`, `sdd_cancel`, `sdd_direct_complete`), les commandes `sdd-review`/`sdd-live`, le rôle et le package.
- [ ] Lancer `bun test extensions/sdd-missions/legacy-cutover.test.ts extensions/sdd-missions/cutover.integration.test.ts`; confirmer que le préflight fixture passe et que le test d'absence est rouge.
- [ ] Exécuter l'inventaire live sans mutation :

```bash
find .sdd -type f -print | sort
jq -r '[.runId,.state] | @tsv' .sdd/runs/*/snapshot.json
jq -r '[.runId,.status,.currentTask,.totalTasks] | @tsv' .sdd/progress/*.json
jq -r '[.runId,(.tasks|length),.queuedAt] | @tsv' .sdd/queue/*.json
```

- [ ] Tant que `sdd-mqxpovpu-8m9fgo` reste queued, **arrêter cette tâche avant toute suppression** et demander une décision explicite : annuler proprement, archiver explicitement, ou achever ce run. Ne pas déplacer, réécrire ou supprimer ses fichiers par supposition.
- [ ] Après résolution explicite et préflight vert, lancer une dernière fois `bun test --isolate extensions/sdd-orchestrator` pour figer la santé du donneur avant retrait.
- [ ] Extraire au préalable toute primitive encore consommée. Vérifier `rg -n "sdd-orchestrator/" agent/extensions/sdd-missions agent/extensions/_shared`; le résultat doit être vide.
- [ ] Supprimer le dossier legacy entier, le rôle `sdd-plan` et les six agents spécifiques listés. Ne pas supprimer `sdd-qa-tester`, `browser-tester`, les reviewers génériques ou les tool groups sans une référence orpheline prouvée.
- [ ] Remplacer les overrides legacy par les nouveaux agents/routes dans `settings.example.json` et l'actif ignoré `settings.json`. Ne pas continuer à lire `sddOrchestrator`.
- [ ] Avant d'éditer `agent/prompts/delegate-subagents.md`, relire son diff préexistant. Modifier uniquement la ligne de tier/routage SDD et conserver les changements utilisateur actuels.
- [ ] Remplacer `sdd-worker` dans le deny-list de vérification brainstorm par `sdd-mission-worker`, car ce writer reste interdit comme verifier.
- [ ] Marquer ADR-011 et les deux designs actifs legacy comme superseded par `docs/plans/2026-08-02-sdd-missions-design.md`. Laisser les brainstorms et plans historiques intacts.
- [ ] Lancer le test d'absence jusqu'au vert. Vérifier que `/sdd-mission` reste chargé via le test Jiti/runtime.
- [ ] Vérifier que `agent/.sdd/` est byte-for-byte inchangé et toujours ignoré; aucune commande de purge n'est autorisée.
- [ ] Commit tracked seulement :

```bash
git add agent/extensions/sdd-missions/legacy-cutover.ts agent/extensions/sdd-missions/legacy-cutover.test.ts agent/extensions/sdd-missions/cutover.integration.test.ts
git add agent/settings.example.json agent/extensions/brainstorm-forcer/verification.test.ts
git add docs/adr/ADR-011-sdd-live-run-observability.md docs/plans/2026-07-21-modular-deterministic-sdd-design.md docs/plans/2026-07-22-sdd-validation-agents-design.md
git add -u agent/extensions/sdd-orchestrator agent/roles/sdd-plan.md agent/agents/sdd-orchestrator.md agent/agents/orchestration-assessor.md agent/agents/sdd-worker.md agent/agents/sdd-combined-reviewer.md agent/agents/sdd-spec-reviewer.md agent/agents/sdd-quality-reviewer.md
git add -p agent/prompts/delegate-subagents.md
git diff --cached --check
git commit -m "refactor: cut over from sdd orchestrator to missions"
```

Pour `git add -p`, sélectionner uniquement le hunk de remplacement du routage SDD. Si Git fusionne ce hunk avec les modifications utilisateur préexistantes, ne rien stage pour ce fichier et arrêter pour isoler la modification avant le commit.

`agent/settings.json` est une configuration active ignorée : la mettre à jour et la vérifier, mais ne pas forcer son ajout au commit.

### Task 18: Exécuter les gates globaux et auditer la livraison

**Files:**

- Modify: `agent/extensions/sdd-missions/*.ts` uniquement si un gate révèle un défaut du nouveau package
- Modify: `docs/superpowers/plans/2026-08-02-sdd-missions-implementation.md` pour cocher les étapes réellement terminées pendant l'exécution

- [ ] Rechercher les marqueurs incomplets et les imports legacy actifs :

```bash
rg -n "T[B]D|T[O]DO|place[h]older|sdd-orchestrator/|sdd-plan|sdd_(prepare|submit|approve|status|result|apply|cancel|direct_complete)" extensions/sdd-missions extensions/_shared/orchestration ../docs/superpowers/plans/2026-08-02-sdd-missions-implementation.md
```

Les références historiques marquées superseded sont permises dans les anciens docs; aucune référence runtime/import/config active ne l'est.

- [ ] Lancer les gates ciblés :

```bash
bun test --isolate extensions/_shared/orchestration/delegation-client.test.ts
bun test --isolate extensions/sdd-missions
bun test extensions/brainstorm-forcer/verification.test.ts
```

- [ ] Lancer tous les gates projet depuis `~/.pi/agent` :

```bash
bun run typecheck
bun run lint
bun run fmt:check
bun run check:parse
bun test --isolate
```

- [ ] Si un gate global échoue, comparer avec le baseline enregistré avant Task 1. Corriger tout défaut causé par ce chantier; si l'échec était déjà présent et nécessite une modification hors scope, arrêter et demander l'autorisation de traiter ce prérequis.
- [ ] Vérifier les artefacts indésirables et le périmètre Git :

```bash
git status --short
git diff --check
git diff --stat HEAD~1..HEAD
git ls-files | rg '(^|/)(node_modules|dist|coverage|\.pi/sdd-missions)(/|$)' || true
```

- [ ] Rejouer manuellement le scénario utilisateur dans un dépôt fixture : `/sdd-mission <goal>` → confirmation d'intensité → approbation unique → exécution/validation/fix → auto-apply. Vérifier qu'aucun rôle switch, `prepare`, polling ou seconde approbation n'apparaît.
- [ ] Vérifier que les changements préexistants identifiés dans les contraintes globales sont toujours présents et n'ont pas été écrasés.
- [ ] Commit des seules corrections de gate, si nécessaire :

```bash
git add agent/extensions/sdd-missions agent/extensions/_shared docs/superpowers/plans/2026-08-02-sdd-missions-implementation.md
git commit -m "chore: verify sdd missions cutover"
```

## Completion Criteria

- `/sdd-mission <goal>` requiert au plus une confirmation d'intensité et une approbation initiale lorsqu'aucune décision réellement hors contrat ne survient.
- L'objectif, les recherches, le contrat, le plan, les features, les validations, les preuves et la delivery sont centralisés sous `<cwd>/.pi/sdd-missions/<mission-id>/`.
- Chaque tentative est fraîche, corrélée, bornée par le modèle résolu et dépourvue de transcript antérieur.
- Les budgets exploration/planning/implementation/correction/validation/infrastructure/global sont indépendants.
- Un malformed validator output ne crée ni finding ni correction fonctionnelle.
- Les milestones sont validées indépendamment et tout finding blocking crée une fix feature append-only suivie d'une revalidation complète.
- Une baseline sale approuvée est matérialisée dans le worktree; seul le delta mission est auto-appliqué si la source pertinente n'a pas dérivé.
- Après cutover, aucun tool, command, rôle, agent, listener, import ou config `sdd-orchestrator` actif ne subsiste.
- `agent/.sdd/` reste une archive locale inerte non purgée.
- Typecheck, lint, format, parse et suite complète sont verts, ou tout échec baseline hors scope a été explicitement arrêté pour décision.
