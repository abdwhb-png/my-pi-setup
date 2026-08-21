# Migration complète de pi-subagents 0.40.0 vers 0.50.0

## Architecture retenue

- Épingler exactement `pi-subagents@0.50.0` dans le package local du harness.
- Migrer SDD et Brainstorm vers les contrats publics `pi-subagents/delegation`.
- Conserver `/brainstorm stop` par annulation exacte des tentatives structurées actives.
- Activer `fleetView`, conserver `asyncWidget` désactivé et rendre l'addon local dormant.
- Retirer `planner` et `context-builder`, mais préserver les trois commandes de workflow comme prompts modernes.
- Conserver les wrappers, tool groups, modèles, `pi-intercom`, Save Tokens et les données SDD existantes.

## Étapes

1. Sauvegarder les fichiers locaux ignorés, relever la baseline 0.40 et travailler sur `codex/pi-subagents-050-migration` sans toucher aux changements utilisateur préexistants.
2. Écrire les tests RED des contrats 0.50, installer la version exacte et prouver l'annulation structurée après remise d'un reçu. Si ce verrou échoue, restaurer 0.40 sans import interne.
3. Migrer `sdd-orchestrator` vers les identités `{requestId, ownerRunId, nodeId}`, les résultats textuels/structurés et les statuts 0.50. SDD conserve l'acceptation, les preuves et ses artefacts.
4. Remplacer les chaînes/RPC Brainstorm par un coordinateur de délégations structurées : vérificateurs parallèles, advisory architecte, état local, arrêt idempotent et interruption au reload.
5. Projeter les runs de coordination dans Fleet via `pi-subagents/external-runs`, sans transférer leur contrôle à Fleet.
6. Retirer les deux rôles supprimés, convertir les trois `.chain.md` en prompts de même nom, mettre à jour les instructions et rendre l'addon configurable avec `enabled: false`.
7. Exécuter les tests ciblés, la suite complète, typecheck, format, lint, parse check, runtime smoke et contrôles d'artefacts.

## Contrats de compatibilité

- Aucun import `pi-subagents/src/*`.
- Aucun payload public top-level `chain`, `tasks` ou `parallel`.
- `PI_SUBAGENT_PI_BINARY`, `PI_SUBAGENT_CHILD`, `PI_SUBAGENT_CHILD_AGENT` et `PI_TOOL_GROUPS_REQUESTED_TOOLS` restent inchangés.
- Le reviewer hérite de la frontière read-only 0.50.
- `pi-intercom` reste installé pour les appels directs à `intercom`; `contact_supervisor` reste natif.
- `artifactDir` conserve la valeur par défaut `session`; les anciens artefacts `.pi-subagents` ne sont pas supprimés.

## Gates

Depuis `~/.pi/agent` :

```bash
bun test --isolate extensions/sdd-orchestrator
bun test --isolate extensions/brainstorm-forcer
bun test --isolate extensions/pi-subagents-addons
bun test --isolate
bun run typecheck
bun run fmt:check
bun run lint
bun run check:parse
bun run check
git diff --check
```

Le cutover exige également un SDD synthétique, le run SDD en attente inchangé, un Brainstorm complet, un Brainstorm arrêté, un `/reload`, FleetView sans doublon et aucun enfant orphelin.

## Rollback

Restaurer les manifestes/configurations sauvegardés sous `~/.pi/migration-backups/pi-subagents-0.40.0-2026-08-18/`, réinstaller avec l'ancien lockfile frozen et revenir aux changements applicatifs par revert. Ne supprimer aucune sauvegarde ni ancien artefact avant validation des scénarios live.
