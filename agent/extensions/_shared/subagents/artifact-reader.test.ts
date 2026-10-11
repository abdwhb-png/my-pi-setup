import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { readAsyncArtifacts } from './artifact-reader.ts';

const fixtures: string[] = [];

afterEach(() => {
    for (const fixture of fixtures.splice(0)) {
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

function createFixture(): string {
    const fixture = fs.mkdtempSync(path.join(tmpdir(), 'pi-subagents-artifacts-'));
    fixtures.push(fixture);
    return fixture;
}

describe('readAsyncArtifacts', () => {
    it('reads validated status metadata and a bounded transcript tail', () => {
        const asyncDir = createFixture();
        const outputFile = path.join(asyncDir, 'output-0.log');
        fs.writeFileSync(
            outputFile,
            Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join(
                '\n',
            ),
        );
        fs.writeFileSync(
            path.join(asyncDir, 'status.json'),
            JSON.stringify({
                lifecycleArtifactVersion: 3,
                runId: 'async-1',
                state: 'running',
                currentTool: 'bash',
                model: 'provider/model',
                totalTokens: { input: 20, output: 5, total: 25 },
                outputFile,
            }),
        );

        const artifact = readAsyncArtifacts(asyncDir, {
            maxTranscriptLines: 3,
            maxTranscriptBytes: 1_024,
        });

        expect(artifact).toMatchObject({
            runId: 'async-1',
            state: 'running',
            currentTool: 'bash',
            model: 'provider/model',
            tokens: { input: 20, output: 5, total: 25 },
        });
        expect(artifact?.transcript).toBe('line-8\nline-9\nline-10');
    });

    it('rejects symlinked async directories and output files outside the run root', () => {
        const asyncDir = createFixture();
        const aliasParent = createFixture();
        const alias = path.join(aliasParent, 'async-link');
        fs.symlinkSync(asyncDir, alias, 'dir');

        expect(readAsyncArtifacts(alias)).toBeUndefined();

        const outside = path.join(aliasParent, 'outside.log');
        fs.writeFileSync(outside, 'must not be read');
        const outputLink = path.join(asyncDir, 'output-0.log');
        fs.symlinkSync(outside, outputLink, 'file');
        fs.writeFileSync(
            path.join(asyncDir, 'status.json'),
            JSON.stringify({ state: 'running', outputFile: outputLink }),
        );

        expect(readAsyncArtifacts(asyncDir)?.transcript).toBe('');
    });

    it('returns no snapshot for malformed or oversized status files', () => {
        const malformedDir = createFixture();
        fs.writeFileSync(path.join(malformedDir, 'status.json'), '{not-json');
        expect(readAsyncArtifacts(malformedDir)).toBeUndefined();

        const oversizedDir = createFixture();
        fs.writeFileSync(
            path.join(oversizedDir, 'status.json'),
            JSON.stringify({ state: 'running', padding: 'x'.repeat(128) }),
        );
        expect(
            readAsyncArtifacts(oversizedDir, { maxStatusBytes: 32 }),
        ).toBeUndefined();
    });

    it('bounds a large transcript by both bytes and lines', () => {
        const asyncDir = createFixture();
        const outputFile = path.join(asyncDir, 'output-0.log');
        fs.writeFileSync(
            outputFile,
            Array.from(
                { length: 2_000 },
                (_, index) => `${index.toString().padStart(4, '0')}-${'x'.repeat(40)}`,
            ).join('\n'),
        );
        fs.writeFileSync(
            path.join(asyncDir, 'status.json'),
            JSON.stringify({ state: 'running', outputFile }),
        );

        const artifact = readAsyncArtifacts(asyncDir, {
            maxTranscriptBytes: 256,
            maxTranscriptLines: 3,
        });
        expect(Buffer.byteLength(artifact?.transcript ?? '')).toBeLessThanOrEqual(
            256,
        );
        expect(artifact?.transcript.split('\n')).toHaveLength(3);
        expect(artifact?.transcript).toContain('1999-');
    });
});
