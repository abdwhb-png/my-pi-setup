import { describe, it, expect, mock } from 'bun:test';

// Mock pi-tui modules before importing the module under test
mock.module('@earendil-works/pi-tui', () => ({
    fuzzyFilter: <T>(
        items: T[],
        query: string,
        getText: (item: T) => string,
    ): T[] => {
        if (!query) return items;
        return items.filter((item) =>
            getText(item).toLowerCase().includes(query.toLowerCase()),
        );
    },
    fuzzyMatch: () => ({ matches: true, score: 0 }),
    Markdown: () => null,
    ProcessTerminal: class {},
    TUI: class {},
    setKeybindings: () => {},
    getCapabilities: () => ({ images: false, hyperlinks: false }),
}));

// Mock pi-coding-agent settings to avoid loading the full TUI stack
mock.module('@earendil-works/pi-coding-agent', () => {
    const agentDir = '/tmp/pi-agent';
    return {
        getAgentDir: () => agentDir,
        SettingsManager: {
            create: () => ({
                getGlobalSettings: () => ({}),
                getProjectSettings: () => ({}),
            }),
            inMemory: (data: unknown) => ({
                getGlobalSettings: () => data,
                getProjectSettings: () => data,
            }),
        },
    };
});

const {
    parseAtValue,
    rebuildAtValue,
    findUnresolvedAtRefs,
    transformAtValue,
    getSearchRoots,
    levenshteinDistance,
    fuzzyMatchBasename,
    enrichAutocompleteWithCache,
} = await import('./pi-file-resolver.ts');

describe('parseAtValue', () => {
    it('parses simple relative path', () => {
        const result = parseAtValue('@path/to/file');
        expect(result).toEqual({
            path: 'path/to/file',
            isQuoted: false,
            isDirectory: false,
        });
    });

    it('parses quoted path with spaces', () => {
        const result = parseAtValue('@"/path with spaces/file.md"');
        expect(result).toEqual({
            path: '/path with spaces/file.md',
            isQuoted: true,
            isDirectory: false,
        });
    });

    it('parses absolute path', () => {
        const result = parseAtValue('@/absolute/path');
        expect(result).toEqual({
            path: '/absolute/path',
            isQuoted: false,
            isDirectory: false,
        });
    });

    it('parses directory path', () => {
        const result = parseAtValue('@relative/path/');
        expect(result).toEqual({
            path: 'relative/path/',
            isQuoted: false,
            isDirectory: true,
        });
    });

    it('parses bare filename', () => {
        const result = parseAtValue('@file.md');
        expect(result).toEqual({
            path: 'file.md',
            isQuoted: false,
            isDirectory: false,
        });
    });

    it('parses path without @ prefix', () => {
        const result = parseAtValue('relative/path');
        expect(result).toEqual({
            path: 'relative/path',
            isQuoted: false,
            isDirectory: false,
        });
    });
});

describe('rebuildAtValue', () => {
    it('rebuilds simple relative path', () => {
        const result = rebuildAtValue('/home/user/file.md', {
            path: 'file.md',
            isQuoted: false,
            isDirectory: false,
        });
        expect(result).toBe('@/home/user/file.md');
    });

    it('rebuilds quoted path', () => {
        const result = rebuildAtValue('/home/user/path with spaces/file.md', {
            path: 'path with spaces/file.md',
            isQuoted: true,
            isDirectory: false,
        });
        expect(result).toBe('@"/home/user/path with spaces/file.md"');
    });

    it('rebuilds directory path', () => {
        const result = rebuildAtValue('/home/user/dir/', {
            path: 'dir/',
            isQuoted: false,
            isDirectory: true,
        });
        expect(result).toBe('@/home/user/dir/');
    });

    it('preserves absolute passthrough', () => {
        const result = rebuildAtValue('/already/absolute', {
            path: '/already/absolute',
            isQuoted: false,
            isDirectory: false,
        });
        expect(result).toBe('@/already/absolute');
    });

    it('rebuilds bare filename', () => {
        const result = rebuildAtValue('/home/user/file.md', {
            path: 'file.md',
            isQuoted: false,
            isDirectory: false,
        });
        expect(result).toBe('@/home/user/file.md');
    });
});

describe('findUnresolvedAtRefs', () => {
    it('finds bare @filename in text', () => {
        const refs = findUnresolvedAtRefs('check @plan-file.md for details');
        expect(refs).toHaveLength(1);
        expect(refs[0]).toEqual({ raw: '@plan-file.md', name: 'plan-file.md' });
    });

    it('skips already absolute paths', () => {
        const refs = findUnresolvedAtRefs('read @/home/user/file.md');
        expect(refs).toHaveLength(0);
    });

    it('skips scoped paths (with /)', () => {
        const refs = findUnresolvedAtRefs('check @path/to/file.md');
        expect(refs).toHaveLength(0);
    });

    it('skips ~/ paths', () => {
        const refs = findUnresolvedAtRefs('look at @~/file.md');
        expect(refs).toHaveLength(0);
    });

    it('finds multiple bare refs', () => {
        const refs = findUnresolvedAtRefs(
            '@a.md and @b.txt and ignore @/abs/path and @c.ts',
        );
        expect(refs).toHaveLength(3);
        expect(refs.map((r) => r.name)).toEqual(['a.md', 'b.txt', 'c.ts']);
    });

    it('returns empty for text with no @ refs', () => {
        const refs = findUnresolvedAtRefs('just some text without refs');
        expect(refs).toHaveLength(0);
    });

    it('does not match @ mid-word', () => {
        const refs = findUnresolvedAtRefs('email@example.com');
        expect(refs).toHaveLength(0);
    });
});

describe('transformAtValue', () => {
    it('transforms relative @value to absolute', () => {
        const result = transformAtValue('@relative/file.md', '/home/user');
        expect(result).toBe('@/home/user/relative/file.md');
    });

    it('leaves absolute @value unchanged', () => {
        const result = transformAtValue('@/already/absolute', '/home/user');
        expect(result).toBe('@/already/absolute');
    });

    it('handles @value without @ prefix', () => {
        const result = transformAtValue('relative/file.md', '/home/user');
        expect(result).toBe('@/home/user/relative/file.md');
    });

    it('handles bare filename', () => {
        const result = transformAtValue('@file.md', '/home/user');
        expect(result).toBe('@/home/user/file.md');
    });

    it('handles quoted path with spaces', () => {
        const result = transformAtValue(
            '@"path with spaces/file.md"',
            '/home/user',
        );
        expect(result).toBe('@"/home/user/path with spaces/file.md"');
    });

    it('handles directory path', () => {
        const result = transformAtValue('@dir/', '/home/user');
        expect(result).toBe('@/home/user/dir/');
    });

    it('handles ~/ prefixed paths', () => {
        const result = transformAtValue('@~/file.md', '/home/user');
        expect(result).toBe('@~/file.md');
    });
});

describe('getSearchRoots', () => {
    it('returns all configured roots', () => {
        const roots = getSearchRoots('/current/project');
        expect(roots).toContain('/current/project');
        expect(roots).toContain('/home/abdwhb/.pi/agent');
        expect(roots).toContain('/home/abdwhb/.pi/agent/extensions');
        expect(roots).toContain('/home/abdwhb/.pi/pi-prompts');
        expect(roots).toContain('/home/abdwhb/.pi/docs');
    });

    it('deduplicates roots', () => {
        const roots = getSearchRoots('/home/abdwhb/.pi/agent/');
        const unique = new Set(roots);
        expect(roots.length).toBe(unique.size);
    });
});

describe('parseAtValue -> rebuildAtValue round-trip', () => {
    const cases = [
        '@simple-file.md',
        '@/absolute/path/file.ts',
        '@"path with spaces/file.md"',
        '@relative/dir/',
        '@file-in-cwd.ts',
    ];

    for (const input of cases) {
        it(`round-trips ${input}`, () => {
            const parsed = parseAtValue(input);
            const rebuilt = rebuildAtValue(parsed.path, parsed);
            expect(rebuilt).toBe(input);
        });
    }
});

describe('levenshteinDistance', () => {
    it('returns 0 for identical strings', () => {
        expect(levenshteinDistance('config.json', 'config.json')).toBe(0);
    });

    it('returns 0 for identical strings with different case', () => {
        expect(levenshteinDistance('CONFIG.JSON', 'config.json')).toBe(0);
    });

    it('returns 1 for single character substitution', () => {
        expect(levenshteinDistance('config.son', 'config.json')).toBe(1);
    });

    it('returns correct distance for insertion', () => {
        expect(levenshteinDistance('cat', 'cats')).toBe(1);
    });

    it('returns correct distance for deletion', () => {
        expect(levenshteinDistance('cats', 'cat')).toBe(1);
    });

    it('returns correct distance for multiple edits', () => {
        expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
    });

    it('returns length of other string when one is empty', () => {
        expect(levenshteinDistance('', 'abc')).toBe(3);
        expect(levenshteinDistance('abc', '')).toBe(3);
    });

    it('returns 0 for both empty strings', () => {
        expect(levenshteinDistance('', '')).toBe(0);
    });
});

describe('fuzzyMatchBasename', () => {
    const sampleFiles = [
        '/home/user/.pi/agent/extensions/pi-permission-system/config.json',
        '/home/user/projects/my-app/config.ts',
        '/home/user/.pi/agent/config.js',
        '/etc/nginx/nginx.conf',
        '/home/user/docs/readme.md',
        '/home/user/.pi/agent/extensions/pi-overrides/pi-file-resolver.ts',
    ];

    it('finds config.json when searching for config.son (typo)', () => {
        const result = fuzzyMatchBasename(sampleFiles, 'config.son');
        expect(result.length).toBeGreaterThan(0);
        expect(result[0]).toContain('config.json');
    });

    it('sorts exact matches before near matches', () => {
        const result = fuzzyMatchBasename(sampleFiles, 'config.json');
        expect(result.length).toBeGreaterThan(0);
        expect(result[0]).toContain('config.json');
    });

    it('finds multiple matches sorted by edit distance', () => {
        const result = fuzzyMatchBasename(sampleFiles, 'config');
        // All three config files should match
        expect(result.length).toBeGreaterThanOrEqual(2);
        // Exact basename match should be first
        const basenames = result.map((f) => f.split('/').pop());
        expect(basenames[0]?.includes('config')).toBe(true);
    });

    it('returns empty array for no matches within threshold', () => {
        const result = fuzzyMatchBasename(sampleFiles, 'zzzzzzzzzz');
        expect(result).toEqual([]);
    });

    it('returns empty array for empty query', () => {
        const result = fuzzyMatchBasename(sampleFiles, '');
        expect(result).toEqual([]);
    });

    it('returns empty array for empty files list', () => {
        const result = fuzzyMatchBasename([], 'config.son');
        expect(result).toEqual([]);
    });

    it('matches against filename basename only, not full path', () => {
        // 'nginx' is only in the basename, not in the directory path
        const result = fuzzyMatchBasename(sampleFiles, 'nginx.conf');
        expect(result.length).toBe(1);
        expect(result[0]).toContain('nginx.conf');
    });
});

describe('enrichAutocompleteWithCache', () => {
    const existingItems = [
        {
            value: '@/home/user/config.ts',
            label: 'config.ts',
            description: '/home/user/config.ts',
        },
    ];

    const cache: { files: string[]; ready: boolean; running: boolean } = {
        files: [
            '/home/user/config.json',
            '/home/user/config.ts',
            '/home/user/.env.development',
        ],
        ready: true,
        running: false,
    };

    const gitRespConfig = {
        fd: {
            respectGitignore: true,
            followSymlinks: true,
            includeHidden: true,
            excludePatterns: ['.git', 'node_modules'],
            types: ['f'],
        },
    };

    const gitNoRespConfig = {
        fd: {
            respectGitignore: false,
            followSymlinks: true,
            includeHidden: true,
            excludePatterns: ['.git', 'node_modules'],
            types: ['f'],
        },
    };

    it('adds cache-only files when respectGitignore is false', () => {
        const result = enrichAutocompleteWithCache(
            '@config',
            existingItems,
            cache,
            gitNoRespConfig,
        );
        // config.json from cache should be added (not in existing)
        const labels = result.map((i) => i.label);
        expect(labels).toContain('config.json');
        // config.ts already in existing
        expect(labels.filter((l) => l === 'config.ts').length).toBe(1);
    });

    it('does NOT add files when respectGitignore is true', () => {
        const result = enrichAutocompleteWithCache(
            '@config',
            existingItems,
            cache,
            gitRespConfig,
        );
        const labels = result.map((i) => i.label);
        expect(labels).toEqual(['config.ts']);
    });

    it('skips injection when cache is not ready', () => {
        const unreadyCache = { files: [], ready: false, running: false };
        const result = enrichAutocompleteWithCache(
            '@config',
            existingItems,
            unreadyCache,
            gitNoRespConfig,
        );
        const labels = result.map((i) => i.label);
        expect(labels).toEqual(['config.ts']);
    });

    it('returns original items unchanged when query is empty', () => {
        const result = enrichAutocompleteWithCache(
            '@',
            existingItems,
            cache,
            gitNoRespConfig,
        );
        expect(result).toEqual(existingItems);
    });

    it('deduplicates by value', () => {
        // existing has config.ts, cache also has config.ts → no duplicate
        const result = enrichAutocompleteWithCache(
            '@config',
            existingItems,
            cache,
            gitNoRespConfig,
        );
        const tsItems = result.filter((i) => i.label === 'config.ts');
        expect(tsItems.length).toBe(1);
    });

    it('returns original items when prefix is not @-prefixed (edge case)', () => {
        const result = enrichAutocompleteWithCache(
            'config',
            existingItems,
            cache,
            gitNoRespConfig,
        );
        expect(result).toEqual(existingItems);
    });

    it('includes dotfiles from cache when respectGitignore is false', () => {
        const result = enrichAutocompleteWithCache(
            '@.env',
            existingItems,
            cache,
            gitNoRespConfig,
        );
        expect(result.map((i) => i.label)).toContain('.env.development');
    });

    it('empty items array stays empty when cache has matches', () => {
        const result = enrichAutocompleteWithCache(
            '@.env',
            [],
            cache,
            gitNoRespConfig,
        );
        expect(result.map((i) => i.label)).toContain('.env.development');
    });
});
