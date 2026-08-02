import { describe, expect, it } from 'bun:test';
import {
    applyUltraSubagentProfile,
    SAVE_TOKENS_CAVEMAN_DEFAULT_LEVEL_ENV,
    SAVE_TOKENS_PONYTAIL_DEFAULT_MODE_ENV,
} from './subagent-profile.ts';
import ultraProfile from './subagent-profiles/ultra.ts';

describe('ultra subagent profile', () => {
    it('enables ultra defaults only in a pi-subagents child process', () => {
        const childEnv: NodeJS.ProcessEnv = { PI_SUBAGENT_CHILD: '1' };
        const parentEnv: NodeJS.ProcessEnv = {};

        applyUltraSubagentProfile(childEnv);
        applyUltraSubagentProfile(parentEnv);

        expect(childEnv).toMatchObject({
            [SAVE_TOKENS_CAVEMAN_DEFAULT_LEVEL_ENV]: 'ultra',
            [SAVE_TOKENS_PONYTAIL_DEFAULT_MODE_ENV]: 'ultra',
        });
        expect(childEnv).not.toHaveProperty('PONYTAIL_DEFAULT_MODE');
        expect(parentEnv).not.toHaveProperty(
            SAVE_TOKENS_CAVEMAN_DEFAULT_LEVEL_ENV,
        );
        expect(parentEnv).not.toHaveProperty(
            SAVE_TOKENS_PONYTAIL_DEFAULT_MODE_ENV,
        );
    });

    it('activates the profile through its Pi extension entry point', () => {
        const previousChild = process.env.PI_SUBAGENT_CHILD;
        const previousCaveman =
            process.env[SAVE_TOKENS_CAVEMAN_DEFAULT_LEVEL_ENV];
        const previousPonytail =
            process.env[SAVE_TOKENS_PONYTAIL_DEFAULT_MODE_ENV];

        try {
            process.env.PI_SUBAGENT_CHILD = '1';
            delete process.env[SAVE_TOKENS_CAVEMAN_DEFAULT_LEVEL_ENV];
            delete process.env[SAVE_TOKENS_PONYTAIL_DEFAULT_MODE_ENV];

            ultraProfile();

            expect(
                process.env[SAVE_TOKENS_CAVEMAN_DEFAULT_LEVEL_ENV],
            ).toBe('ultra');
            expect(
                process.env[SAVE_TOKENS_PONYTAIL_DEFAULT_MODE_ENV],
            ).toBe('ultra');
        } finally {
            if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
            else process.env.PI_SUBAGENT_CHILD = previousChild;
            if (previousCaveman === undefined) {
                delete process.env[SAVE_TOKENS_CAVEMAN_DEFAULT_LEVEL_ENV];
            } else {
                process.env[SAVE_TOKENS_CAVEMAN_DEFAULT_LEVEL_ENV] =
                    previousCaveman;
            }
            if (previousPonytail === undefined) {
                delete process.env[SAVE_TOKENS_PONYTAIL_DEFAULT_MODE_ENV];
            } else {
                process.env[SAVE_TOKENS_PONYTAIL_DEFAULT_MODE_ENV] =
                    previousPonytail;
            }
        }
    });
});
