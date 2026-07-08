import { describe, expect, it, mock } from 'bun:test';
import { applyMode, restoreBash, shouldBlockBashCall } from './apply-mode';
import type { ToolControl } from './apply-mode';

function makeApi(activeTools: string[]): {
    api: ToolControl;
    setActiveTools: ReturnType<typeof mock>;
} {
    const setActiveTools = mock(() => {});
    return {
        api: {
            getActiveTools: () => activeTools,
            setActiveTools,
        },
        setActiveTools,
    };
}

describe('restoreBash', () => {
    it('adds bash when absent, returns true', () => {
        const { api, setActiveTools } = makeApi(['safe_bash', 'read']);
        const changed = restoreBash(api);
        expect(changed).toBe(true);
        expect(setActiveTools.mock.calls[0][0]).toEqual([
            'safe_bash',
            'read',
            'bash',
        ]);
    });

    it('no-op when bash present, returns false', () => {
        const { api, setActiveTools } = makeApi(['bash', 'safe_bash']);
        const changed = restoreBash(api);
        expect(changed).toBe(false);
        expect(setActiveTools).not.toHaveBeenCalled();
    });

    it('adds bash to empty list', () => {
        const { api, setActiveTools } = makeApi([]);
        const changed = restoreBash(api);
        expect(changed).toBe(true);
        expect(setActiveTools.mock.calls[0][0]).toEqual(['bash']);
    });
});

describe('shouldBlockBashCall', () => {
    it('blocks bash in replace mode', () => {
        expect(shouldBlockBashCall('bash', 'replace')).toBe(true);
    });

    it('does not block bash in coexist mode', () => {
        expect(shouldBlockBashCall('bash', 'coexist')).toBe(false);
    });

    it('never blocks safe_bash (even in replace mode)', () => {
        expect(shouldBlockBashCall('safe_bash', 'replace')).toBe(false);
        expect(shouldBlockBashCall('safe_bash', 'coexist')).toBe(false);
    });

    it('never blocks other tools', () => {
        expect(shouldBlockBashCall('read', 'replace')).toBe(false);
        expect(shouldBlockBashCall('edit', 'replace')).toBe(false);
        expect(shouldBlockBashCall('grep', 'replace')).toBe(false);
        expect(shouldBlockBashCall('', 'replace')).toBe(false);
    });
});

describe('applyMode', () => {
    it('replace: removes bash when present, keeps safe_bash + others', () => {
        const { api, setActiveTools } = makeApi([
            'bash',
            'safe_bash',
            'read',
            'edit',
        ]);
        applyMode(api, 'replace');
        expect(setActiveTools).toHaveBeenCalledTimes(1);
        expect(setActiveTools.mock.calls[0][0]).toEqual([
            'safe_bash',
            'read',
            'edit',
        ]);
    });

    it('replace: no-op when bash already absent (idempotent)', () => {
        const { api, setActiveTools } = makeApi(['safe_bash', 'read']);
        applyMode(api, 'replace');
        expect(setActiveTools).not.toHaveBeenCalled();
    });

    it('replace: removes all bash occurrences (dedup safety)', () => {
        const { api, setActiveTools } = makeApi(['bash', 'bash', 'safe_bash']);
        applyMode(api, 'replace');
        expect(setActiveTools.mock.calls[0][0]).toEqual(['safe_bash']);
    });

    it('coexist: never calls setActiveTools (bash present)', () => {
        const { api, setActiveTools } = makeApi(['bash', 'safe_bash']);
        applyMode(api, 'coexist');
        expect(setActiveTools).not.toHaveBeenCalled();
    });

    it('coexist: never calls setActiveTools (bash absent)', () => {
        const { api, setActiveTools } = makeApi(['safe_bash']);
        applyMode(api, 'coexist');
        expect(setActiveTools).not.toHaveBeenCalled();
    });

    it('replace: results in empty list when bash is only tool', () => {
        const { api, setActiveTools } = makeApi(['bash']);
        applyMode(api, 'replace');
        expect(setActiveTools.mock.calls[0][0]).toEqual([]);
    });
});
