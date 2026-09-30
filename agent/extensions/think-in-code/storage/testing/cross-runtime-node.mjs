import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { createJiti } from 'jiti';

assert.equal(process.versions.bun, undefined, 'this probe must run under Node');
const [mode, storeRoot, archiveId] = process.argv.slice(2);
const jiti = createJiti(import.meta.url, {
    tryNative: false,
    moduleCache: false,
});
const { ThinkStore } = await jiti.import('../store.ts');
const { DEFAULT_THINK_IN_CODE_CONFIG } = await jiti.import('../../config.ts');
const options = {
    config: DEFAULT_THINK_IN_CODE_CONFIG,
    storeRoot,
    canonicalPath: '/probe/project',
    now: () => 1_700_000_000_000,
    randomId: () => 'node-archive-001',
};
const store = new ThinkStore(options);
try {
    if (mode === 'write') {
        const archive = store.archive({
            kind: 'command-output',
            data: 'node original content',
        });
        store.index({
            kind: 'command-summary',
            source: 'node fixture',
            text: 'node alpha-2847 quoted phrase',
            archiveIds: [archive.id],
        });
        assert.equal(store.search('alpha-2847', 5).length, 1);
        assert.equal(
            statSync(join(storeRoot, 'store.sqlite')).mode & 0o777,
            0o600,
        );
        assert.equal(statSync(archive.archivePath).mode & 0o777, 0o600);
        assert.throws(
            () =>
                new ThinkStore({
                    ...options,
                    canonicalPath: '/another/project',
                }),
            /different canonical path/,
        );
        console.log(JSON.stringify({ archiveId: archive.id }));
    } else if (mode === 'read') {
        assert.equal(store.search('bun-token-5111', 5).length, 1);
        assert.equal(
            store.readArchives([archiveId], 1024)[0]?.data,
            'bun original content',
        );
        console.log(JSON.stringify({ read: true }));
    } else if (mode === 'rollback') {
        const { DatabaseSync } = await import('node:sqlite');
        const raw = new DatabaseSync(join(storeRoot, 'store.sqlite'));
        try {
            raw.exec('DROP TABLE fts_documents');
        } finally {
            raw.close();
        }
        assert.throws(
            () =>
                store.index({
                    kind: 'command-summary',
                    source: 'rollback',
                    text: 'failure',
                }),
            /fts_documents/,
        );
        assert.equal(store.countDocuments(), 0);
        console.log(JSON.stringify({ rolledBack: true }));
    } else {
        throw new Error(`Unknown probe mode: ${mode}`);
    }
} finally {
    store.close();
}
