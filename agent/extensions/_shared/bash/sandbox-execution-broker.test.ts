import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { BashOperations } from '@earendil-works/pi-coding-agent';

import {
    claimSandboxExecutionBroker,
    createSharedBashOperations,
    getSandboxExecutionState,
    publishSandboxExecutionState,
    releaseSandboxExecutionBroker,
} from './sandbox-execution-broker';

const execArgs = [
    'printf ok',
    '/tmp',
    { onData: () => undefined },
] as Parameters<BashOperations['exec']>;

async function expectUnavailable(
    execution: Promise<unknown>,
    message: string,
): Promise<void> {
    let error: unknown;
    try {
        await execution;
    } catch (caught) {
        error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('expected execution error');
    expect(error.message).toBe(message);
}

let owner: symbol | undefined;
afterEach(() => {
    if (owner) releaseSandboxExecutionBroker(owner);
    owner = undefined;
});

describe('sandbox execution broker', () => {
    it('fails closed before sandbox state is initialized', async () => {
        owner = Symbol('owner');
        claimSandboxExecutionBroker(owner);

        expect(getSandboxExecutionState()).toBe('uninitialized');
        await expectUnavailable(
            createSharedBashOperations().exec(...execArgs),
            'Sandbox execution unavailable: uninitialized',
        );
    });

    it('uses the published factory for enabled and explicitly disabled states', async () => {
        owner = Symbol('owner');
        claimSandboxExecutionBroker(owner);
        const exec = mock(async () => ({ output: 'ok', exitCode: 0 }));
        const factory = mock(() => ({ exec }) as BashOperations);

        expect(
            publishSandboxExecutionState(owner, {
                state: 'enabled',
                createOperations: factory,
            }),
        ).toBe(true);
        await createSharedBashOperations({ stdin: 'input' }).exec(...execArgs);
        expect(factory).toHaveBeenLastCalledWith({ stdin: 'input' });

        publishSandboxExecutionState(owner, {
            state: 'disabled',
            createOperations: factory,
        });
        await createSharedBashOperations().exec(...execArgs);
        expect(factory).toHaveBeenCalledTimes(2);
    });

    it('fails closed after sandbox initialization error', async () => {
        owner = Symbol('owner');
        claimSandboxExecutionBroker(owner);
        publishSandboxExecutionState(owner, {
            state: 'error',
            error: 'bubblewrap failed',
        });

        await expectUnavailable(
            createSharedBashOperations().exec(...execArgs),
            'Sandbox execution unavailable: bubblewrap failed',
        );
    });

    it('rejects stale owner updates and releases', () => {
        const staleOwner = Symbol('stale');
        owner = Symbol('current');
        claimSandboxExecutionBroker(staleOwner);
        claimSandboxExecutionBroker(owner);

        expect(
            publishSandboxExecutionState(staleOwner, {
                state: 'disabled',
                createOperations: () => ({}) as BashOperations,
            }),
        ).toBe(false);
        expect(releaseSandboxExecutionBroker(staleOwner)).toBe(false);
        expect(getSandboxExecutionState()).toBe('uninitialized');
    });
});
