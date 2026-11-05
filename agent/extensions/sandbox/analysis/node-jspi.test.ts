import { beforeEach, expect, mock, test } from 'bun:test';
import type { spawnSync as SpawnSync } from 'node:child_process';

const probe = mock<typeof SpawnSync>();
mock.module('node:child_process', () => ({ spawnSync: probe }));
const { nodeJspiArguments } = await import('./testing/node-jspi.ts');
beforeEach(() => probe.mockReset());
function outcome(status: number | null, stderr = '') {
    return { status, signal: null, pid: 1, output: [], stdout: '', stderr };
}
test('stable JSPI needs no experimental option', () => {
    probe.mockReturnValue(outcome(0));
    expect(nodeJspiArguments('/runtime/node')).toEqual([]);
    expect(probe).toHaveBeenCalledTimes(1);
});
test('older Node must prove JSPI works with the experimental option', () => {
    probe.mockReturnValueOnce(outcome(78)).mockReturnValueOnce(outcome(0));
    expect(nodeJspiArguments('/runtime/node')).toEqual([
        '--experimental-wasm-jspi',
    ]);
    expect(probe.mock.calls[1]![1]).toContain('--experimental-wasm-jspi');
});
test('unsupported JSPI fails with an actionable diagnostic', () => {
    probe
        .mockReturnValueOnce(outcome(78))
        .mockReturnValueOnce(outcome(9, 'bad option'));
    expect(() => nodeJspiArguments('/runtime/node')).toThrow(
        'Node does not provide WebAssembly JSPI',
    );
});
test('a launch failure is not mistaken for a capability result', () => {
    probe.mockReturnValue({
        ...outcome(null),
        error: new Error('fixture launch failed'),
    });
    expect(() => nodeJspiArguments('/runtime/node')).toThrow(
        'Cannot inspect Node WebAssembly JSPI',
    );
    expect(probe).toHaveBeenCalledTimes(1);
});
