import { describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
    inspectDangerous,
    inspectDangerousMatches,
} from '../../_shared/command-execution/guard';
import {
    authorizeDangerousCommand,
    authorizeDangerousMatches,
    GuardSessionApprovals,
    resolveGuardPolicy,
} from './policy';

const PROMPT = { toolName: 'safe_bash' } as const;

function danger(command = 'sudo apt update') {
    const match = inspectDangerous(command);
    if (!match) throw new Error('expected dangerous command');
    return match;
}

function context(options: {
    hasUI?: boolean;
    cwd?: string;
    select?: () => Promise<string | undefined>;
    input?: () => Promise<string | undefined>;
} = {}): ExtensionContext {
    return {
        cwd: options.cwd ?? '/tmp',
        hasUI: options.hasUI ?? false,
        ui: {
            select: options.select ?? mock(async () => undefined),
            input: options.input ?? mock(async () => undefined),
        },
    } as unknown as ExtensionContext;
}

describe('safe-bash guard policy', () => {
    it('defaults missing groups to deny', async () => {
        expect(resolveGuardPolicy({}, 'sudo')).toBe('deny');
        const result = await authorizeDangerousCommand(
            danger(),
            'deny',
            context(),
            new GuardSessionApprovals(),
            PROMPT,
        );
        expect(result).toEqual({ allowed: false, reason: danger().message });
    });

    it('allows a configured danger group without prompting', async () => {
        const result = await authorizeDangerousCommand(
            danger(),
            'allow',
            context(),
            new GuardSessionApprovals(),
            PROMPT,
        );
        expect(result).toEqual({ allowed: true });
    });

    it('fails closed when ask policy has no UI', async () => {
        const result = await authorizeDangerousCommand(
            danger(),
            'ask',
            context(),
            new GuardSessionApprovals(),
            PROMPT,
        );
        expect(result).toEqual({
            allowed: false,
            reason: 'Permission required for safe_bash danger group sudo: sudo apt update',
        });
    });

    it('supports allow once, deny, and deny with reason', async () => {
        const approvals = new GuardSessionApprovals();
        const allowOnce = await authorizeDangerousCommand(
            danger(),
            'ask',
            context({ hasUI: true, select: mock(async () => 'Yes') }),
            approvals,
            PROMPT,
        );
        expect(allowOnce).toEqual({ allowed: true });

        const denied = await authorizeDangerousCommand(
            danger(),
            'ask',
            context({ hasUI: true, select: mock(async () => 'No') }),
            approvals,
            PROMPT,
        );
        expect(denied).toEqual({ allowed: false, reason: 'Denied by user' });

        const deniedWithReason = await authorizeDangerousCommand(
            danger(),
            'ask',
            context({
                hasUI: true,
                select: mock(async () => 'No, provide reason'),
                input: mock(async () => 'not during release'),
            }),
            approvals,
            PROMPT,
        );
        expect(deniedWithReason).toEqual({
            allowed: false,
            reason: 'not during release',
        });
    });

    it('deny overrides an exact-command session approval', async () => {
        const approvals = new GuardSessionApprovals();
        const match = danger();
        approvals.add(match);

        expect(
            await authorizeDangerousCommand(
                match,
                'deny',
                context(),
                approvals,
                PROMPT,
            ),
        ).toEqual({ allowed: false, reason: match.message });
    });

    it('does not let one allowed group bypass another denied group', async () => {
        const result = await authorizeDangerousMatches(
            inspectDangerousMatches('sudo rm -rf /'),
            { rm: 'allow', sudo: 'deny' },
            context(),
            new GuardSessionApprovals(),
            PROMPT,
        );

        expect(result.allowed).toBe(false);
        expect(result.match?.groupId).toBe('sudo');
    });

    it('remembers only the exact normalized command for the session', async () => {
        const approvals = new GuardSessionApprovals();
        const select = mock(async () => 'Yes for this session');
        const ctx = context({ hasUI: true, select });

        expect(
            await authorizeDangerousCommand(
                danger(),
                'ask',
                ctx,
                approvals,
                PROMPT,
            ),
        ).toEqual({ allowed: true });
        expect(
            await authorizeDangerousCommand(
                danger(),
                'ask',
                ctx,
                approvals,
                PROMPT,
            ),
        ).toEqual({ allowed: true });
        expect(select).toHaveBeenCalledTimes(1);

        await authorizeDangerousCommand(
            danger('sudo apt install git'),
            'ask',
            ctx,
            approvals,
            PROMPT,
        );
        expect(select).toHaveBeenCalledTimes(2);
    });

    it('code default still denies rm with an empty guardPolicy', async () => {
        const match = inspectDangerous('rm notes.md');
        if (!match) throw new Error('expected dangerous command');
        expect(resolveGuardPolicy({}, 'rm')).toBe('deny');
        const result = await authorizeDangerousCommand(
            match,
            'deny',
            context(),
            new GuardSessionApprovals(),
            PROMPT,
        );
        expect(result).toEqual({ allowed: false, reason: match.message });
    });

    it('cwd-only allows an in-cwd rm and denies an outside-cwd rm', async () => {
        const inCwd = inspectDangerous('rm notes.md');
        if (!inCwd) throw new Error('expected dangerous command');
        expect(
            await authorizeDangerousCommand(
                inCwd,
                'cwd-only',
                context({ cwd: '/home/user' }),
                new GuardSessionApprovals(),
                PROMPT,
            ),
        ).toEqual({ allowed: true });

        const outCwd = inspectDangerous('rm /etc/hosts');
        if (!outCwd) throw new Error('expected dangerous command');
        const blocked = await authorizeDangerousCommand(
            outCwd,
            'cwd-only',
            context({ cwd: '/home/user' }),
            new GuardSessionApprovals(),
            PROMPT,
        );
        expect(blocked.allowed).toBe(false);
        expect(blocked.reason).toContain('outside working dir');
        expect(blocked.reason).toContain('/etc/hosts');
    });

    it('cwd-only applies to file-delete-api interpreter one-liners', async () => {
        const inCwd = inspectDangerous(
            `python3 -c "import os; os.remove('notes.md')"`,
        );
        if (!inCwd) throw new Error('expected dangerous command');
        expect(
            await authorizeDangerousCommand(
                inCwd,
                'cwd-only',
                context({ cwd: '/home/user' }),
                new GuardSessionApprovals(),
                PROMPT,
            ),
        ).toEqual({ allowed: true });

        const outCwd = inspectDangerous(
            `python3 -c "import os; os.remove('/etc/hosts')"`,
        );
        if (!outCwd) throw new Error('expected dangerous command');
        const blocked = await authorizeDangerousCommand(
            outCwd,
            'cwd-only',
            context({ cwd: '/home/user' }),
            new GuardSessionApprovals(),
            PROMPT,
        );
        expect(blocked.allowed).toBe(false);
        expect(blocked.reason).toContain('/etc/hosts');
    });

    it('explicit deny overrides an in-cwd delete', async () => {
        const match = inspectDangerous('rm notes.md');
        if (!match) throw new Error('expected dangerous command');
        const result = await authorizeDangerousCommand(
            match,
            'deny',
            context({ cwd: '/home/user' }),
            new GuardSessionApprovals(),
            PROMPT,
        );
        expect(result).toEqual({ allowed: false, reason: match.message });
    });

    it('explicit allow permits an outside-cwd rm', async () => {
        const match = inspectDangerous('rm /etc/hosts');
        if (!match) throw new Error('expected dangerous command');
        const result = await authorizeDangerousCommand(
            match,
            'allow',
            context({ cwd: '/home/user' }),
            new GuardSessionApprovals(),
            PROMPT,
        );
        expect(result).toEqual({ allowed: true });
    });

    it('cwd-only allows an in-cwd chmod and denies an outside-cwd chmod', async () => {
        const inCwd = inspectDangerous('chmod +x bin/tool');
        if (!inCwd) throw new Error('expected chmod candidate');
        expect(
            await authorizeDangerousCommand(
                inCwd,
                'cwd-only',
                context({ cwd: '/home/user/project' }),
                new GuardSessionApprovals(),
                PROMPT,
            ),
        ).toEqual({ allowed: true });

        const outCwd = inspectDangerous('chmod 755 /opt/tool');
        if (!outCwd) throw new Error('expected chmod candidate');
        const blocked = await authorizeDangerousCommand(
            outCwd,
            'cwd-only',
            context({ cwd: '/home/user/project' }),
            new GuardSessionApprovals(),
            PROMPT,
        );
        expect(blocked.allowed).toBe(false);
        expect(blocked.reason).toContain('outside working dir');
        expect(blocked.reason).toContain('/opt/tool');
    });

    it('cwd-only blocks a protected chmod even from inside its own tree', async () => {
        const piRoot = join(homedir(), '.pi');
        const match = inspectDangerous('chmod +x bin/pi-fork');
        if (!match) throw new Error('expected chmod candidate');
        const blocked = await authorizeDangerousCommand(
            match,
            'cwd-only',
            context({ cwd: piRoot }),
            new GuardSessionApprovals(),
            PROMPT,
        );
        expect(blocked.allowed).toBe(false);
        expect(blocked.reason).toContain('protected');
        expect(blocked.reason).toContain(join(piRoot, 'bin/pi-fork'));
    });

    it('cwd-only blocks the symbolic spelling of a protected chmod target', async () => {
        const piRoot = join(homedir(), '.pi');
        const absolute = inspectDangerous(`chmod 755 ${piRoot}/bin/pi-fork`);
        const relative = inspectDangerous('chmod +x bin/pi-fork');
        if (!absolute || !relative) {
            throw new Error('expected chmod candidates');
        }
        const ctx = context({ cwd: piRoot });
        const approvals = new GuardSessionApprovals();
        for (const match of [absolute, relative]) {
            const result = await authorizeDangerousCommand(
                match,
                'cwd-only',
                ctx,
                approvals,
                PROMPT,
            );
            expect(result.allowed).toBe(false);
        }
    });

    it('cwd-only blocks catastrophic chmod modes inside cwd', async () => {        const match = inspectDangerous('chmod 777 notes.txt');
        if (!match) throw new Error('expected chmod candidate');
        const blocked = await authorizeDangerousCommand(
            match,
            'cwd-only',
            context({ cwd: '/home/user/project' }),
            new GuardSessionApprovals(),
            PROMPT,
        );
        expect(blocked.allowed).toBe(false);
        expect(blocked.reason).toContain('777');
    });

    it('cwd-only names the resolution failure instead of the generic match', async () => {
        const match = inspectDangerous('chmod +x $TARGET');
        if (!match) throw new Error('expected chmod candidate');
        const blocked = await authorizeDangerousCommand(
            match,
            'cwd-only',
            context({ cwd: '/home/user/project' }),
            new GuardSessionApprovals(),
            PROMPT,
        );
        expect(blocked.allowed).toBe(false);
        expect(blocked.reason).toContain('could not be resolved statically');
        expect(blocked.reason).toContain('chmod +x $TARGET');
    });

    it('cwd-only blocks a symlink target instead of following it', async () => {
        const root = mkdtempSync(join(tmpdir(), 'chmod-policy-'));
        try {
            writeFileSync(join(root, 'real.txt'), 'x');
            symlinkSync('real.txt', join(root, 'link.txt'));
            const match = inspectDangerous('chmod +x link.txt');
            if (!match) throw new Error('expected chmod candidate');

            const blocked = await authorizeDangerousCommand(
                match,
                'cwd-only',
                context({ cwd: root }),
                new GuardSessionApprovals(),
                PROMPT,
            );
            expect(blocked.allowed).toBe(false);
            expect(blocked.reason).toContain('symlink');
            expect(blocked.reason).toContain(join(root, 'link.txt'));
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('scope policies block chown through symlinked targets or parents', async () => {
        const root = mkdtempSync(join(tmpdir(), 'chown-policy-'));
        try {
            const cwd = join(root, 'project');
            mkdirSync(cwd);
            writeFileSync(join(root, 'outside.txt'), 'x');
            symlinkSync(join(root, 'outside.txt'), join(cwd, 'link.txt'));
            symlinkSync(root, join(cwd, 'linked-parent'));

            for (const [target, command] of [
                ['link.txt', 'chown root link.txt'],
                ['linked-parent/outside.txt', 'chown root linked-parent/outside.txt'],
            ] as const) {
                const match = inspectDangerous(command);
                if (!match) throw new Error('expected chown candidate');
                for (const policy of ['cwd-only', 'sandbox-only'] as const) {
                    const options = policy === 'cwd-only'
                        ? PROMPT
                        : {
                              toolName: 'safe_bash',
                              resolveSandboxScope: () => ({
                                  mode: 'sandbox' as const,
                                  writableRoots: [cwd],
                              }),
                          };
                    const blocked = await authorizeDangerousCommand(
                        match,
                        policy,
                        context({ cwd }),
                        new GuardSessionApprovals(),
                        options,
                    );
                    expect(blocked.allowed).toBe(false);
                    expect(blocked.reason).toContain('symlink');
                    expect(blocked.reason).toContain(join(cwd, target));
                }
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('cwd-only refuses recursive chown whose descendants cannot be scoped', async () => {
        for (const command of [
            'chown -R root .',
            'chown -RL root .',
            'chown --recursive root .',
            'chown root -R .',
            'chown root --recursive .',
        ]) {
            const match = inspectDangerous(command);
            if (!match) throw new Error('expected chown candidate');
            const blocked = await authorizeDangerousCommand(
                match,
                'cwd-only',
                context({ cwd: '/home/user/project' }),
                new GuardSessionApprovals(),
                PROMPT,
            );
            expect(blocked.allowed).toBe(false);
            expect(blocked.reason).toContain('could not be resolved statically');
        }
    });

    it('names the unresolved operand for an unresolvable rm target (audit event a507a4a4)', async () => {
        const match = inspectDangerous('rm $VAR/x');
        if (!match) throw new Error('expected rm candidate');
        const blocked = await authorizeDangerousCommand(
            match,
            'cwd-only',
            context({ cwd: '/home/user' }),
            new GuardSessionApprovals(),
            PROMPT,
        );
        expect(blocked.allowed).toBe(false);
        expect(blocked.reason).toContain('could not be resolved statically');
        expect(blocked.reason).toContain('$VAR/x');
    });

    it('separates an indirect rm form from an unresolvable operand', async () => {
        const match = inspectDangerous('find . -exec rm {} +');
        if (!match) throw new Error('expected rm candidate');
        const blocked = await authorizeDangerousCommand(
            match,
            'cwd-only',
            context({ cwd: '/home/user' }),
            new GuardSessionApprovals(),
            PROMPT,
        );
        expect(blocked.allowed).toBe(false);
        expect(blocked.reason).toContain('no resolvable invocation');
        expect(blocked.reason).not.toContain(
            'could not be resolved statically',
        );
    });

    it('carries the scope verdict and resolved targets for a denied command', async () => {
        const match = inspectDangerous('rm /etc/hosts');
        if (!match) throw new Error('expected rm candidate');
        const blocked = await authorizeDangerousCommand(
            match,
            'cwd-only',
            context({ cwd: '/home/user' }),
            new GuardSessionApprovals(),
            PROMPT,
        );
        expect(blocked.allowed).toBe(false);
        expect(blocked.scopeVerdict).toBe('outside');
        expect(blocked.scopeTargets).toContain('/etc/hosts');
    });

describe('sandbox-only and anyOf scope policies', () => {
    const SANDBOX = {
        mode: 'sandbox' as const,
        writableRoots: ['/home/user/projects/app', join(homedir(), '.pi')],
    };

    function sandboxOptions(
        scope: { mode: 'sandbox' | 'host'; writableRoots: string[] } | undefined = SANDBOX,
    ) {
        return { toolName: 'safe_bash', resolveSandboxScope: () => scope };
    }

    /** Resolver present but reporting no sandbox facts: the fail-closed case. */
    const noSandbox = {
        toolName: 'safe_bash',
        resolveSandboxScope: () => undefined,
    };

    function match(command: string) {
        const found = inspectDangerous(command);
        if (!found) throw new Error(`expected dangerous command: ${command}`);
        return found;
    }

    it('allows a granted target in sandbox mode', async () => {
        const result = await authorizeDangerousCommand(
            match('rm -rf /home/user/projects/app/dist'),
            'sandbox-only',
            context({ cwd: '/home/user/projects/app' }),
            new GuardSessionApprovals(),
            sandboxOptions(),
        );
        expect(result.allowed).toBe(true);
    });

    it('denies a granted target in host mode, naming the mode', async () => {
        const result = await authorizeDangerousCommand(
            match('rm -rf /home/user/projects/app/dist'),
            'sandbox-only',
            context({ cwd: '/home/user/projects/app' }),
            new GuardSessionApprovals(),
            sandboxOptions({ mode: 'host', writableRoots: SANDBOX.writableRoots }),
        );
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('sandbox mode');
    });

    it('denies a target outside the grants, naming the target', async () => {
        const result = await authorizeDangerousCommand(
            match('rm -rf /etc/hosts'),
            'sandbox-only',
            context({ cwd: '/home/user/projects/app' }),
            new GuardSessionApprovals(),
            sandboxOptions(),
        );
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('/etc/hosts');
        expect(result.reason).toContain('sandbox');
    });

    it('denies fail-closed when no sandbox scope is available', async () => {
        const result = await authorizeDangerousCommand(
            match('rm -rf /home/user/projects/app/dist'),
            'sandbox-only',
            context({ cwd: '/home/user/projects/app' }),
            new GuardSessionApprovals(),
            noSandbox,
        );
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('sandbox mode');
    });

    it('denies when the resolver itself is not provided', async () => {
        const result = await authorizeDangerousCommand(
            match('rm -rf /home/user/projects/app/dist'),
            'sandbox-only',
            context({ cwd: '/home/user/projects/app' }),
            new GuardSessionApprovals(),
            PROMPT,
        );
        expect(result.allowed).toBe(false);
    });

    it('keeps the protected-root veto for a chmod inside a granted root', async () => {
        const result = await authorizeDangerousCommand(
            match('chmod +x bin/pi-fork'),
            'sandbox-only',
            context({ cwd: join(homedir(), '.pi') }),
            new GuardSessionApprovals(),
            sandboxOptions(),
        );
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('protected');
    });

    it('keeps the catastrophic-mode veto under sandbox-only', async () => {
        const result = await authorizeDangerousCommand(
            match('chmod 777 notes.txt'),
            'sandbox-only',
            context({ cwd: '/home/user/projects/app' }),
            new GuardSessionApprovals(),
            sandboxOptions(),
        );
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('777');
    });

    it('scopes chown under sandbox-only', async () => {
        const inside = await authorizeDangerousCommand(
            match('chown root /home/user/projects/app/notes.txt'),
            'sandbox-only',
            context({ cwd: '/home/user/projects/app' }),
            new GuardSessionApprovals(),
            sandboxOptions(),
        );
        expect(inside.allowed).toBe(true);

        const outside = await authorizeDangerousCommand(
            match('chown root /etc/hosts'),
            'sandbox-only',
            context({ cwd: '/home/user/projects/app' }),
            new GuardSessionApprovals(),
            sandboxOptions(),
        );
        expect(outside.allowed).toBe(false);
    });

    it('anyOf allows when the first member admits', async () => {
        const result = await authorizeDangerousCommand(
            match('rm -rf /home/user/projects/app/dist'),
            { anyOf: ['cwd-only', 'sandbox-only'] },
            context({ cwd: '/home/user/projects/app' }),
            new GuardSessionApprovals(),
            sandboxOptions(),
        );
        expect(result.allowed).toBe(true);
    });

    it('anyOf allows when only the second member admits', async () => {
        const result = await authorizeDangerousCommand(
            match('rm -rf /srv/data/cache'),
            { anyOf: ['cwd-only', 'sandbox-only'] },
            context({ cwd: '/home/user/projects/app' }),
            new GuardSessionApprovals(),
            sandboxOptions({
                mode: 'sandbox',
                writableRoots: ['/srv/data'],
            }),
        );
        expect(result.allowed).toBe(true);
    });

    it('anyOf denies with evidence from every member when none admits', async () => {
        const result = await authorizeDangerousCommand(
            match('rm -rf /etc/hosts'),
            { anyOf: ['cwd-only', 'sandbox-only'] },
            context({ cwd: '/home/user/projects/app' }),
            new GuardSessionApprovals(),
            sandboxOptions({ mode: 'host', writableRoots: ['/home/user/projects/app'] }),
        );
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('cwd-only');
        expect(result.reason).toContain('sandbox-only');
    });

    it('denies a scope policy on a group with no path target, naming the group', async () => {
        for (const policy of ['cwd-only', 'sandbox-only'] as const) {
            const result = await authorizeDangerousCommand(
                match('sudo apt update'),
                policy,
                context({ cwd: '/home/user/projects/app' }),
                new GuardSessionApprovals(),
                sandboxOptions(),
            );
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('sudo');
        }
    });

    it('records the deciding member so audit evidence can tell them apart', async () => {
        const result = await authorizeDangerousCommand(
            match('rm -rf /srv/data/cache'),
            { anyOf: ['cwd-only', 'sandbox-only'] },
            context({ cwd: '/home/user/projects/app' }),
            new GuardSessionApprovals(),
            sandboxOptions({ mode: 'sandbox', writableRoots: ['/srv/data'] }),
        );
        expect(result.allowed).toBe(true);
        expect(result.scopeMember).toBe('sandbox-only');
    });
});
});
