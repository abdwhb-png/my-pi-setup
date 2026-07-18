import { describe, it, expect } from 'bun:test';
import {
    calculateExtensionFiles,
    getSkillPathFromCommand,
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
