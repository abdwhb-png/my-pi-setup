import { describe, expect, it, mock } from 'bun:test';
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
});
