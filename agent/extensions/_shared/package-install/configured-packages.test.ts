import { describe, expect, it } from 'bun:test';
import {
    isLocalPathSource,
    parseGitSource,
    parseNpmPackageName,
    parsePackageSource,
} from './configured-packages.ts';

describe('configured package source parsing', () => {
    it('parses versioned scoped npm package names', () => {
        expect(parseNpmPackageName('npm:@scope/tool@1.2.3')).toBe(
            '@scope/tool',
        );
        expect(parsePackageSource('npm:@scope/tool@1.2.3')).toEqual({
            type: 'npm',
            name: '@scope/tool',
        });
    });

    it('distinguishes local and git package sources', () => {
        expect(isLocalPathSource('../pi-roles')).toBe(true);
        expect(parsePackageSource('../pi-roles')).toEqual({
            type: 'local',
            path: '../pi-roles',
        });
        expect(parseGitSource('git:github.com/owner/repo.git@main')).toEqual({
            type: 'git',
            host: 'github.com',
            path: 'owner/repo',
        });
    });
});
