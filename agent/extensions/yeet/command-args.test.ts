import { describe, expect, it } from 'bun:test';
import { homedir } from 'node:os';
import { parseYeetCommandArgs } from './command-args';

describe('parseYeetCommandArgs', () => {
    it('parses the space-separated CWD form and preserves instructions', () => {
        expect(
            parseYeetCommandArgs(
                '--cwd /workspace/repo commit only the formatter changes',
                '/current/repo',
            ),
        ).toEqual({
            cwd: '/workspace/repo',
            autoApprove: false,
            instructions: 'commit only the formatter changes',
        });
    });

    it('uses the current CWD when no override is supplied', () => {
        expect(
            parseYeetCommandArgs('commit docs only', '/current/repo'),
        ).toEqual({
            cwd: '/current/repo',
            autoApprove: false,
            instructions: 'commit docs only',
        });
    });

    it('parses equals CWD and auto-approve flags in any order', () => {
        expect(
            parseYeetCommandArgs(
                '--go review docs --cwd=/workspace/docs only',
                '/current/repo',
            ),
        ).toEqual({
            cwd: '/workspace/docs',
            autoApprove: true,
            instructions: 'review docs only',
        });
    });

    it('parses a quoted CWD containing spaces', () => {
        expect(
            parseYeetCommandArgs(
                '--cwd "/workspace/repo with spaces" commit docs',
                '/current/repo',
            ),
        ).toEqual({
            cwd: '/workspace/repo with spaces',
            autoApprove: false,
            instructions: 'commit docs',
        });
    });

    it('parses a quoted equals-form CWD', () => {
        expect(
            parseYeetCommandArgs(
                '--cwd="/workspace/repo with spaces"',
                '/current/repo',
            ).cwd,
        ).toBe('/workspace/repo with spaces');
    });

    it('expands a home-relative CWD', () => {
        expect(parseYeetCommandArgs('--cwd ~/repo', '/current/repo').cwd).toBe(
            `${homedir()}/repo`,
        );
    });

    it('rejects a missing CWD value', () => {
        expect(parseYeetCommandArgs('--go --cwd', '/current/repo')).toEqual({
            cwd: '/current/repo',
            autoApprove: true,
            instructions: '',
            error: '--cwd requires a path',
        });
    });
});
