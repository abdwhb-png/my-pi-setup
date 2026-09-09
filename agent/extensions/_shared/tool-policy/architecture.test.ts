import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

test('integrated extensions have exactly one production setActiveTools owner', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const writers: string[] = [];
    for (const file of new Bun.Glob('**/*.ts').scanSync(root)) {
        if (/(?:\.test\.|\.spec\.|__tests__\/|fixtures\/)/.test(file)) continue;
        const source = readFileSync(join(root, file), 'utf8');
        if (/(?:\.setActiveTools|\[['"]setActiveTools['"]\])\s*\(/.test(source)) writers.push(file);
    }
    expect(writers).toEqual(['tool-groups/index.ts']);
    // Plannotator and Pi Lens are external packages, intentionally outside O3's scope.
});
