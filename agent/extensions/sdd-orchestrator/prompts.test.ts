import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import type { Assessment } from './assessment.ts';
import type { SddConfig } from './config.ts';
import type { SddDelegationResponse } from './delegation-contract.ts';
import type { ApprovedManifestTask } from './manifest.ts';
import {
    buildAssessmentRequest,
    buildCorrectionRequest,
    buildReviewRequest,
    buildWorkerRequest,
    parseAssessmentResponse,
    parseReviewResponse,
    type Review,
} from './prompts.ts';
import { getSddAgentEntry } from './sdd-agents.ts';
import type { ParsedPlan } from './types.ts';

const config: SddConfig = {
    agents: {
        assessor: 'orchestration-assessor',
        quickWorker: 'quick-worker',
        worker: 'sdd-worker',
        combinedReviewer: 'sdd-combined-reviewer',
        specReviewer: 'sdd-spec-reviewer',
        qualityReviewer: 'sdd-quality-reviewer',
    },
    models: {
        assessor: 'assessor-model',
        worker: 'worker-model',
        combinedReviewer: 'combined-model',
        specReviewer: 'spec-model',
        qualityReviewer: 'quality-model',
    },
    timeoutsMs: {
        assessor: 600_000,
        worker: 2_700_000,
        reviewer: 900_000,
    },
    maxConcurrentWriters: 2,
    structuredOutputRetries: 1,
};

const approvedTask: ApprovedManifestTask = {
    id: 'task-6',
    title: 'Build prompts',
    description: 'Implement only the approved prompt contracts.',
    recommendedProfile: 'standard',
    effectiveProfile: 'standard',
    classificationRules: ['standard_signal'],
    signals: ['public_contract'],
    dependencies: ['task-1'],
    files: ['src/prompts.ts', 'src/prompts.test.ts'],
    verify: [
        {
            id: 'prompt-tests',
            command: 'bun test src/prompts.test.ts',
            timeoutMs: 30_000,
        },
    ],
    budgets: {
        initialWorkers: 1,
        correctionWorkers: 1,
        reviewerAttempts: 2,
        maxLaunches: 4,
    },
    parallelEligible: false,
};

const parsedPlan: ParsedPlan = {
    title: 'Plan',
    tasks: [
        {
            id: 'task-1',
            ordinal: 1,
            title: 'Implement parser',
            body: 'Implement the strict parser.',
            dependsOn: [],
            files: ['src/parser.ts'],
            verify: [{ id: 'test', command: 'bun test parser.test.ts' }],
        },
    ],
};

describe('buildWorkerRequest', () => {
    test('builds the bounded approved TDD task contract', () => {
        const request = buildWorkerRequest({
            requestId: 'run-1:task-6:worker:1',
            ownerRunId: 'run-1',
            nodeId: 'task-6:worker',
            cwd: '/repo',
            config,
            task: approvedTask,
        });

        expect(request).toMatchObject({
            requestId: 'run-1:task-6:worker:1',
            ownerRunId: 'run-1',
            nodeId: 'task-6:worker',
            agent: 'sdd-worker',
            model: 'worker-model',
            context: 'fresh',
            cwd: '/repo',
            timeoutMs: 2_700_000,
            artifacts: true,
            result: { kind: 'text' },
        });
        expect(request).not.toHaveProperty('turnBudget');
        expect(request).not.toHaveProperty('toolBudget');
        expect(request).not.toHaveProperty('acceptance');
        expect(request.task).toContain('Task ID: task-6');
        expect(request.task).toContain(approvedTask.description);
        for (const file of approvedTask.files) expect(request.task).toContain(file);
        expect(request.task).toContain(approvedTask.verify[0]!.command);
        expect(request.task).toContain('RED-GREEN-REFACTOR');
    });

    test('routes Light tasks to the quick worker', () => {
        const request = buildWorkerRequest({
            requestId: 'run-1:task-6:worker:1',
            ownerRunId: 'run-1',
            nodeId: 'task-6:worker',
            cwd: '/repo',
            config,
            task: { ...approvedTask, effectiveProfile: 'light' },
        });

        expect(request.agent).toBe('quick-worker');
        expect(request.model).toBe('worker-model');
    });
});

describe('buildCorrectionRequest', () => {
    test('starts a fresh bounded correction from explicit prior evidence', () => {
        const response: SddDelegationResponse = {
            version: 1,
            requestId: 'run-1:task-6:worker:1',
            status: 'completed',
            output: 'Implemented prompts and reported two files.',
            outputPath: '/artifacts/worker-output.md',
            sessionFile: '/sessions/worker.jsonl',
        };
        const findings = [
            {
                id: 'finding-1',
                severity: 'important' as const,
                file: 'src/prompts.ts',
                line: 42,
                message: 'Preserve the approved verification timeout.',
            },
        ];

        const request = buildCorrectionRequest({
            requestId: 'run-1:task-6:correction:1',
            ownerRunId: 'run-1',
            nodeId: 'task-6:correction',
            cwd: '/repo',
            config,
            task: approvedTask,
            priorResponse: response,
            findings,
            reportedChangedFiles: ['src/prompts.ts', 'src/prompts.test.ts'],
            reportedCommandResults: ['prompt-tests: pass'],
            remainingCorrections: 1,
        });

        expect(request.context).toBe('fresh');
        expect(request).not.toHaveProperty('turnBudget');
        expect(request).not.toHaveProperty('toolBudget');
        expect(request.task).toContain(approvedTask.description);
        expect(request.task).toContain(response.output!);
        expect(request.task).not.toContain('sessionFile');
        expect(request.task).toContain(JSON.stringify(findings));
        expect(request.task).toContain('src/prompts.test.ts');
        expect(request.task).toContain('prompt-tests: pass');
        expect(request.task).toContain('Remaining correction count: 1');
        expect(request.task).toContain(
            'Inspect the current working tree before editing.',
        );
    });
});

describe('structured response parsing', () => {
    const assessment = {
        version: 1,
        assessorModel: 'assessor-model',
        tasks: [
            {
                taskId: 'task-1',
                signals: ['isolated_scope'],
                evidence: [
                    {
                        signal: 'isolated_scope',
                        source: 'Task 1 lists one implementation file.',
                    },
                ],
                confidence: 'high',
                uncertainties: [],
                advisoryMinimum: 'light',
            },
            {
                taskId: 'task-2',
                signals: ['public_contract'],
                evidence: [
                    {
                        signal: 'public_contract',
                        source: 'Task 2 changes an exported interface.',
                    },
                ],
                confidence: 'high',
                uncertainties: [],
                advisoryMinimum: 'standard',
            },
        ],
    } satisfies Assessment;

    test('accepts only a complete, unique, schema-valid assessment', () => {
        expect(
            parseAssessmentResponse(JSON.stringify(assessment), [
                'task-1',
                'task-2',
            ]),
        ).toEqual(assessment);

        expect(() =>
            parseAssessmentResponse(
                JSON.stringify({ ...assessment, tasks: assessment.tasks.slice(0, 1) }),
                ['task-1', 'task-2'],
            ),
        ).toThrow('Assessment task IDs mismatch: missing task-2.');
        expect(() =>
            parseAssessmentResponse(
                JSON.stringify({
                    ...assessment,
                    tasks: [assessment.tasks[0], assessment.tasks[0]],
                }),
                ['task-1'],
            ),
        ).toThrow('Assessment task IDs mismatch: duplicate task-1.');
        expect(() =>
            parseAssessmentResponse(
                JSON.stringify({
                    ...assessment,
                    tasks: [
                        { ...assessment.tasks[0], signals: ['unknown_signal'] },
                    ],
                }),
                ['task-1'],
            ),
        ).toThrow('Structured output is invalid:');
        expect(() =>
            parseAssessmentResponse(`Result: ${JSON.stringify(assessment)}`, [
                'task-1',
                'task-2',
            ]),
        ).toThrow();

        expect(() =>
            parseAssessmentResponse(
                JSON.stringify({
                    ...assessment,
                    tasks: [{ ...assessment.tasks[0], evidence: [] }],
                }),
                ['task-1'],
            ),
        ).toThrow(
            'Assessment evidence mismatch for task-1: missing isolated_scope.',
        );
        expect(() =>
            parseAssessmentResponse(
                JSON.stringify({
                    ...assessment,
                    tasks: [
                        {
                            ...assessment.tasks[0],
                            evidence: [assessment.tasks[1]!.evidence[0]],
                        },
                    ],
                }),
                ['task-1'],
            ),
        ).toThrow(
            'Assessment evidence mismatch for task-1: missing isolated_scope; extra public_contract.',
        );
        expect(() =>
            parseAssessmentResponse(
                JSON.stringify({
                    ...assessment,
                    tasks: [
                        {
                            ...assessment.tasks[0],
                            evidence: [
                                assessment.tasks[0]!.evidence[0],
                                assessment.tasks[0]!.evidence[0],
                            ],
                        },
                    ],
                }),
                ['task-1'],
            ),
        ).toThrow(
            'Assessment evidence mismatch for task-1: duplicate isolated_scope.',
        );
        expect(() =>
            parseAssessmentResponse(
                JSON.stringify({
                    ...assessment,
                    tasks: [
                        {
                            ...assessment.tasks[0],
                            signals: ['isolated_scope', 'isolated_scope'],
                        },
                    ],
                }),
                ['task-1'],
            ),
        ).toThrow('Assessment task task-1 has duplicate signal isolated_scope.');
    });

    test('validates review schema plus the exact task and stage', () => {
        const review = {
            version: 1,
            taskId: 'task-6',
            stage: 'spec',
            verdict: 'changes_required',
            findings: [
                {
                    id: 'finding-1',
                    severity: 'important',
                    file: 'src/prompts.ts',
                    line: 42,
                    message: 'Preserve exact task IDs.',
                },
            ],
            evidence: ['Read src/prompts.ts and ran prompt tests.'],
        } satisfies Review;

        expect(
            parseReviewResponse(JSON.stringify(review), 'task-6', 'spec'),
        ).toEqual(review);
        expect(() =>
            parseReviewResponse(JSON.stringify(review), 'task-7', 'spec'),
        ).toThrow('Review task mismatch: expected task-7, received task-6.');
        expect(() =>
            parseReviewResponse(JSON.stringify(review), 'task-6', 'quality'),
        ).toThrow('Review stage mismatch: expected quality, received spec.');
        expect(() =>
            parseReviewResponse(
                JSON.stringify({ ...review, verdict: 'approve' }),
                'task-6',
                'spec',
            ),
        ).toThrow('Structured output is invalid:');
        expect(() =>
            parseReviewResponse(
                `Review:\n${JSON.stringify(review)}`,
                'task-6',
                'spec',
            ),
        ).toThrow();

        expect(() =>
            parseReviewResponse(
                JSON.stringify({ ...review, evidence: [] }),
                'task-6',
                'spec',
            ),
        ).toThrow('Review evidence must not be empty.');
        expect(() =>
            parseReviewResponse(
                JSON.stringify({ ...review, verdict: 'pass' }),
                'task-6',
                'spec',
            ),
        ).toThrow(
            'Passing review cannot contain critical or important findings.',
        );
        expect(() =>
            parseReviewResponse(
                JSON.stringify({
                    ...review,
                    verdict: 'changes_required',
                    findings: [],
                }),
                'task-6',
                'spec',
            ),
        ).toThrow('changes_required review must contain a finding.');
        expect(() =>
            parseReviewResponse(
                JSON.stringify({ ...review, verdict: 'blocked', findings: [] }),
                'task-6',
                'spec',
            ),
        ).toThrow('blocked review must contain a finding.');

        expect(
            parseReviewResponse(
                JSON.stringify({
                    ...review,
                    verdict: 'pass',
                    findings: [
                        {
                            ...review.findings[0],
                            severity: 'minor',
                            message: 'Optional naming improvement.',
                        },
                    ],
                }),
                'task-6',
                'spec',
            ).verdict,
        ).toBe('pass');
        expect(
            parseReviewResponse(
                JSON.stringify({ ...review, verdict: 'blocked' }),
                'task-6',
                'spec',
            ).verdict,
        ).toBe('blocked');
    });
});

describe('read-only request builders', () => {
    test('builds a fresh assessor request for the exact parsed tasks', () => {
        const request = buildAssessmentRequest({
            requestId: 'run-1:assessment:1',
            ownerRunId: 'run-1:assessment',
            nodeId: 'assessment',
            logicalJobId: 'run-1:assessment',
            cwd: '/repo',
            config,
            planPath: '/repo/docs/plan.md',
            plan: parsedPlan,
        });

        expect(request).toMatchObject({
            requestId: 'run-1:assessment:1',
            ownerRunId: 'run-1:assessment',
            nodeId: 'assessment',
            agent: 'orchestration-assessor',
            model: 'assessor-model',
            context: 'fresh',
            cwd: '/repo',
            timeoutMs: 600_000,
            artifacts: true,
            result: { kind: 'structured' },
        });
        expect(request).not.toHaveProperty('turnBudget');
        expect(request).not.toHaveProperty('toolBudget');
        expect(request.task).toContain('Logical job ID: run-1:assessment');
        expect(request.task).toContain('/repo/docs/plan.md');
        expect(request.task).toContain('task-1');
        expect(request.task).toContain('version-1 JSON only');
    });

    test('builds a fresh read-only reviewer request for its exact stage', () => {
        const request = buildReviewRequest({
            requestId: 'run-1:task-6:spec:1',
            ownerRunId: 'run-1',
            nodeId: 'task-6:spec',
            logicalJobId: 'run-1:task-6:spec',
            cwd: '/repo',
            config,
            task: approvedTask,
            stage: 'spec',
            implementationResponse: {
                version: 1,
                requestId: 'run-1:task-6:worker:1',
                status: 'completed',
                output: 'Implemented the approved prompt contract.',
                outputPath: '/artifacts/worker.md',
            },
        });

        expect(request).toMatchObject({
            requestId: 'run-1:task-6:spec:1',
            ownerRunId: 'run-1',
            nodeId: 'task-6:spec',
            agent: 'sdd-spec-reviewer',
            model: 'spec-model',
            context: 'fresh',
            cwd: '/repo',
            timeoutMs: 900_000,
            artifacts: true,
            result: { kind: 'structured' },
        });
        expect(request).not.toHaveProperty('turnBudget');
        expect(request).not.toHaveProperty('toolBudget');
        expect(request.task).toContain('Logical job ID: run-1:task-6:spec');
        expect(request.task).toContain('Task ID: task-6');
        expect(request.task).toContain('Review stage: spec');
        expect(request.task).toContain('Read-only');
        expect(request.task).toContain('ReviewSchema version-1 JSON only');
        expect(request.task).toContain('Evidence must be non-empty.');
        expect(request.task).toContain(
            'A pass verdict must not include critical or important findings.',
        );
        expect(request.task).toContain(
            'changes_required and blocked verdicts must include at least one finding.',
        );
        expect(request.task).toContain(
            'For blocked, the finding must explain the block.',
        );
        expect(request.task).toContain(
            'Implemented the approved prompt contract.',
        );
    });

    test('bounds one same-job schema repair and reviewer capacity', () => {
        const repair = {
            attempt: 1,
            validationError: 'Structured output is invalid: Expected number',
            originalOutput: '{"version":"one"}',
        };
        const assessmentRequest = buildAssessmentRequest({
            requestId: 'run-1:assessment:repair:1',
            ownerRunId: 'run-1:assessment',
            nodeId: 'assessment',
            logicalJobId: 'run-1:assessment',
            cwd: '/repo',
            config,
            planPath: '/repo/docs/plan.md',
            plan: parsedPlan,
            repair,
        });

        expect(assessmentRequest.task).toContain(
            'Logical job ID: run-1:assessment',
        );
        expect(assessmentRequest.task).toContain(repair.validationError);
        expect(assessmentRequest.task).toContain(repair.originalOutput);
        expect(assessmentRequest.task).toContain('Return only corrected JSON');
        expect(() =>
            buildAssessmentRequest({
                requestId: 'run-1:assessment:repair:2',
                ownerRunId: 'run-1:assessment',
                nodeId: 'assessment',
                logicalJobId: 'run-1:assessment',
                cwd: '/repo',
                config,
                planPath: '/repo/docs/plan.md',
                plan: parsedPlan,
                repair: { ...repair, attempt: 2 },
            }),
        ).toThrow('Structured output retry limit exceeded.');

        const reviewInput = {
            requestId: 'run-1:task-6:spec:repair:1',
            ownerRunId: 'run-1',
            nodeId: 'task-6:spec',
            logicalJobId: 'run-1:task-6:spec',
            cwd: '/repo',
            config,
            task: approvedTask,
            stage: 'spec' as const,
            implementationResponse: {
                version: 1 as const,
                requestId: 'run-1:task-6:worker:1',
                status: 'completed' as const,
                output: 'Implemented prompts.',
            },
            repair: {
                ...repair,
                remainingReviewerAttempts: 1,
                remainingLaunches: 1,
            },
        };
        const reviewRequest = buildReviewRequest(reviewInput);
        expect(reviewRequest.task).toContain(repair.validationError);
        expect(reviewRequest.task).toContain(repair.originalOutput);
        expect(reviewRequest.task).toContain('Return only corrected JSON');
        expect(reviewRequest.task).toContain(
            'consumes one reviewer attempt and one child launch',
        );
        for (const exhausted of [
            { remainingReviewerAttempts: 0, remainingLaunches: 1 },
            { remainingReviewerAttempts: 1, remainingLaunches: 0 },
        ]) {
            expect(() =>
                buildReviewRequest({
                    ...reviewInput,
                    repair: { ...reviewInput.repair, ...exhausted },
                }),
            ).toThrow('Reviewer schema repair has no approved budget capacity.');
        }
    });
});

describe('read-only agent contracts', () => {
    const readAgent = (name: string) =>
        readFileSync(new URL(`../../agents/${name}.md`, import.meta.url), 'utf8');
    const readRuntimeAgent = (name: string) => {
        const entry = getSddAgentEntry(name);
        if (!entry) throw new Error(`Runtime agent not found: ${name}`);
        return entry.markdown;
    };

    test('defines the assessor as a fresh read-only JSON-only role', () => {
        const agent = readAgent('orchestration-assessor');
        expect(agent).toContain('name: orchestration-assessor');
        expect(agent).toContain(
            'description: Read-only SDD complexity and risk signal assessor',
        );
        expect(agent).toContain("tools: '@inspect, @lens-inspect'");
        expect(agent).toContain('thinking: medium');
        expect(agent).toContain('systemPromptMode: replace');
        expect(agent).toContain('inheritProjectContext: true');
        expect(agent).toContain('inheritSkills: false');
        expect(agent).toContain('defaultContext: fresh');
        expect(agent).toContain('acceptanceRole: read-only');
        expect(agent).toContain('completionGuard: false');
        expect(agent).toContain('version-1 JSON only');
        expect(agent).toContain('verified plan or code evidence');
        expect(agent).toContain('Never choose dependencies or parallelism');
        expect(agent).toContain('Never edit');
        expect(agent).toContain('advisoryMinimum is non-authoritative');
    });

    test('defines stage-specific fresh read-only reviewer roles', () => {
        const contracts = {
            'sdd-combined-reviewer': 'specification plus quality',
            'sdd-spec-reviewer': 'requested behavior and acceptance',
            'sdd-quality-reviewer':
                'correctness, maintainability, tests, and repository conventions',
        } as const;

        for (const [name, focus] of Object.entries(contracts)) {
            const md = readRuntimeAgent(name);
            expect(md).toContain(`name: ${name}`);
            expect(md).toContain('safe_bash');
            expect(md).toContain('defaultContext: fresh');
            expect(md).toContain('acceptanceRole: read-only');
            expect(md).toContain('completionGuard: false');
            expect(md).toContain('thinking: high');
            expect(md).toContain(focus);
            expect(md).toContain('Never edit');
            expect(md).toContain(
                'safe_bash only for inspection and approved test commands',
            );
            expect(md).toContain('ReviewSchema JSON only');
            expect(md).toContain('Evidence must be non-empty.');
            expect(md).toContain(
                'A pass verdict must not include critical or important findings.',
            );
            expect(md).toContain(
                'changes_required and blocked verdicts must include at least one finding.',
            );
            expect(md).toContain(
                'For blocked, the finding must explain the block.',
            );
        }
    });

    test('defines sdd-qa-tester as a fresh medium read-only JSON-only role', () => {
        const md = readRuntimeAgent('sdd-qa-tester');

        expect(md).toContain('name: sdd-qa-tester');
        expect(md).toContain('description: SDD QA execution tester (NO-IMPLEMENTATION)');
        expect(md).toContain("tools: '@inspect, @lens-inspect, safe_bash, write_report'");
        expect(md).toContain('thinking: medium');
        expect(md).toContain('systemPromptMode: replace');
        expect(md).toContain('inheritProjectContext: true');
        expect(md).toContain('inheritSkills: false');
        expect(md).toContain('defaultContext: fresh');
        expect(md).toContain('acceptanceRole: read-only');
        expect(md).toContain('completionGuard: false');
        expect(md).toContain('version-1 JSON only');
        expect(md).toContain('Never edit files');
        expect(md).toContain('Never launch other agents');
        expect(md).toContain('Do not use intercom');
        expect(md).toContain(
            'Persist the final JSON payload with `write_report` at `qa-result.json`.',
        );
        expect(md).not.toContain('contact_supervisor');
        expect(md).not.toContain('skills:');
        expect(md).toContain('Use only the listed tools.');
    });

    test('defines browser-tester as a fresh medium AXI-first read-only role', () => {
        const agent = readAgent('browser-tester');

        expect(agent).toContain('name: browser-tester');
        expect(agent).toContain('description: Read-only browser validation tester');
        expect(agent).toContain('@inspect, safe_bash, write_report, contact_supervisor');
        expect(agent).toContain('skills: chrome-devtools-axi, agent-browser');
        expect(agent).toContain('thinking: medium');
        expect(agent).toContain('systemPromptMode: replace');
        expect(agent).toContain('inheritProjectContext: true');
        expect(agent).toContain('inheritSkills: false');
        expect(agent).toContain('defaultContext: fresh');
        expect(agent).toContain('acceptanceRole: read-only');
        expect(agent).toContain('completionGuard: false');
        expect(agent).toContain('Version-1 JSON only');
        expect(agent).toContain('AXI-first');
        expect(agent).toContain('isolated named session');
        expect(agent).toContain('fresh snapshot');
        expect(agent).toContain('cleanup');
        expect(agent).toContain('fallback only for technical unavailability');
        expect(agent).toContain('Do not use intercom');
        expect(agent).toContain(
            'Persist the final JSON payload with `write_report` at `browser-result.json`.',
        );
        expect(agent).toContain('No prose');
        expect(agent).toContain('Do not edit');
        expect(agent).toContain('contact_supervisor');
        expect(agent).not.toContain('@lens-inspect');
    });

    test('lets the combined reviewer return the supplied integration stage', () => {
        const request = buildReviewRequest({
            requestId: 'run-1:integration:1',
            ownerRunId: 'run-1',
            nodeId: 'manifest:integration',
            logicalJobId: 'run-1:integration',
            cwd: '/repo',
            config,
            task: approvedTask,
            stage: 'integration',
            implementationResponse: {
                version: 1,
                requestId: 'run-1:task-6:worker:1',
                status: 'completed',
                output: 'Implemented prompts.',
            },
        });
        const definition = getSddAgentEntry('sdd-combined-reviewer');
        if (!definition) throw new Error('sdd-combined-reviewer not in runtime set');
        const sys = definition.markdown;

        expect(request.agent).toBe('sdd-combined-reviewer');
        expect(request.task).toContain('Review stage: integration');
        expect(sys).toContain('supplied review stage');
        expect(sys).toContain('`combined` or `integration`');
    });
});

describe('writer agent contracts', () => {
    const agentUrl = (name: string) =>
        new URL(`../../agents/${name}.md`, import.meta.url);

    test('defines quick-worker as a strict bounded medium-thinking writer', () => {
        const agent = readFileSync(agentUrl('quick-worker'), 'utf8');

        expect(agent).toContain('name: quick-worker');
        expect(agent).toContain('thinking: medium');
        expect(agent).toContain('inheritProjectContext: true');
        expect(agent).toContain('defaultContext: fresh');
        expect(agent).toContain('turnBudget: { "maxTurns": 20, "graceTurns": 5 }');
        expect(agent).toContain('acceptanceRole: writer');
        expect(agent).not.toContain('contact_supervisor');
        expect(agent).toContain('DONE:');
        expect(agent).toContain('BLOCKED:');
        expect(agent).toMatch(/do not promote yourself/i);
        expect(existsSync(agentUrl('task-doer'))).toBeFalse();
    });

    test('defines sdd-worker as a high-thinking autonomous SDD writer', () => {
        const definition = getSddAgentEntry('sdd-worker');
        if (!definition) throw new Error('sdd-worker not in runtime set');
        const md = definition.markdown;

        expect(md).toContain('name: sdd-worker');
        expect(md).toContain('thinking: high');
        expect(md).toContain('inheritProjectContext: true');
        expect(md).toContain('defaultContext: fresh');
        expect(md).toContain('acceptanceRole: writer');
        expect(md).toContain('@implement');
        expect(md).not.toContain('contact_supervisor');
        expect(md).toContain('RED-GREEN-REFACTOR');
        expect(md).toContain('BLOCKED:');
    });

    test('configures quick-worker and sdd-worker without the legacy override', () => {
        const settings = JSON.parse(
            readFileSync(
                new URL('../../settings.example.json', import.meta.url),
                'utf8',
            ),
        ) as {
            subagents?: {
                agentOverrides?: Record<string, { model?: string }>;
            };
        };
        const overrides = settings.subagents?.agentOverrides;

        expect(overrides?.['quick-worker']?.model).toBe(
            'cpa/ocg/go-deepseek-v4-flash',
        );
        expect(overrides?.['sdd-worker']?.model).toBe(
            'cpa/ocg/go-deepseek-v4-flash',
        );
        expect(overrides?.['task-doer']).toBeUndefined();
    });

    test('limits the pi-subagents intercom bridge to forked children', () => {
        const configPath = new URL(
            '../subagent/config.json',
            import.meta.url,
        );
        const subagentConfig = JSON.parse(
            readFileSync(configPath, 'utf8'),
        ) as { intercomBridge?: { mode?: string } };

        expect(subagentConfig.intercomBridge?.mode).toBe('fork-only');
    });
});
