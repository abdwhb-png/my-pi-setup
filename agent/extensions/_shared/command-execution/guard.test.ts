import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    inspectChmodScope,
    inspectCommandScope,
    inspectDeleteScope,
    inspectDangerous,
    inspectDangerousMatches,
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

    it('prevents an unrecognized allow-list entry from bypassing redirect', () => {
        expect(
            redirectShellCommandWithPolicy('grep needle file', true, [
                'rgp',
            ]),
        ).toContain("Use native 'grep' tool");
    });

    it('only recognizes exact, unmasked first words as redirectable', () => {
        // `Grep` and a `sudo` prefix are not recognized redirect targets, so
        // they pass through regardless of the allow-list.
        expect(redirectShellCommandWithPolicy('Grep needle', true, ['grep'])).toBeNull();
        expect(
            redirectShellCommandWithPolicy('sudo grep needle', true, ['grep']),
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

    it('marks an unresolvable variable operand with the raw operand', () => {
        const scope = inspectDeleteScope('rm $WEIRD_VAR/x', cwd, 'rm');
        expect(scope.verdict).toBe('unresolvable');
        expect(scope.offendingTarget).toBe('$WEIRD_VAR/x');
    });

    it('marks an invocation with no operand as unresolvable', () => {
        expect(inspectDeleteScope('rm', cwd, 'rm').verdict).toBe(
            'unresolvable',
        );
    });

    it('marks an opaque invocation form as no-invocation', () => {
        // `-exec rm` is a deletion, but no `rm`/`git rm` segment is resolvable,
        // so the guard cannot name a target. Fail closed either way.
        expect(
            inspectDeleteScope('find . -exec rm {} +', cwd, 'rm').verdict,
        ).toBe('no-invocation');
        expect(inspectDeleteScope('xargs rm', cwd, 'rm').verdict).toBe(
            'no-invocation',
        );
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

    it('marks a node one-liner with a variable path (no literal) as unresolvable', () => {
        const scope = inspectDeleteScope(
            'node -e "fs.unlinkSync(someVar)"',
            cwd,
            'file-delete-api',
        );
        expect(scope.verdict).toBe('unresolvable');
    });
});

describe('inspectDeleteScope unsupported groups', () => {
    it('fails closed to unknown for other groupIds', () => {
        const scope = inspectDeleteScope('rm /etc/hosts', '/tmp', 'sudo');
        expect(scope.verdict).toBe('unknown');
    });
});

describe('chmod danger group matching', () => {
    it('reports every chmod invocation as a scoped candidate', () => {
        expect(inspectDangerous('chmod +x script.sh')?.groupId).toBe('chmod');
        expect(inspectDangerous('chmod 755 ./build.sh')?.groupId).toBe('chmod');
    });
});

describe('inspectChmodScope', () => {
    const cwd = '/home/user/project';
    const noProtected: string[] = [];

    it('marks a relative target inside cwd as inside', () => {
        const scope = inspectChmodScope('chmod +x bin/tool', cwd, noProtected);
        expect(scope.verdict).toBe('inside');
        expect(scope.targets).toContain('/home/user/project/bin/tool');
        expect(scope.mode).toBe('+x');
        expect(scope.offendingTarget).toBeUndefined();
    });

    it('marks a cwd-absolute target as inside regardless of mode spelling', () => {
        expect(
            inspectChmodScope(`chmod 755 ${cwd}/build.sh`, cwd, noProtected)
                .verdict,
        ).toBe('inside');
        expect(
            inspectChmodScope(`chmod u+x ${cwd}/build.sh`, cwd, noProtected)
                .verdict,
        ).toBe('inside');
        expect(
            inspectChmodScope(`chmod -- 755 ${cwd}/build.sh`, cwd, noProtected)
                .verdict,
        ).toBe('inside');
        expect(
            inspectChmodScope('chmod 0o755 ./build.sh', cwd, noProtected)
                .verdict,
        ).toBe('inside');
    });

    it('marks an outside-cwd target as outside even when spelled relatively', () => {
        const scope = inspectChmodScope(
            'chmod +x ../other/tool',
            cwd,
            noProtected,
        );
        expect(scope.verdict).toBe('outside');
        expect(scope.offendingTarget).toBe('/home/user/other/tool');
    });

    it('marks an absolute system target as outside', () => {
        const scope = inspectChmodScope('chmod 755 /opt/tool', cwd, noProtected);
        expect(scope.verdict).toBe('outside');
        expect(scope.offendingTarget).toBe('/opt/tool');
    });

    it('blocks a protected root even when cwd is inside it', () => {
        const piRoot = join(homedir(), '.pi');
        const scope = inspectChmodScope('chmod +x bin/pi-fork', piRoot, [
            piRoot,
        ]);
        expect(scope.verdict).toBe('protected');
        expect(scope.offendingTarget).toBe(join(piRoot, 'bin/pi-fork'));
    });

    it('treats the root directory as a protected target', () => {
        expect(inspectChmodScope('chmod 777 /', cwd, noProtected).verdict).toBe(
            'outside',
        );
    });

    it('flags world-writable and setuid modes as catastrophic anywhere', () => {
        for (const mode of ['777', '1777', '666', '4755', '2755']) {
            const scope = inspectChmodScope(
                `chmod ${mode} notes.txt`,
                cwd,
                noProtected,
            );
            expect(scope.verdict).toBe('catastrophic-mode');
            expect(scope.mode).toBe(mode);
        }
    });

    it('flags symbolic modes that grant other-write or setuid', () => {
        for (const mode of ['o+w', 'a+w', 'a+rwx', 'u+s', 'ug+s', 'o=rw']) {
            expect(
                inspectChmodScope(
                    `chmod ${mode} notes.txt`,
                    cwd,
                    noProtected,
                ).verdict,
            ).toBe('catastrophic-mode');
        }
    });

    it('allows benign modes inside cwd', () => {
        for (const mode of ['+x', 'u+x', '-x', '755', '644', '664', 'u+rwx,g-w']) {
            expect(
                inspectChmodScope(
                    `chmod ${mode} notes.txt`,
                    cwd,
                    noProtected,
                ).verdict,
            ).toBe('inside');
        }
    });

    it('marks an unresolvable variable target as unknown', () => {
        expect(
            inspectChmodScope('chmod +x $TARGET', cwd, noProtected).verdict,
        ).toBe('unknown');
    });

    it('marks a chmod without a resolvable target as unknown', () => {
        expect(inspectChmodScope('chmod 755', cwd, noProtected).verdict).toBe(
            'unknown',
        );
    });
});

describe('inspectChmodScope symlink targets', () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'chmod-scope-'));
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('rejects a symlink target because chmod would follow it', () => {
        writeFileSync(join(root, 'real.txt'), 'x');
        symlinkSync('real.txt', join(root, 'link.txt'));

        const scope = inspectChmodScope('chmod +x link.txt', root, []);
        expect(scope.verdict).toBe('symlink');
        expect(scope.offendingTarget).toBe(join(root, 'link.txt'));
    });

    it('reports the symlink rather than the outside target it points at', () => {
        mkdirSync(join(root, 'project'));
        symlinkSync(join(root, 'outside.txt'), join(root, 'project', 'escape'));

        const scope = inspectChmodScope(
            'chmod 755 escape',
            join(root, 'project'),
            [],
        );
        expect(scope.verdict).toBe('symlink');
        expect(scope.offendingTarget).toBe(join(root, 'project', 'escape'));
    });

    it('keeps the lexical verdict for a nonexistent target', () => {
        expect(inspectChmodScope('chmod +x ghost.txt', root, []).verdict).toBe(
            'inside',
        );
        expect(
            inspectChmodScope('chmod +x ../ghost.txt', root, []).verdict,
        ).toBe('outside');
    });

    it('leaves a symlinked intermediate component unresolved (residual)', () => {
        mkdirSync(join(root, 'realdir'));
        writeFileSync(join(root, 'realdir', 'f.txt'), 'x');
        symlinkSync('realdir', join(root, 'linkdir'));

        // Only the final component is inspected, so a symlinked parent stays
        // lexically inside. Documented residual — not a containment guarantee.
        expect(
            inspectChmodScope('chmod 755 linkdir/f.txt', root, []).verdict,
        ).toBe('inside');
    });
});

describe('rm group anchoring (audit events 53ab0c7f, d955fa02)', () => {
    const cwd = '/home/user/project';

    it.each([
        'rm file',
        'rm',
        'cd /some/path && rm file.txt',
        'sudo rm file',
        'command rm file',
        'env FOO=1 rm file',
        'git rm file',
        'xargs rm',
        'find . -exec rm {} +',
        '  rm -rf dist/',
    ])('still matches an rm invocation: %s', (command) => {
        expect(inspectDangerous(command)?.groupId).toBe('rm');
    });

    it.each([
        `bun -e 'import { mkdtemp, rm } from "node:fs/promises"; const dir = await mkdtemp("x");'`,
        'echo "rm is dangerous"',
        'echo unlink-me',
    ])('does not match rm text that is not an invocation: %s', (command) => {
        expect(inspectDangerous(command)).toBeNull();
    });

    it('routes git rm through the scope check instead of blocking it blindly', () => {
        const scope = inspectDeleteScope('git rm notes.md', cwd, 'rm');
        expect(scope.verdict).toBe('inside');
        expect(scope.targets).toContain('/home/user/project/notes.md');
    });

    it('keeps an outside-cwd git rm outside', () => {
        const scope = inspectDeleteScope('git rm /etc/hosts', cwd, 'rm');
        expect(scope.verdict).toBe('outside');
        expect(scope.offendingTarget).toBe('/etc/hosts');
    });
});

describe('shutdown group anchoring (audit event 9697380d)', () => {
    it.each([
        'shutdown -h now',
        'reboot',
        'systemctl poweroff',
        'systemctl reboot',
    ])('still matches a power command: %s', (command) => {
        expect(inspectDangerous(command)?.groupId).toBe('shutdown');
    });

    it('matches a power command behind sudo (sudo group reports first)', () => {
        expect(
            inspectDangerousMatches('sudo reboot').map((match) => match.groupId),
        ).toContain('shutdown');
    });

    it('does not match the word inside a python heredoc string literal', () => {
        const command = `python3 << 'PY'\ncode = script.replace('waitDone', 'shutdown')\nprint(code)\nPY`;
        expect(inspectDangerous(command)).toBeNull();
    });
});

describe('interpreter deletion coverage (hole-closing for event 53ab0c7f)', () => {
    it.each([
        `bun -e "import {rm} from 'node:fs/promises'; await rm(dir, { recursive: true })"`,
        `bun --eval="import {rm} from 'node:fs/promises'; await rm(dir)"`,
        `node -e "import {rm} from 'node:fs/promises'; await rm(dir, { recursive: true })"`,
        `bun -e "const { rmSync } = require('node:fs'); rmSync('dist', { recursive: true })"`,
    ])('blocks a bare deletion call in an interpreter one-liner: %s', (command) => {
        expect(inspectDangerous(command)?.groupId).toBe('file-delete-api');
    });

    it('does not block an import-only bun one-liner', () => {
        const command = `bun -e 'import { mkdtemp, rm } from "node:fs/promises"; const dir = await mkdtemp("x");'`;
        expect(inspectDangerous(command)).toBeNull();
    });
});

describe('inspectCommandScope dispatch', () => {
    const cwd = '/home/user/project';

    it('routes rm and file-delete-api to the delete scope', () => {
        expect(inspectCommandScope('rm notes.md', cwd, 'rm').verdict).toBe(
            'inside',
        );
        expect(
            inspectCommandScope(
                `python3 -c "import os; os.remove('/etc/hosts')"`,
                cwd,
                'file-delete-api',
            ).verdict,
        ).toBe('outside');
    });

    it('routes chmod to the chmod scope', () => {
        expect(
            inspectCommandScope('chmod 777 notes.md', cwd, 'chmod').verdict,
        ).toBe('catastrophic-mode');
        expect(
            inspectCommandScope('chmod +x notes.md', cwd, 'chmod').verdict,
        ).toBe('inside');
    });

    it('fails closed to unknown for unsupported groups', () => {
        expect(inspectCommandScope('sudo true', cwd, 'sudo').verdict).toBe(
            'unknown',
        );
    });

    it('keeps rm scope lexical: deleting a symlink removes the link itself', () => {
        const root = mkdtempSync(join(tmpdir(), 'rm-scope-'));
        try {
            writeFileSync(join(root, 'real.txt'), 'x');
            symlinkSync('real.txt', join(root, 'link.txt'));
            expect(inspectCommandScope('rm link.txt', root, 'rm').verdict).toBe(
                'inside',
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
