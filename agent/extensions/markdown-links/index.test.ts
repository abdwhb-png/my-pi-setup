import { describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
    default as markdownLinksExtension,
    discoverMarkdownRoots,
    expandAllowedRoots,
    extractMarkdownLinks,
    loadMarkdownLinksConfig,
    resolveLinkedMarkdownFiles,
    resolveLocalMarkdownDestination,
} from './index.ts';

describe('extractMarkdownLinks', () => {
    it('collects local inline Markdown link destinations', async () => {
        const links = await extractMarkdownLinks(
            '[ABOUT-PI.md](../docs/ABOUT-PI.md)',
        );
        expect(links).toEqual(['../docs/ABOUT-PI.md']);
    });

    it('resolves reference links through their definitions', async () => {
        const links = await extractMarkdownLinks(
            '[ABOUT-PI.md][about]\n\n[about]: ../docs/ABOUT-PI.md',
        );
        expect(links).toEqual(['../docs/ABOUT-PI.md']);
    });

    it('ignores images, inline code, and fenced code links', async () => {
        const links = await extractMarkdownLinks(
            '![image](asset.md) `[code](code.md)`\n\n```md\n[ignored](ignored.md)\n```\n\n[ok](ok.md)',
        );
        expect(links).toEqual(['ok.md']);
    });

    it('resolves only local Markdown destinations relative to source file', () => {
        const source = '/workspace/project/AGENTS.md';

        expect(
            resolveLocalMarkdownDestination(
                '../docs/ABOUT-PI.md#context',
                source,
            ),
        ).toBe('/workspace/docs/ABOUT-PI.md');
        expect(
            resolveLocalMarkdownDestination(
                'https://example.com/docs.md',
                source,
            ),
        ).toBeNull();
        expect(
            resolveLocalMarkdownDestination('./notes.txt', source),
        ).toBeNull();
    });

    it('loads recursively linked files under allowed roots', async () => {
        const root = await mkdtemp(join(tmpdir(), 'pi-markdown-links-'));
        const docs = join(root, 'docs');
        await mkdir(docs);
        const sourcePath = join(root, 'AGENTS.md');
        const linkedPath = join(docs, 'guide.md');
        await writeFile(sourcePath, '[guide](docs/guide.md)');
        await writeFile(linkedPath, '# Guide');

        const result = await resolveLinkedMarkdownFiles(
            [{ path: sourcePath, content: '[guide](docs/guide.md)' }],
            { allowedRoots: [root] },
        );

        expect(result.files).toEqual([
            { path: linkedPath, content: '# Guide' },
        ]);
    });

    it('loads global config and lets project values override it', async () => {
        const root = await mkdtemp(join(tmpdir(), 'pi-markdown-links-'));
        const agentDir = join(root, 'agent');
        const projectDir = join(root, 'project');
        await mkdir(agentDir);
        await mkdir(join(projectDir, '.pi'), { recursive: true });
        await writeFile(
            join(agentDir, 'settings.json'),
            JSON.stringify({
                markdownLinks: {
                    maxDepth: 4,
                    maxBytes: 1000,
                    scope: 'context',
                },
            }),
        );
        await writeFile(
            join(projectDir, '.pi', 'settings.json'),
            JSON.stringify({ markdownLinks: { maxDepth: 2 } }),
        );

        const trustedConfig = await loadMarkdownLinksConfig(
            projectDir,
            agentDir,
            true,
        );
        expect(trustedConfig).toEqual({
            maxDepth: 2,
            maxBytes: 1000,
            scope: 'context',
            allowedRoots: ['$cwd', '$agentDir', '$agentDir/..', '$contextDirs'],
        });
        const untrustedConfig = await loadMarkdownLinksConfig(
            projectDir,
            agentDir,
            false,
        );
        expect(untrustedConfig).toEqual({
            maxDepth: 4,
            maxBytes: 1000,
            scope: 'context',
            allowedRoots: ['$cwd', '$agentDir', '$agentDir/..', '$contextDirs'],
        });
    });

    it('expands configured allowed-root tokens', () => {
        expect(
            expandAllowedRoots({
                patterns: [
                    '$cwd',
                    '$agentDir',
                    '$agentDir/..',
                    '$contextDirs',
                    '~/docs',
                ],
                cwd: '/workspace/project',
                agentDir: '/home/user/.pi/agent',
                contextDirs: ['/workspace', '/workspace/project'],
                homeDir: '/home/user',
            }),
        ).toEqual([
            '/workspace/project',
            '/home/user/.pi/agent',
            '/home/user/.pi',
            '/workspace',
            '/workspace/project',
            '/home/user/docs',
        ]);
    });

    it('includes trusted SYSTEM and APPEND_SYSTEM files in all scope', async () => {
        const root = await mkdtemp(join(tmpdir(), 'pi-markdown-links-'));
        const agentDir = join(root, 'agent');
        const projectDir = join(root, 'project');
        await mkdir(join(projectDir, '.pi'), { recursive: true });
        await mkdir(agentDir);
        await writeFile(join(projectDir, '.pi', 'SYSTEM.md'), '# System');
        await writeFile(
            join(projectDir, '.pi', 'APPEND_SYSTEM.md'),
            '# Append',
        );

        const roots = await discoverMarkdownRoots({
            cwd: projectDir,
            agentDir,
            trusted: true,
            scope: 'all',
            contextFiles: [
                { path: join(projectDir, 'AGENTS.md'), content: '# Agents' },
            ],
        });

        expect(roots).toEqual([
            { path: join(projectDir, 'AGENTS.md'), content: '# Agents' },
            { path: join(projectDir, '.pi', 'SYSTEM.md'), content: '# System' },
            {
                path: join(projectDir, '.pi', 'APPEND_SYSTEM.md'),
                content: '# Append',
            },
        ]);
    });

    it('skips cycles and enforces depth and byte limits', async () => {
        const root = await mkdtemp(join(tmpdir(), 'pi-markdown-links-'));
        const firstPath = join(root, 'first.md');
        const secondPath = join(root, 'second.md');
        await writeFile(firstPath, '[second](second.md)');
        await writeFile(secondPath, '[first](first.md)');

        const result = await resolveLinkedMarkdownFiles(
            [{ path: firstPath, content: '[second](second.md)' }],
            { allowedRoots: [root], maxDepth: 1, maxBytes: 1 },
        );

        expect(result.files).toEqual([]);
        expect(result.skipped).toContain('second.md: size limit exceeded');
    });

    it('registers a status command', async () => {
        let statusHandler:
            | ((args: string, context: unknown) => void | Promise<void>)
            | undefined;
        const pi = {
            on() {},
            registerCommand(
                name: string,
                command: {
                    handler: (
                        args: string,
                        context: unknown,
                    ) => void | Promise<void>;
                },
            ) {
                if (name === 'markdown-links:status')
                    statusHandler = command.handler;
            },
        } as unknown as ExtensionAPI;
        markdownLinksExtension(pi);

        let notice = '';
        await statusHandler?.('', {
            ui: {
                notify(message: string) {
                    notice = message;
                },
            },
        });

        expect(notice).toContain('No scan data yet');
    });

    it('injects linked files into the system prompt before agent start', async () => {
        const root = await mkdtemp(join(tmpdir(), 'pi-markdown-links-'));
        const sourcePath = join(root, 'AGENTS.md');
        const linkedPath = join(root, 'guide.md');
        await writeFile(linkedPath, '# Guide');

        let beforeAgentStart:
            | ((event: unknown, context: unknown) => Promise<unknown>)
            | undefined;
        const pi = {
            on(
                event: string,
                handler: (event: unknown, context: unknown) => Promise<unknown>,
            ) {
                if (event === 'before_agent_start') beforeAgentStart = handler;
            },
            registerCommand() {},
        } as unknown as ExtensionAPI;
        markdownLinksExtension(pi);

        const result = await beforeAgentStart?.(
            {
                systemPrompt: 'Base prompt',
                systemPromptOptions: {
                    cwd: root,
                    contextFiles: [
                        { path: sourcePath, content: '[guide](guide.md)' },
                    ],
                },
            },
            {},
        );

        const prompt = (result as { systemPrompt: string }).systemPrompt;
        expect(prompt).toContain('# Guide');
        expect(prompt).toContain(linkedPath);
    });
});
