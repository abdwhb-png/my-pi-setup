import { describe, it, expect } from 'bun:test';
import {
    appendToolsListPrompt,
    buildContextSendMessage,
    buildToolsListSnippet,
    calculateExtensionFiles,
    getSkillPathFromCommand,
    TOOLS_LIST_HEADING,
} from '../context.ts';

describe('calculateExtensionFiles', () => {
    it('should correctly identify extension files from commands', () => {
        const mockCommands = [
            {
                name: 'cmd1',
                source: 'extension',
                sourceInfo: { path: '/home/user/.pi/agent/extensions/ext1.ts' },
            },
            {
                name: 'cmd2',
                source: 'extension',
                sourceInfo: { path: '/home/user/.pi/agent/extensions/ext1.ts' },
            },
            {
                name: 'cmd3',
                source: 'extension',
                sourceInfo: { path: '/home/user/.pi/agent/extensions/ext2.ts' },
            },
            {
                name: 'cmd4',
                source: 'skill',
                sourceInfo: { path: '/home/user/.pi/agent/skills/skill1.ts' },
            },
        ];

        const result = calculateExtensionFiles(mockCommands);
        expect(result).toEqual(['ext1.ts', 'ext2.ts']);
    });

    it('should return <unknown> when path is missing', () => {
        const mockCommands = [
            {
                name: 'cmd1',
                source: 'extension',
                // sourceInfo missing or path missing
            },
        ];

        const result = calculateExtensionFiles(mockCommands);
        expect(result).toEqual(['<unknown>']);
    });

    it('should disambiguate duplicate basenames with parent directory', () => {
        const mockCommands = [
            {
                name: 'cmd1',
                source: 'extension',
                sourceInfo: { path: '/extensions/foo/index.ts' },
            },
            {
                name: 'cmd2',
                source: 'extension',
                sourceInfo: { path: '/extensions/bar/index.ts' },
            },
            {
                name: 'cmd3',
                source: 'extension',
                sourceInfo: { path: '/extensions/baz/index.ts' },
            },
        ];

        const result = calculateExtensionFiles(mockCommands);
        expect(result).toEqual([
            'bar/index.ts',
            'baz/index.ts',
            'foo/index.ts',
        ]);
    });

    it('should keep unique basenames as-is', () => {
        const mockCommands = [
            {
                name: 'cmd1',
                source: 'extension',
                sourceInfo: { path: '/extensions/context.ts' },
            },
            {
                name: 'cmd2',
                source: 'extension',
                sourceInfo: { path: '/extensions/cron.ts' },
            },
        ];

        const result = calculateExtensionFiles(mockCommands);
        expect(result).toEqual(['context.ts', 'cron.ts']);
    });

    it('should disambiguate only duplicates in mixed set', () => {
        const mockCommands = [
            {
                name: 'cmd1',
                source: 'extension',
                sourceInfo: { path: '/extensions/context.ts' },
            },
            {
                name: 'cmd2',
                source: 'extension',
                sourceInfo: { path: '/extensions/foo/index.ts' },
            },
            {
                name: 'cmd3',
                source: 'extension',
                sourceInfo: { path: '/extensions/bar/index.ts' },
            },
            {
                name: 'cmd4',
                source: 'extension',
                sourceInfo: { path: '/extensions/cron.ts' },
            },
        ];

        const result = calculateExtensionFiles(mockCommands);
        expect(result).toEqual([
            'bar/index.ts',
            'context.ts',
            'cron.ts',
            'foo/index.ts',
        ]);
    });

    it('should walk up until unique for deep duplicate paths', () => {
        const mockCommands = [
            {
                name: 'cmd1',
                source: 'extension',
                sourceInfo: { path: '/extensions/pi-hypa/dist/src/index.ts' },
            },
            {
                name: 'cmd2',
                source: 'extension',
                sourceInfo: { path: '/extensions/pi-roles/dist/src/index.ts' },
            },
            {
                name: 'cmd3',
                source: 'extension',
                sourceInfo: { path: '/extensions/context-mode/build/index.ts' },
            },
            {
                name: 'cmd4',
                source: 'extension',
                sourceInfo: { path: '/extensions/context.ts' },
            },
        ];

        const result = calculateExtensionFiles(mockCommands);
        expect(result).toEqual([
            'build/index.ts',
            'context.ts',
            'pi-hypa/dist/src/index.ts',
            'pi-roles/dist/src/index.ts',
        ]);
    });
});

describe('buildToolsListSnippet', () => {
    it('should render one line per tool with description', () => {
        const tools = [
            { name: 'read', description: 'Read files from disk' },
            { name: 'bash', description: 'Run shell commands' },
        ];
        const result = buildToolsListSnippet(tools);
        expect(result).toBe(
            'Available tools:\n- read: Read files from disk\n- bash: Run shell commands',
        );
    });

    it('should skip tools without a description', () => {
        const tools = [
            { name: 'read', description: 'Read files from disk' },
            { name: 'secret-tool' },
        ];
        const result = buildToolsListSnippet(tools);
        expect(result).toBe('Available tools:\n- read: Read files from disk');
    });

    it('should render (none) when no tools have descriptions', () => {
        const result = buildToolsListSnippet([]);
        expect(result).toBe('Available tools:\n(none)');
    });

    it('should collapse multi-line descriptions to first line', () => {
        const tools = [
            { name: 'bash', description: 'Run commands\nsecond line' },
        ];
        const result = buildToolsListSnippet(tools);
        expect(result).toBe('Available tools:\n- bash: Run commands');
    });
});

describe('appendToolsListPrompt', () => {
    it('should append the tools block to a prompt', () => {
        const result = appendToolsListPrompt(
            'base prompt',
            [{ name: 'read', description: 'Read files' }],
        );
        expect(result).toBe(
            'base prompt\n\nAvailable tools:\n- read: Read files',
        );
    });

    it('should be idempotent and not double-append when heading already present', () => {
        const once = appendToolsListPrompt(
            'base prompt',
            [{ name: 'read', description: 'Read files' }],
        );
        expect(appendToolsListPrompt(once, [{ name: 'bash', description: 'Run commands' }])).toBe(once);
    });

    it('should append nothing for tools without descriptions', () => {
        const result = appendToolsListPrompt('base prompt', [{ name: 'x' }]);
        expect(result).toBe('base prompt\n\nAvailable tools:\n(none)');
    });

    it('should skip when the default-branch tools heading is already present', () => {
        const defaultPrompt =
            'header\nAvailable tools:\n- read: Read files\nGuidelines:';
        const result = appendToolsListPrompt(
            defaultPrompt,
            [{ name: 'bash', description: 'Run commands' }],
        );
        expect(result).toBe(defaultPrompt);
    });
});

describe('buildContextSendMessage', () => {
    it('should render a directive plus one fenced block per file', () => {
        const files = [
            {
                path: '/home/user/.pi/agent/AGENTS.md',
                content: '# Rules\n- be concise',
            },
            {
                path: '/home/user/.pi/proj/AGENTS.md',
                content: '# Proj\n- use bun',
            },
        ];
        const result = buildContextSendMessage(files);
        expect(result).toContain('Read and follow');
        expect(result).toBe(
            'Read and follow these project instruction files. They take precedence for this repository.\n\n<project_instructions path="/home/user/.pi/agent/AGENTS.md">\n# Rules\n- be concise\n</project_instructions>\n\n<project_instructions path="/home/user/.pi/proj/AGENTS.md">\n# Proj\n- use bun\n</project_instructions>\n',
        );
    });

    it('should return empty string when no files', () => {
        expect(buildContextSendMessage([])).toBe('');
    });

    it('should preserve file order', () => {
        const files = [
            {
                path: '/a/AGENTS.md',
                content: 'first',
            },
            {
                path: '/b/AGENTS.md',
                content: 'second',
            },
        ];
        const result = buildContextSendMessage(files);
        const firstIdx = result.indexOf('first');
        const secondIdx = result.indexOf('second');
        expect(firstIdx).toBeGreaterThan(-1);
        expect(secondIdx).toBeGreaterThan(firstIdx);
    });
});

describe('getSkillPathFromCommand', () => {
    it('should return the sourceInfo.path for a skill command', () => {
        const cmd = {
            name: 'skill:my-skill',
            source: 'skill',
            sourceInfo: {
                path: '/home/user/.pi/agent/skills/my-skill/SKILL.md',
            },
        };
        expect(getSkillPathFromCommand(cmd)).toBe(
            '/home/user/.pi/agent/skills/my-skill/SKILL.md',
        );
    });

    it('should return empty string when sourceInfo is missing', () => {
        const cmd = {
            name: 'skill:my-skill',
            source: 'skill',
            // no sourceInfo
        };
        expect(getSkillPathFromCommand(cmd)).toBe('');
    });

    it('should return empty string when sourceInfo.path is missing', () => {
        const cmd = {
            name: 'skill:my-skill',
            source: 'skill',
            sourceInfo: {},
        };
        expect(getSkillPathFromCommand(cmd)).toBe('');
    });

    it('should return empty string for non-skill commands', () => {
        const cmd = {
            name: 'cmd1',
            source: 'extension',
            sourceInfo: { path: '/some/path.ts' },
        };
        expect(getSkillPathFromCommand(cmd)).toBe('');
    });
});
