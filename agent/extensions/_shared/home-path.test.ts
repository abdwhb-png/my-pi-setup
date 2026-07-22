import { describe, expect, it } from 'bun:test';
import {
    expandHomePath,
    resolveRuntimePath,
    toPortableHomePath,
} from './home-path.ts';

describe('home path helpers', () => {
    const home = '/home/portable-user';

    it('expands only home shorthand paths', () => {
        expect(expandHomePath('~', home)).toBe(home);
        expect(expandHomePath('~/projects/pi', home)).toBe(
            '/home/portable-user/projects/pi',
        );
        expect(expandHomePath('~other/project', home)).toBe('~other/project');
    });

    it('contracts only paths inside the home directory', () => {
        expect(toPortableHomePath('/home/portable-user', home)).toBe('~');
        expect(toPortableHomePath('/home/portable-user/projects/pi', home)).toBe(
            '~/projects/pi',
        );
        expect(toPortableHomePath('/home/portable-user-two/pi', home)).toBe(
            '/home/portable-user-two/pi',
        );
    });

    it('resolves home-relative and relative paths for filesystem I/O', () => {
        expect(resolveRuntimePath('~/plans/plan.md', '/workspace', home)).toBe(
            '/home/portable-user/plans/plan.md',
        );
        expect(resolveRuntimePath('plans/plan.md', '/workspace', home)).toBe(
            '/workspace/plans/plan.md',
        );
    });
});
