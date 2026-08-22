import { afterEach, describe, expect, it } from 'bun:test';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCpaCatalogCache } from './cpa-catalog-cache.ts';
import type { CpaModelEntry } from './cpa-models.ts';

const endpoint = 'http://localhost:8317/v1';
const entry: CpaModelEntry = {
    id: 'deepseek/deepseek-v4-flash-0731',
    owned_by: 'openrouter',
};

const tempDirectories: string[] = [];

afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function createFixture() {
    const directory = mkdtempSync(join(tmpdir(), 'cpa-catalog-cache-'));
    tempDirectories.push(directory);
    return {
        cachePath: join(directory, 'cache', 'cpa-catalog.v1.json'),
        directory,
    };
}

describe('CpaCatalogCache', () => {
    it('restores last verified raw CPA entries for the same endpoint', async () => {
        const { cachePath } = createFixture();
        const cache = createCpaCatalogCache({ cachePath, endpoint });

        await cache.save([entry]);

        expect(existsSync(cachePath)).toBe(true);
        expect(cache.load()).toEqual([entry]);
        expect(
            JSON.parse(readFileSync(cachePath, 'utf8')).fetchedAt,
        ).toEqual(expect.any(Number));
    });

    it('persists concurrent live refreshes without colliding temporary files', async () => {
        const { cachePath } = createFixture();
        const cache = createCpaCatalogCache({ cachePath, endpoint });
        const laterEntry: CpaModelEntry = {
            id: 'gpt-5.6-terra',
            owned_by: 'openai',
        };

        await expect(
            Promise.all([cache.save([entry]), cache.save([laterEntry])]),
        ).resolves.toBeDefined();

        expect(cache.load()).toSatisfy(
            (entries: CpaModelEntry[] | undefined) =>
                entries?.[0]?.id === entry.id ||
                entries?.[0]?.id === laterEntry.id,
        );
    });

    it('rejects a cache from another CPA endpoint', async () => {
        const { cachePath } = createFixture();
        const original = createCpaCatalogCache({ cachePath, endpoint });
        await original.save([entry]);

        const otherEndpoint = createCpaCatalogCache({
            cachePath,
            endpoint: 'http://localhost:9999/v1',
        });

        expect(otherEndpoint.load()).toBeUndefined();
    });

    it('ignores malformed cache data', () => {
        const { cachePath, directory } = createFixture();
        const cache = createCpaCatalogCache({ cachePath, endpoint });
        const parent = join(directory, 'cache');
        mkdirSync(parent, { recursive: true });
        writeFileSync(cachePath, '{not json');

        expect(cache.load()).toBeUndefined();
    });
});
