/// <reference types="bun" />

import { describe, expect, it, mock } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
    getSandboxExecutionState,
    isSandboxUnavailableError,
} from '../_shared/bash/sandbox-execution-broker';
import {
    getAnalysisSandboxBrokerState,
    getAnalysisSandboxService,
} from '../_shared/analysis/sandbox-analysis-broker';
import sandboxExtension from './index';

type BashTool = {
    parameters: { properties: Record<string, unknown> };
    execute: (
        id: string,
        params: { command: string; timeout?: number; stdin?: string },
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        ctx: ExtensionContext,
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

type SessionStartHandler = (
    event: unknown,
    ctx: ExtensionContext,
) => Promise<void>;

function registerSandbox(options: { noSandbox?: boolean } = {}): {
    tool: BashTool;
    start: SessionStartHandler;
    stop?: SessionStartHandler;
} {
    let tool: BashTool | undefined;
    let start: SessionStartHandler | undefined;
    let stop: SessionStartHandler | undefined;
    const pi = {
        registerFlag: () => undefined,
        registerTool: (definition: BashTool) => {
            tool = definition;
        },
        registerCommand: () => undefined,
        on: (event: string, handler: SessionStartHandler) => {
            if (event === 'session_start') start = handler;
            if (event === 'session_shutdown') stop = handler;
        },
        getFlag: () => options.noSandbox ?? true,
    } as unknown as ExtensionAPI;

    sandboxExtension(pi);
    if (!tool) throw new Error('sandbox bash was not registered');
    if (!start) throw new Error('sandbox session_start was not registered');
    return { tool, start, stop };
}

const context = {
    cwd: process.cwd(),
    hasUI: false,
    ui: { notify: mock(() => undefined) },
} as unknown as ExtensionContext;

async function disabledSandbox(): Promise<BashTool> {
    const registered = registerSandbox({ noSandbox: true });
    await registered.start({}, context);
    return registered.tool;
}

describe('sandbox-owned bash explicit stdin', () => {
    it('advertises optional stdin in its schema', () => {
        expect(registerSandbox().tool.parameters.properties.stdin).toBeDefined();
    });

    it('publishes explicit disabled state', async () => {
        await disabledSandbox();
        expect(getSandboxExecutionState()).toBe('disabled');
        expect(getAnalysisSandboxBrokerState()).toBe('error');
        await expect(
            getAnalysisSandboxService().run({
                id: 'disabled-analysis',
                language: 'javascript',
                program: 'export default 1',
            }),
        ).rejects.toThrow('Analysis sandbox unavailable: initialization failed');
    });

    it('publishes error state for malformed project config', async () => {
        const cwd = await mkdtemp(join(tmpdir(), 'sandbox-malformed-'));
        await mkdir(join(cwd, '.pi'));
        await writeFile(join(cwd, '.pi', 'sandbox.json'), '{ invalid');
        const malformedContext = { ...context, cwd } as ExtensionContext;

        try {
            const registered = registerSandbox({ noSandbox: false });
            await registered.start({}, malformedContext);
            expect(getSandboxExecutionState()).toBe('error');
            let captured: unknown;
            try {
                await registered.tool.execute(
                    'call-malformed-config',
                    { command: 'printf should-not-run' },
                    undefined,
                    undefined,
                    malformedContext,
                );
                throw new Error('expected malformed-config to fail');
            } catch (error) {
                captured = error;
            }
            // Exact bounded public reason — the security contract never
            // forwards the publisher's raw parse error text.
            expect(captured).toBeInstanceOf(Error);
            if (!(captured instanceof Error)) {
                throw new Error('captured was not an Error');
            }
            expect(captured.message).toBe(
                'Sandbox execution unavailable: initialization failed',
            );
            // Provenance: the error is the typed SandboxUnavailableError
            // with the closed-set kind carried on the non-enumerable
            // `kind` slot.
            expect(isSandboxUnavailableError(captured)).toBe(true);
            if (isSandboxUnavailableError(captured)) {
                expect(captured.getKind()).toBe('initialization-failed');
            }
            // The raw parse secret (the publisher's raw error message)
            // MUST NEVER reach the surfaced message nor a JSON dump.
            // It is held only on the non-enumerable `initError` slot for
            // telemetry, accessible via the typed accessor.
            const serialized = JSON.stringify(captured);
            expect(captured.message).not.toContain('Could not parse');
            expect(captured.message).not.toContain('sandbox.json');
            expect(captured.message).not.toContain('Unexpected');
            expect(captured.message).not.toContain('JSON');
            expect(serialized).not.toContain('Could not parse');
            expect(serialized).not.toContain('sandbox.json');
            expect(serialized).not.toContain('Unexpected');
        } finally {
            await rm(cwd, { recursive: true, force: true });
        }
    });

    it('pipes stdin while sandbox is disabled', async () => {
        const result = await (await disabledSandbox()).execute(
            'call-1',
            {
                command:
                    'IFS= read -r value || true; printf %s "$value"',
                stdin: 'sandbox-input',
            },
            undefined,
            undefined,
            context,
        );

        expect(result.content).toEqual([
            { type: 'text', text: 'sandbox-input' },
        ]);
    });

    it('keeps stdin closed while sandbox is disabled', async () => {
        const result = await (await disabledSandbox()).execute(
            'call-2',
            {
                command:
                    'if IFS= read -r value; then printf inherited; else printf closed; fi',
            },
            undefined,
            undefined,
            context,
        );

        expect(result.content).toEqual([{ type: 'text', text: 'closed' }]);
    });

    it('publishes and executes through the real managed Zerobox backend', async () => {
        const cwd = await mkdtemp(join(import.meta.dir, '.sandbox-real-index-'));
        await mkdir(join(cwd, '.pi'));
        await writeFile(
            join(cwd, '.pi', 'sandbox.json'),
            JSON.stringify({
                enabled: true,
                filesystem: { allowWrite: ['.'], denyWrite: ['.env'] },
                network: { allowedDomains: [], deniedDomains: [] },
            }),
        );
        const realContext = { ...context, cwd } as ExtensionContext;
        const registered = registerSandbox({ noSandbox: false });
        try {
            await registered.start({}, realContext);
            expect(getSandboxExecutionState()).toBe('enabled');
            expect(getAnalysisSandboxBrokerState()).toBe('enabled');
            const result = await registered.tool.execute(
                'call-real-zerobox',
                { command: 'printf zerobox-index' },
                undefined,
                undefined,
                realContext,
            );
            expect(result.content).toEqual([
                { type: 'text', text: 'zerobox-index' },
            ]);
        } finally {
            await registered.stop?.({}, realContext);
            await rm(cwd, { recursive: true, force: true });
        }
    }, 30_000);
});
