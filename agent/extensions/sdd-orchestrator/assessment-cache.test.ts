import { afterEach, describe, expect, test } from 'bun:test';
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Assessment } from './assessment.ts';
import { AssessmentCache, assessmentCacheKey } from './assessment-cache.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function temporaryAgentDir(): string {
    const directory = mkdtempSync(join(tmpdir(), 'sdd-assessment-cache-'));
    temporaryDirectories.push(directory);
    return directory;
}

const assessment: Assessment = {
    version: 1,
    assessorModel: 'test/assessor',
    tasks: [
        {
            taskId: 'task-1',
            signals: [
                'isolated_scope',
                'clear_requirements',
                'existing_test_pattern',
            ],
            evidence: [
                { signal: 'isolated_scope', source: 'One allowed module.' },
                { signal: 'clear_requirements', source: 'Exact outcome.' },
                {
                    signal: 'existing_test_pattern',
                    source: 'Existing focused test.',
                },
            ],
            confidence: 'high',
            uncertainties: [],
            advisoryMinimum: 'light',
        },
    ],
};

describe('AssessmentCache', () => {
    test('changes the cache key when the assessor contract changes', () => {
        const base = {
            planContent: '# Stable plan',
            assessorAgent: 'orchestration-assessor',
            assessorModel: 'test/assessor',
        };

        expect(
            assessmentCacheKey({ ...base, assessorContract: 'contract v1' }),
        ).not.toBe(
            assessmentCacheKey({ ...base, assessorContract: 'contract v2' }),
        );
    });

    test('reuses one validated assessment for the same contract key', async () => {
        const cache = new AssessmentCache(temporaryAgentDir());
        const key = assessmentCacheKey({
            planContent: '# Stable plan',
            assessorAgent: 'orchestration-assessor',
            assessorModel: 'test/assessor',
        });
        let launches = 0;
        const load = async () => {
            launches++;
            return assessment;
        };

        const first = await cache.resolve(key, ['task-1'], load);
        const second = await cache.resolve(key, ['task-1'], load);

        expect(first).toEqual(assessment);
        expect(second).toEqual(assessment);
        expect(launches).toBe(1);
    });

    test('coalesces concurrent resolutions for the same contract key', async () => {
        const cache = new AssessmentCache(temporaryAgentDir());
        const key = assessmentCacheKey({
            planContent: '# Concurrent plan',
            assessorAgent: 'orchestration-assessor',
            assessorModel: 'test/assessor',
        });
        let launches = 0;
        let release: ((value: Assessment) => void) | undefined;
        const pendingAssessment = new Promise<Assessment>((resolve) => {
            release = resolve;
        });
        const load = () => {
            launches++;
            return pendingAssessment;
        };

        const first = cache.resolve(key, ['task-1'], load);
        const second = cache.resolve(key, ['task-1'], load);
        expect(launches).toBe(1);
        release?.(assessment);

        expect(await first).toEqual(assessment);
        expect(await second).toEqual(assessment);
    });

    test('replaces a corrupt cache entry only after successful validation', async () => {
        const agentDir = temporaryAgentDir();
        const cache = new AssessmentCache(agentDir);
        const key = assessmentCacheKey({
            planContent: '# Corrupt cache',
            assessorAgent: 'orchestration-assessor',
        });
        const cacheDir = join(agentDir, '.sdd', 'assessments');
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(join(cacheDir, `${key}.json`), '{not-json');
        let launches = 0;

        const resolved = await cache.resolve(key, ['task-1'], async () => {
            launches++;
            return assessment;
        });

        expect(resolved).toEqual(assessment);
        expect(launches).toBe(1);
    });

    test('does not cache a failed assessment launch', async () => {
        const cache = new AssessmentCache(temporaryAgentDir());
        const key = assessmentCacheKey({
            planContent: '# Failed launch',
            assessorAgent: 'orchestration-assessor',
        });
        let launches = 0;

        await expect(
            cache.resolve(key, ['task-1'], async () => {
                launches++;
                throw new Error('assessor failed');
            }),
        ).rejects.toThrow('assessor failed');
        const recovered = await cache.resolve(key, ['task-1'], async () => {
            launches++;
            return assessment;
        });

        expect(recovered).toEqual(assessment);
        expect(launches).toBe(2);
    });
});
