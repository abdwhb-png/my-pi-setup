import { describe, expect, it } from 'bun:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

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

function registerSandbox(): BashTool {
    let tool: BashTool | undefined;
    const pi = {
        registerFlag: () => undefined,
        registerTool: (definition: BashTool) => {
            tool = definition;
        },
        registerCommand: () => undefined,
        on: () => undefined,
        getFlag: () => false,
    } as unknown as ExtensionAPI;

    sandboxExtension(pi);
    if (!tool) throw new Error('sandbox bash was not registered');
    return tool;
}

const context = {
    cwd: process.cwd(),
    hasUI: false,
    ui: {},
} as ExtensionContext;

describe('sandbox-owned bash explicit stdin', () => {
    it('advertises optional stdin in its schema', () => {
        expect(registerSandbox().parameters.properties.stdin).toBeDefined();
    });

    it('pipes stdin while sandbox is disabled', async () => {
        const result = await registerSandbox().execute(
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
        const result = await registerSandbox().execute(
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
