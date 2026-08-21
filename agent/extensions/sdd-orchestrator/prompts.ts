import { type Static, Type } from "@sinclair/typebox";
import { AssessmentSchema, type Assessment } from "./assessment.ts";
import type { SddConfig } from "./config.ts";
import {
    delegationOutput,
    type SddDelegationRequest,
    type SddDelegationResponse,
} from "./delegation-contract.ts";
import type { ApprovedManifestTask } from "./manifest.ts";
import { parseStrictJson } from "./schemas.ts";
import type { ParsedPlan } from "./types.ts";

interface WorkerRequestInput {
    requestId: string;
    ownerRunId: string;
    nodeId: string;
    cwd: string;
    config: SddConfig;
    task: ApprovedManifestTask;
}

export const ReviewSchema = Type.Object(
    {
        version: Type.Literal(1),
        taskId: Type.String({ minLength: 1 }),
        stage: Type.Union([
            Type.Literal("combined"),
            Type.Literal("spec"),
            Type.Literal("quality"),
            Type.Literal("integration"),
        ]),
        verdict: Type.Union([
            Type.Literal("pass"),
            Type.Literal("changes_required"),
            Type.Literal("blocked"),
        ]),
        findings: Type.Array(
            Type.Object(
                {
                    id: Type.String({ minLength: 1 }),
                    severity: Type.Union([
                        Type.Literal("critical"),
                        Type.Literal("important"),
                        Type.Literal("minor"),
                    ]),
                    file: Type.String({ minLength: 1 }),
                    line: Type.Optional(Type.Number()),
                    message: Type.String({ minLength: 1 }),
                },
                { additionalProperties: false },
            ),
        ),
        evidence: Type.Array(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
);

export type Review = Static<typeof ReviewSchema>;
export type ReviewStage = Review["stage"];
export type ReviewFinding = Review["findings"][number];

interface CorrectionRequestInput extends WorkerRequestInput {
    priorResponse: SddDelegationResponse;
    findings: readonly ReviewFinding[];
    reportedChangedFiles: readonly string[];
    reportedCommandResults: readonly string[];
    remainingCorrections: number;
}

interface AssessmentRequestInput {
    requestId: string;
    ownerRunId: string;
    nodeId: string;
    logicalJobId: string;
    cwd: string;
    config: SddConfig;
    planPath: string;
    plan: ParsedPlan;
    repair?: StructuredOutputRepair;
}

interface ReviewRequestInput {
    requestId: string;
    ownerRunId: string;
    nodeId: string;
    logicalJobId: string;
    cwd: string;
    config: SddConfig;
    task: ApprovedManifestTask;
    stage: ReviewStage;
    implementationResponse: SddDelegationResponse;
    repair?: ReviewOutputRepair;
}

interface StructuredOutputRepair {
    attempt: number;
    validationError: string;
    originalOutput: string;
}

interface ReviewOutputRepair extends StructuredOutputRepair {
    remainingReviewerAttempts: number;
    remainingLaunches: number;
}

function approvedTaskContract(task: ApprovedManifestTask): string {
    return [
        `Task ID: ${task.id}`,
        `Title: ${task.title}`,
        "",
        "Approved task body:",
        task.description,
        "",
        "Allowed files:",
        ...task.files.map((file) => `- ${file}`),
        "",
        "Acceptance commands:",
        ...task.verify.map(
            (command) =>
                `- ${command.id}: ${command.command}${
                    command.timeoutMs === undefined
                        ? ""
                        : ` (timeout ${command.timeoutMs} ms)`
                }`,
        ),
    ].join("\n");
}

function schemaRepairPrompt(repair: StructuredOutputRepair): string[] {
    return [
        "",
        `Schema-repair retry: ${repair.attempt}`,
        `Validation error: ${repair.validationError}`,
        `Original output: ${repair.originalOutput}`,
        "Return only corrected JSON for the same logical job. Do not add Markdown fences or prose.",
    ];
}

function assertRepairWithinLimit(
    repair: StructuredOutputRepair | undefined,
    config: SddConfig,
): void {
    if (
        repair &&
        (!Number.isInteger(repair.attempt) ||
            repair.attempt < 1 ||
            repair.attempt > config.structuredOutputRetries)
    ) {
        throw new Error("Structured output retry limit exceeded.");
    }
}

export function buildWorkerRequest(
    input: WorkerRequestInput,
): SddDelegationRequest {
    const agent =
        input.task.effectiveProfile === "light"
            ? input.config.agents.quickWorker
            : input.config.agents.worker;
    return {
        requestId: input.requestId,
        ownerRunId: input.ownerRunId,
        nodeId: input.nodeId,
        agent,
        task: [
            "Implement the following approved task and no other scope.",
            "",
            approvedTaskContract(input.task),
            "",
            "Use RED-GREEN-REFACTOR: observe a relevant failing test before production changes, add only enough code to pass, then refactor with tests green.",
            "Do not modify files outside the allowed file list.",
        ].join("\n"),
        context: "fresh",
        cwd: input.cwd,
        ...(input.config.models.worker === undefined
            ? {}
            : { model: input.config.models.worker }),
        timeoutMs: input.config.timeoutsMs.worker,
        artifacts: true,
        result: { kind: "text" },
    };
}

export function buildAssessmentRequest(
    input: AssessmentRequestInput,
): SddDelegationRequest {
    assertRepairWithinLimit(input.repair, input.config);
    return {
        requestId: input.requestId,
        ownerRunId: input.ownerRunId,
        nodeId: input.nodeId,
        agent: input.config.agents.assessor,
        task: [
            "Assess the compiled SDD plan as a read-only complexity and risk assessor.",
            `Logical job ID: ${input.logicalJobId}`,
            `Plan path: ${input.planPath}`,
            "",
            `Compiled plan: ${JSON.stringify(input.plan)}`,
            `Required schema: ${JSON.stringify(AssessmentSchema)}`,
            "",
            "Return version-1 JSON only. Do not add Markdown fences or prose.",
            "Report only verified signals and cite plan or code evidence.",
            "Do not choose dependencies, parallelism, or the final profile; advisoryMinimum is non-authoritative.",
            ...(input.repair ? schemaRepairPrompt(input.repair) : []),
        ].join("\n"),
        context: "fresh",
        cwd: input.cwd,
        ...(input.config.models.assessor === undefined
            ? {}
            : { model: input.config.models.assessor }),
        timeoutMs: input.config.timeoutsMs.assessor,
        artifacts: true,
        result: { kind: "structured", schema: AssessmentSchema },
    };
}

const REVIEW_AGENT = {
    combined: "combinedReviewer",
    spec: "specReviewer",
    quality: "qualityReviewer",
    integration: "combinedReviewer",
} as const;

const REVIEW_FOCUS: Record<ReviewStage, string> = {
    combined:
        "Check both the requested specification and implementation quality.",
    spec: "Check only requested behavior and acceptance requirements.",
    quality:
        "Check correctness, maintainability, tests, and repository conventions.",
    integration:
        "Check cross-task integration against the approved specification and implementation quality.",
};

export function buildReviewRequest(
    input: ReviewRequestInput,
): SddDelegationRequest {
    assertRepairWithinLimit(input.repair, input.config);
    if (
        input.repair &&
        (input.repair.remainingReviewerAttempts < 1 ||
            input.repair.remainingLaunches < 1)
    ) {
        throw new Error(
            "Reviewer schema repair has no approved budget capacity.",
        );
    }
    const agentKey = REVIEW_AGENT[input.stage];
    const implementationEvidence = delegationOutput(
        input.implementationResponse,
    );
    return {
        requestId: input.requestId,
        ownerRunId: input.ownerRunId,
        nodeId: input.nodeId,
        agent: input.config.agents[agentKey],
        task: [
            "Read-only review. Never edit files.",
            `Logical job ID: ${input.logicalJobId}`,
            `Review stage: ${input.stage}`,
            REVIEW_FOCUS[input.stage],
            "",
            approvedTaskContract(input.task),
            "",
            `Implementation result:\n${implementationEvidence ?? "(not reported)"}`,
            `Required schema: ${JSON.stringify(ReviewSchema)}`,
            "",
            "Evidence must be non-empty.",
            "A pass verdict must not include critical or important findings.",
            "changes_required and blocked verdicts must include at least one finding.",
            "For blocked, the finding must explain the block.",
            "Return ReviewSchema version-1 JSON only. Do not add Markdown fences or prose.",
            ...(input.repair
                ? [
                      `This retry consumes one reviewer attempt and one child launch; capacity before retry is ${input.repair.remainingReviewerAttempts} reviewer attempt(s) and ${input.repair.remainingLaunches} launch(es).`,
                      ...schemaRepairPrompt(input.repair),
                  ]
                : []),
        ].join("\n"),
        context: "fresh",
        cwd: input.cwd,
        ...(input.config.models[agentKey] === undefined
            ? {}
            : { model: input.config.models[agentKey] }),
        timeoutMs: input.config.timeoutsMs.reviewer,
        artifacts: true,
        result: { kind: "structured", schema: ReviewSchema },
    };
}

export function buildCorrectionRequest(
    input: CorrectionRequestInput,
): SddDelegationRequest {
    const request = buildWorkerRequest(input);
    const priorOutput = delegationOutput(input.priorResponse);
    return {
        ...request,
        task: [
            "Correct the current working tree for the following unchanged approved task contract.",
            "",
            approvedTaskContract(input.task),
            "",
            `Prior response output:\n${priorOutput ?? "(not reported)"}`,
            `Schema-validated findings: ${JSON.stringify(input.findings)}`,
            `Changed files already reported: ${JSON.stringify(
                input.reportedChangedFiles,
            )}`,
            `Command results already reported: ${JSON.stringify(
                input.reportedCommandResults,
            )}`,
            `Remaining correction count: ${input.remainingCorrections}`,
            "",
            "Inspect the current working tree before editing.",
            "Use RED-GREEN-REFACTOR and modify only the allowed files.",
        ].join("\n"),
    };
}

export function parseAssessmentResponse(
    output: string,
    expectedTaskIds: readonly string[],
): Assessment {
    const assessment = parseStrictJson(output, AssessmentSchema);
    for (const task of assessment.tasks) {
        const signals = new Set<(typeof task.signals)[number]>();
        for (const signal of task.signals) {
            if (signals.has(signal)) {
                throw new Error(
                    `Assessment task ${task.taskId} has duplicate signal ${signal}.`,
                );
            }
            signals.add(signal);
        }
        const evidenceCounts = new Map<(typeof task.signals)[number], number>();
        for (const evidence of task.evidence) {
            evidenceCounts.set(
                evidence.signal,
                (evidenceCounts.get(evidence.signal) ?? 0) + 1,
            );
        }
        const issues = [
            ...[...signals]
                .filter((signal) => !evidenceCounts.has(signal))
                .map((signal) => `missing ${signal}`),
            ...[...evidenceCounts.keys()]
                .filter((signal) => !signals.has(signal))
                .map((signal) => `extra ${signal}`),
            ...[...evidenceCounts]
                .filter(([, count]) => count > 1)
                .map(([signal]) => `duplicate ${signal}`),
        ];
        if (issues.length) {
            throw new Error(
                `Assessment evidence mismatch for ${task.taskId}: ${issues.join("; ")}.`,
            );
        }
    }
    const expected = new Set(expectedTaskIds);
    const seen = new Set<string>();
    const duplicate: string[] = [];
    for (const task of assessment.tasks) {
        if (seen.has(task.taskId) && !duplicate.includes(task.taskId)) {
            duplicate.push(task.taskId);
        }
        seen.add(task.taskId);
    }
    const missing = expectedTaskIds.filter((taskId) => !seen.has(taskId));
    const unknown = [...seen].filter((taskId) => !expected.has(taskId));
    const issues = [
        ...duplicate.map((taskId) => `duplicate ${taskId}`),
        ...missing.map((taskId) => `missing ${taskId}`),
        ...unknown.map((taskId) => `unknown ${taskId}`),
    ];
    if (issues.length) {
        throw new Error(`Assessment task IDs mismatch: ${issues.join("; ")}.`);
    }
    return assessment;
}

export function parseReviewResponse(
    output: string,
    expectedTaskId: string,
    expectedStage: ReviewStage,
): Review {
    const review = parseStrictJson(output, ReviewSchema);
    if (review.taskId !== expectedTaskId) {
        throw new Error(
            `Review task mismatch: expected ${expectedTaskId}, received ${review.taskId}.`,
        );
    }
    if (review.stage !== expectedStage) {
        throw new Error(
            `Review stage mismatch: expected ${expectedStage}, received ${review.stage}.`,
        );
    }
    if (review.evidence.length === 0) {
        throw new Error("Review evidence must not be empty.");
    }
    if (
        review.verdict === "pass" &&
        review.findings.some((finding) => finding.severity !== "minor")
    ) {
        throw new Error(
            "Passing review cannot contain critical or important findings.",
        );
    }
    if (review.verdict === "changes_required" && review.findings.length === 0) {
        throw new Error("changes_required review must contain a finding.");
    }
    if (review.verdict === "blocked" && review.findings.length === 0) {
        throw new Error("blocked review must contain a finding.");
    }
    return review;
}
