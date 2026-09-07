import { describe, expect, it } from 'bun:test';
import {
    inspectDeleteScope,
    isDangerous,
    redirectShellCommand,
    redirectShellCommandWithPolicy,
} from './guard.ts';

describe('bash guard', () => {
    it('blocks destructive commands but allows ordinary shell commands', () => {
        expect(isDangerous('sudo true')).toContain('Command blocked');
        expect(isDangerous('printf ok')).toBeNull();
    });

    it('redirects native-tool commands only when policy requires it', () => {
        expect(redirectShellCommand('grep needle file')).toContain(
            "Use native 'grep' tool",
        );
        expect(
            redirectShellCommandWithPolicy('grep needle file', false),
        ).toBeNull();
        expect(
            redirectShellCommandWithPolicy('grep needle file', true, ['grep']),
        ).toBeNull();
    });
});

describe('inspectDeleteScope rm', () => {
    const cwd = '/home/user/project';

    it('marks a relative file inside cwd as inside', () => {
        const scope = inspectDeleteScope('rm notes.md', cwd, 'rm');
        expect(scope.verdict).toBe('inside');
        expect(scope.targets).toContain('/home/user/project/notes.md');
        expect(scope.offendingTarget).toBeUndefined();
    });

    it('marks an absolute path inside cwd as inside', () => {
        const scope = inspectDeleteScope(
            `rm ${cwd}/notes.md`,
            cwd,
            'rm',
        );
        expect(scope.verdict).toBe('inside');
    });

    it('marks /etc/hosts as outside', () => {
        const scope = inspectDeleteScope('rm /etc/hosts', cwd, 'rm');
        expect(scope.verdict).toBe('outside');
        expect(scope.offendingTarget).toBe('/etc/hosts');
    });

    it('marks a parent-path target as outside', () => {
        const scope = inspectDeleteScope('rm ../outside', cwd, 'rm');
        expect(scope.verdict).toBe('outside');
        expect(scope.offendingTarget).toBe('/home/user/outside');
    });

    it('marks an unresolvable variable target as unknown', () => {
        const scope = inspectDeleteScope('rm $WEIRD_VAR/x', cwd, 'rm');
        expect(scope.verdict).toBe('unknown');
    });

    it('marks a bare rm as unknown', () => {
        expect(inspectDeleteScope('rm', cwd, 'rm').verdict).toBe('unknown');
    });
});

describe('inspectDeleteScope file-delete-api', () => {
    const cwd = '/home/user/project';

    it('marks a python unlink of an inside path as inside', () => {
        const scope = inspectDeleteScope(
            `python3 -c "import os; os.remove('notes.md')"`,
            cwd,
            'file-delete-api',
        );
        expect(scope.verdict).toBe('inside');
    });

    it('marks a python unlink of an outside path as outside', () => {
        const scope = inspectDeleteScope(
            `python3 -c "import os; os.remove('/etc/hosts')"`,
            cwd,
            'file-delete-api',
        );
        expect(scope.verdict).toBe('outside');
        expect(scope.offendingTarget).toBe('/etc/hosts');
    });

    it('marks a node one-liner with a variable path (no literal) as unknown', () => {
        const scope = inspectDeleteScope(
            'node -e "fs.unlinkSync(someVar)"',
            cwd,
            'file-delete-api',
        );
        expect(scope.verdict).toBe('unknown');
    });
});

describe('inspectDeleteScope unsupported groups', () => {
    it('fails closed to unknown for other groupIds', () => {
        const scope = inspectDeleteScope('rm /etc/hosts', '/tmp', 'sudo');
        expect(scope.verdict).toBe('unknown');
    });
});
