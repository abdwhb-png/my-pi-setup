import { describe, expect, it, mock } from 'bun:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
    inspectDangerous,
    inspectDangerousMatches,
} from '../_shared/bash/guard';
import {
    authorizeDangerousCommand,
    authorizeDangerousMatches,
    GuardSessionApprovals,
    resolveGuardPolicy,
} from './guard-policy';

function danger(command = 'sudo apt update') {
    const match = inspectDangerous(command);
    if (!match) throw new Error('expected dangerous command');
    return match;
}

function context(options: {
    hasUI?: boolean;
    select?: () => Promise<string | undefined>;
    input?: () => Promise<string | undefined>;
} = {}): ExtensionContext {
    return {
        cwd: '/tmp',
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
        );
        expect(result).toEqual({ allowed: false, reason: danger().message });
    });

    it('allows a configured danger group without prompting', async () => {
        const result = await authorizeDangerousCommand(
            danger(),
            'allow',
            context(),
            new GuardSessionApprovals(),
        );
        expect(result).toEqual({ allowed: true });
    });

    it('fails closed when ask policy has no UI', async () => {
        const result = await authorizeDangerousCommand(
            danger(),
            'ask',
            context(),
            new GuardSessionApprovals(),
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
        );
        expect(allowOnce).toEqual({ allowed: true });

        const denied = await authorizeDangerousCommand(
            danger(),
            'ask',
            context({ hasUI: true, select: mock(async () => 'No') }),
            approvals,
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
            ),
        ).toEqual({ allowed: false, reason: match.message });
    });

    it('does not let one allowed group bypass another denied group', async () => {
        const result = await authorizeDangerousMatches(
            inspectDangerousMatches('sudo rm -rf /'),
            { rm: 'allow', sudo: 'deny' },
            context(),
            new GuardSessionApprovals(),
        );

        expect(result.allowed).toBe(false);
        expect(result.match?.groupId).toBe('sudo');
    });

    it('remembers only the exact normalized command for the session', async () => {
        const approvals = new GuardSessionApprovals();
        const select = mock(async () => 'Yes for this session');
        const ctx = context({ hasUI: true, select });

        expect(
            await authorizeDangerousCommand(danger(), 'ask', ctx, approvals),
        ).toEqual({ allowed: true });
        expect(
            await authorizeDangerousCommand(danger(), 'ask', ctx, approvals),
        ).toEqual({ allowed: true });
        expect(select).toHaveBeenCalledTimes(1);

        await authorizeDangerousCommand(
            danger('sudo apt install git'),
            'ask',
            ctx,
            approvals,
        );
        expect(select).toHaveBeenCalledTimes(2);
    });
});
