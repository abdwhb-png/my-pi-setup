import { describe, expect, it } from 'bun:test';
import {
    isDangerous,
    redirectShellCommand,
    redirectShellCommandWithPolicy,
} from './bash-guard.ts';

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
