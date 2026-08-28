import { describe, expect, it, mock } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import safeBashExtension from './index';

type RegisteredTool = {
    parameters: {
        properties: Record<string, unknown>;
    };
    execute: (
        id: string,
        params: { command: string; timeout?: number; stdin?: string },
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        ctx: ExtensionContext,
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

function registerExtension(): RegisteredTool {
    let tool: RegisteredTool | undefined;
    const activeTools = ['bash', 'safe_bash'];
    const pi = {
        registerTool: (definition: RegisteredTool) => {
            tool = definition;
        },
        registerCommand: () => undefined,
        on: () => undefined,
        getActiveTools: () => activeTools,
        setActiveTools: mock(() => undefined),
    } as unknown as ExtensionAPI;

    safeBashExtension(pi);
    if (!tool) throw new Error('safe_bash was not registered');
    return tool;
}

const context = {
    cwd: '/tmp',
    hasUI: false,
    sessionManager: {
        getSessionId: () => 'safe-bash-test-session',
        getSessionFile: () => undefined,
    },
    ui: {},
} as ExtensionContext;

describe('safe_bash explicit stdin', () => {
    it('advertises optional stdin in its registered schema', () => {
        const tool = registerExtension();
        expect(tool.parameters.properties.stdin).toBeDefined();
    });

    it('pipes exact stdin through the real bash definition', async () => {
        const tool = registerExtension();
        const result = await tool.execute(
            'call-1',
            {
                command:
                    'IFS= read -r value || true; printf %s "$value"',
                stdin: 'hello',
            },
            undefined,
            undefined,
            context,
        );

        expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
    });

    it('keeps stdin closed when omitted', async () => {
        const result = await registerExtension().execute(
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

    it('runs safety guards before stdin execution', async () => {
        await expect(
            registerExtension().execute(
                'call-3',
                { command: 'rm -rf /', stdin: 'ignored' },
                undefined,
                undefined,
                context,
            ),
        ).rejects.toThrow();
    });

    it('blocks direct Python deletion before a disposable sentinel is touched', async () => {
        const fixture = await mkdtemp(join(tmpdir(), 'safe-bash-sentinel-'));
        const targetDirectory = join(fixture, 'target');
        const sentinel = join(fixture, 'sentinel.txt');
        await mkdir(targetDirectory);
        await writeFile(sentinel, 'keep');

        try {
            const command = `python3 -c "import shutil; from pathlib import Path; shutil.rmtree(Path('${targetDirectory}')); Path('${sentinel}').unlink()"`;
            await expect(
                registerExtension().execute(
                    'call-python-delete',
                    { command },
                    undefined,
                    undefined,
                    context,
                ),
            ).rejects.toThrow('file-delete-api');
            await expect(stat(targetDirectory)).resolves.toBeDefined();
            await expect(stat(sentinel)).resolves.toBeDefined();
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });
});
