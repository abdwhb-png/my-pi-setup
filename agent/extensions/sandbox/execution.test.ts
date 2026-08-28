/// <reference types="bun" />

import { describe, expect, it, mock } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { getSandboxExecutionState } from '../_shared/bash/sandbox-execution-broker';
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
} {
    let tool: BashTool | undefined;
    let start: SessionStartHandler | undefined;
    const pi = {
        registerFlag: () => undefined,
        registerTool: (definition: BashTool) => {
            tool = definition;
        },
        registerCommand: () => undefined,
        on: (event: string, handler: SessionStartHandler) => {
            if (event === 'session_start') start = handler;
        },
        getFlag: () => options.noSandbox ?? true,
    } as unknown as ExtensionAPI;

    sandboxExtension(pi);
    if (!tool) throw new Error('sandbox bash was not registered');
    if (!start) throw new Error('sandbox session_start was not registered');
    return { tool, start };
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
            await expect(
                registered.tool.execute(
                    'call-malformed-config',
                    { command: 'printf should-not-run' },
                    undefined,
                    undefined,
                    malformedContext,
                ),
            ).rejects.toThrow('Could not parse sandbox config');
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
});
