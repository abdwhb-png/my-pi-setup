import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSddConfig } from './config.ts';

test('loads the SDD defaults when settings are absent', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'sdd-config-'));
    const cwd = mkdtempSync(join(tmpdir(), 'sdd-project-'));
    try {
        expect(loadSddConfig(cwd, agentDir)).toEqual({
            agents: {
                assessor: 'orchestration-assessor',
                quickWorker: 'quick-worker',
                worker: 'sdd-worker',
                qaTester: 'sdd-qa-tester',
                browserTester: 'browser-tester',
                combinedReviewer: 'sdd-combined-reviewer',
                specReviewer: 'sdd-spec-reviewer',
                qualityReviewer: 'sdd-quality-reviewer',
            },
            models: {},
            timeoutsMs: {
                assessor: 600_000,
                worker: 2_700_000,
                reviewer: 900_000,
            },
            maxConcurrentWriters: 2,
            structuredOutputRetries: 1,
        });
    } finally {
        rmSync(agentDir, { recursive: true });
        rmSync(cwd, { recursive: true });
    }
});

test('deep-merges valid global and project settings and ignores invalid fields', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'sdd-config-'));
    const cwd = mkdtempSync(join(tmpdir(), 'sdd-project-'));
    try {
        writeFileSync(
            join(agentDir, 'settings.json'),
            JSON.stringify({
                sddOrchestrator: {
                    agents: {
                        assessor: 'custom-assessor',
                        quickWorker: 'custom-quick-worker',
                        worker: 42,
                    },
                    models: { worker: 'worker-model', unknown: 'ignored' },
                    timeoutsMs: { assessor: 1_000, reviewer: -1 },
                    maxConcurrentWriters: 4,
                    structuredOutputRetries: 0,
                },
            }),
        );
        mkdirSync(join(cwd, '.pi'));
        writeFileSync(
            join(cwd, '.pi', 'settings.json'),
            JSON.stringify({
                sddOrchestrator: {
                    agents: { assessor: '   ', worker: 'custom-worker' },
                    models: {
                        worker: '   ',
                        combinedReviewer: 'review-model',
                    },
                    timeoutsMs: { assessor: 1.5, worker: 2_000 },
                    maxConcurrentWriters: 5,
                    structuredOutputRetries: 2,
                },
            }),
        );

        expect(loadSddConfig(cwd, agentDir)).toEqual({
            agents: {
                assessor: 'custom-assessor',
                quickWorker: 'custom-quick-worker',
                worker: 'custom-worker',
                qaTester: 'sdd-qa-tester',
                browserTester: 'browser-tester',
                combinedReviewer: 'sdd-combined-reviewer',
                specReviewer: 'sdd-spec-reviewer',
                qualityReviewer: 'sdd-quality-reviewer',
            },
            models: {
                worker: 'worker-model',
                combinedReviewer: 'review-model',
            },
            timeoutsMs: {
                assessor: 1_000,
                worker: 2_000,
                reviewer: 900_000,
            },
            maxConcurrentWriters: 4,
            structuredOutputRetries: 0,
        });
    } finally {
        rmSync(agentDir, { recursive: true });
        rmSync(cwd, { recursive: true });
    }
});
