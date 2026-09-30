# Adaptateur MCP officiel : échec du typecheck

## État au 2026-09-26

Pi utilise `npm:pi-mcp-adapter@2.37.0`, résolu sous `~/.pi/agent/npm/node_modules/pi-mcp-adapter`. `tool-groups` et `slow-mode` consomment son résolveur via `agent/extensions/_shared/mcp/ref-resolver.ts`. Le fork et son commit `53733d3` restent conservés sous `~/projects/pi-integrations/pi-mcp-adapter-fork`, mais ne sont plus installés.

Depuis `~/.pi/agent`, `bun run typecheck` échoue dans le paquet officiel :

```text
npm/node_modules/pi-mcp-adapter/unix-socket-transport.ts(33,34): error TS2345: Argument of type 'string | NonSharedBuffer' is not assignable to parameter of type 'Buffer<ArrayBufferLike>'.
```

`agent/tsconfig.json` exclut déjà `node_modules` et `npm` des fichiers de départ, avec `skipLibCheck: true`. Cela ne retire pas les fichiers TypeScript atteints par un import : l'export racine de `pi-mcp-adapter` pointe vers `index.ts`, importé par `ref-resolver.ts`. `tsc --explainFiles` suit ensuite les imports jusqu'à `server-manager.ts` puis `unix-socket-transport.ts`. `skipLibCheck` ne saute pas ce source `.ts`. Le lint des extensions ne signale pas cette erreur. Aucun serveur Unix n'était configuré pour le cwd `.pi` lors de la migration ; cela ne rend pas le typecheck vert.

## Décision et suite

Conserver le paquet officiel malgré ce contrôle de types **non vert**. Ne pas modifier le paquet géré dans `node_modules`, ajouter de suppression TypeScript, ni réinstaller le fork pour masquer le défaut. Le correctif local existant convertit les fragments texte en `Buffer` avant `ReadBuffer.append` et couvre les fragments `Buffer` et texte ; il pourra servir à une contribution upstream **plus tard**, sans issue ni PR créée pour le moment. Après publication d'une version officielle corrigée : vérifier sa version et son code, la mettre à jour via Pi CLI, puis relancer `bun run typecheck` et les tests MCP ciblés. Jusqu'alors, ne pas présenter le typecheck global comme réussi.
