import { describe, it, expect } from 'bun:test';

const { extractValue, InMemorySessionCache } = await import('./handler.ts');

describe('extractValue', () => {
    it('extracts command for bash target', () => {
        expect(extractValue('bash', { command: 'rm -rf /' })).toBe('rm -rf /');
    });
    it('returns undefined for bash target without command', () => {
        expect(extractValue('bash', {})).toBeUndefined();
    });
    it('extracts path for read target', () => {
        expect(extractValue('read', { path: '/etc/passwd' })).toBe(
            '/etc/passwd',
        );
    });
    it('extracts pattern for grep target', () => {
        expect(extractValue('grep', { pattern: 'foo' })).toBe('foo');
    });
    it('returns undefined for unknown surface', () => {
        expect(extractValue('custom', {})).toBeUndefined();
    });
    it('returns undefined for non-bash/non-path surface with data', () => {
        expect(extractValue('mcp', { command: 'foo' })).toBeUndefined();
    });
});

describe('InMemorySessionCache', () => {
    it('returns false for unknown pair', () => {
        expect(new InMemorySessionCache().has('rm -rf *', 'rm -rf /tmp')).toBe(
            false,
        );
    });
    it('returns true after add', () => {
        const c = new InMemorySessionCache();
        c.add('rm -rf *', 'rm -rf /tmp');
        expect(c.has('rm -rf *', 'rm -rf /tmp')).toBe(true);
    });
    it('does not match different value', () => {
        const c = new InMemorySessionCache();
        c.add('rm -rf *', 'rm -rf /tmp');
        expect(c.has('rm -rf *', 'rm -rf /other')).toBe(false);
    });
    it('clears', () => {
        const c = new InMemorySessionCache();
        c.add('rm -rf *', 'rm -rf /tmp');
        c.clear();
        expect(c.has('rm -rf *', 'rm -rf /tmp')).toBe(false);
    });
});

// ── checkAndBlock + handleAsk tests ──────────────────────────
import { mock } from 'bun:test';

mock.module('@gotgenes/pi-permission-system', () => ({
    getPermissionsService: () => mockService,
}));

let mockService: any;

const { checkAndBlock, InMemorySessionCache: Cache } =
    await import('./handler.ts');

function fakeCtx(hasUI = true, selectResult?: string): any {
    return {
        hasUI,
        ui: {
            select: async (_title: string, _opts: string[]) => selectResult,
        },
    };
}
function fakeConfig(entries: Record<string, string>): any {
    return { inherit: entries };
}
function fakeEvents(): any {
    return { emit: () => {}, on: () => () => {} };
}

describe('checkAndBlock', () => {
    it('undefined when tool not in inherit map', async () => {
        mockService = { checkPermission: () => ({ state: 'allow' }) };
        const r = await checkAndBlock(
            'x',
            {},
            fakeConfig({}),
            fakeCtx(),
            fakeEvents(),
            new Cache(),
        );
        expect(r).toBeUndefined();
    });

    it('undefined when permission service unavailable', async () => {
        mockService = undefined as any;
        const { checkAndBlock: ck } = await import('./handler.ts');
        const r = await ck(
            'safe_bash',
            { command: 'rm -rf /' },
            fakeConfig({ safe_bash: 'bash' }),
            fakeCtx(),
            fakeEvents(),
            new Cache(),
        );
        expect(r).toBeUndefined();
    });

    it('undefined on allow', async () => {
        mockService = { checkPermission: () => ({ state: 'allow' }) };
        const r = await checkAndBlock(
            'safe_bash',
            { command: 'ls' },
            fakeConfig({ safe_bash: 'bash' }),
            fakeCtx(),
            fakeEvents(),
            new Cache(),
        );
        expect(r).toBeUndefined();
    });

    it('blocks on deny', async () => {
        mockService = {
            checkPermission: () => ({
                state: 'deny',
                matchedPattern: 'sudo *',
                reason: 'no sudo',
            }),
        };
        const r = await checkAndBlock(
            'safe_bash',
            { command: 'sudo rm' },
            fakeConfig({ safe_bash: 'bash' }),
            fakeCtx(),
            fakeEvents(),
            new Cache(),
        );
        expect(r).toEqual({
            block: true,
            reason: expect.stringContaining('sudo'),
        });
    });

    it('undefined when session cache has match for ask', async () => {
        mockService = {
            checkPermission: () => ({
                state: 'ask',
                matchedPattern: 'rm -rf *',
            }),
        };
        const c = new Cache();
        c.add('rm -rf *', 'rm -rf /tmp');
        const r = await checkAndBlock(
            'safe_bash',
            { command: 'rm -rf /tmp' },
            fakeConfig({ safe_bash: 'bash' }),
            fakeCtx(),
            fakeEvents(),
            c,
        );
        expect(r).toBeUndefined();
    });

    it('blocks on ask when no UI', async () => {
        mockService = {
            checkPermission: () => ({
                state: 'ask',
                matchedPattern: 'rm -rf *',
            }),
        };
        const r = await checkAndBlock(
            'safe_bash',
            { command: 'rm -rf /tmp' },
            fakeConfig({ safe_bash: 'bash' }),
            fakeCtx(false),
            fakeEvents(),
            new Cache(),
        );
        expect(r).toEqual({ block: true, reason: expect.any(String) });
    });

    it('auto-allows ask when yolo is true', async () => {
        mockService = {
            checkPermission: () => ({
                state: 'ask',
                matchedPattern: 'rm -rf *',
            }),
        };
        // With yolo: true, ask → auto-allow. No dialog needed, no UI required.
        const r = await checkAndBlock(
            'safe_bash',
            { command: 'rm -rf /tmp' },
            fakeConfig({ safe_bash: 'bash' }),
            fakeCtx(false), // no UI — but yolo bypasses the check entirely
            fakeEvents(),
            new Cache(),
            true, // yolo
        );
        expect(r).toBeUndefined();
    });

    it('still blocks deny when yolo is true', async () => {
        mockService = {
            checkPermission: () => ({
                state: 'deny',
                matchedPattern: 'rm -rf *',
                reason: 'never allowed',
            }),
        };
        const r = await checkAndBlock(
            'safe_bash',
            { command: 'rm -rf /tmp' },
            fakeConfig({ safe_bash: 'bash' }),
            fakeCtx(),
            fakeEvents(),
            new Cache(),
            true, // yolo
        );
        expect(r).toEqual({ block: true, reason: 'never allowed' });
    });
});

describe('handleAsk (via checkAndBlock with ask + UI)', () => {
    it('allows when user selects Yes', async () => {
        mockService = {
            checkPermission: () => ({
                state: 'ask',
                matchedPattern: 'rm -rf *',
            }),
        };
        const r = await checkAndBlock(
            'safe_bash',
            { command: 'rm -rf /tmp' },
            fakeConfig({ safe_bash: 'bash' }),
            fakeCtx(true, 'Yes'),
            fakeEvents(),
            new Cache(),
        );
        expect(r).toBeUndefined();
    });

    it('stores + allows on Yes for session', async () => {
        mockService = {
            checkPermission: () => ({
                state: 'ask',
                matchedPattern: 'rm -rf *',
            }),
        };
        const cache = new Cache();
        const r = await checkAndBlock(
            'safe_bash',
            { command: 'rm -rf /tmp' },
            fakeConfig({ safe_bash: 'bash' }),
            fakeCtx(true, 'Yes for this session'),
            fakeEvents(),
            cache,
        );
        expect(r).toBeUndefined();
        expect(cache.has('rm -rf *', 'rm -rf /tmp')).toBe(true);
    });

    it('blocks when user selects No', async () => {
        mockService = {
            checkPermission: () => ({
                state: 'ask',
                matchedPattern: 'rm -rf *',
            }),
        };
        const r = await checkAndBlock(
            'safe_bash',
            { command: 'rm -rf /tmp' },
            fakeConfig({ safe_bash: 'bash' }),
            fakeCtx(true, 'No'),
            fakeEvents(),
            new Cache(),
        );
        expect(r).toEqual({ block: true, reason: expect.any(String) });
    });

    it('blocks when select returns undefined', async () => {
        mockService = {
            checkPermission: () => ({
                state: 'ask',
                matchedPattern: 'rm -rf *',
            }),
        };
        const r = await checkAndBlock(
            'safe_bash',
            { command: 'rm -rf /tmp' },
            fakeConfig({ safe_bash: 'bash' }),
            fakeCtx(true, undefined),
            fakeEvents(),
            new Cache(),
        );
        expect(r).toEqual({ block: true, reason: expect.any(String) });
    });
});
