import { createHash, randomUUID } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { AssessmentSchema, type Assessment } from "./assessment.ts";
import { parseAssessmentResponse } from "./prompts.ts";

const ASSESSMENT_CACHE_VERSION = 1 as const;

interface AssessmentCacheKeyInput {
    planContent: string;
    assessorAgent: string;
    assessorModel?: string;
    assessorContract?: string;
}

interface AssessmentCacheEntry {
    version: typeof ASSESSMENT_CACHE_VERSION;
    key: string;
    assessment: Assessment;
}

export interface AssessmentProgressHooks {
    onStarted?: (event: { requestId: string }) => void;
    onUpdate?: (update: AssessmentProgressUpdate) => void;
}

export interface AssessmentProgressUpdate {
    requestId: string;
    currentTool?: string;
    currentToolArgs?: string;
    recentOutput?: string;
    model?: string;
    toolCount?: number;
    durationMs?: number;
    tokens?: number;
}

export function assessmentCacheKey(input: AssessmentCacheKeyInput): string {
    return createHash("sha256")
        .update(
            JSON.stringify({
                version: ASSESSMENT_CACHE_VERSION,
                planDigest: createHash("sha256")
                    .update(input.planContent)
                    .digest("hex"),
                assessorAgent: input.assessorAgent,
                assessorModel: input.assessorModel ?? null,
                assessorContract: input.assessorContract ?? null,
                schema: AssessmentSchema,
            }),
        )
        .digest("hex");
}

export class AssessmentCache {
    private readonly root: string;
    private readonly inFlight = new Map<string, Promise<Assessment>>();

    constructor(agentDir: string) {
        this.root = resolve(agentDir, ".sdd", "assessments");
    }

    async resolve(
        key: string,
        expectedTaskIds: readonly string[],
        load: () => Promise<Assessment>,
        hooks?: AssessmentProgressHooks,
    ): Promise<Assessment> {
        const cached = this.read(key, expectedTaskIds);
        if (cached) {
            // Cache hit: report a single 'cached' blip so the caller can surface
            // instant completion instead of leaving the spinner on its previous stage.
            hooks?.onUpdate?.({ requestId: "cached", currentTool: "cached" });
            return cached;
        }
        const active = this.inFlight.get(key);
        if (active) return active;
        const pending = load()
            .then((candidate) => {
                const validated = parseAssessmentResponse(
                    JSON.stringify(candidate),
                    expectedTaskIds,
                );
                this.write(key, validated);
                return validated;
            })
            .finally(() => this.inFlight.delete(key));
        this.inFlight.set(key, pending);
        return pending;
    }

    private read(
        key: string,
        expectedTaskIds: readonly string[],
    ): Assessment | undefined {
        try {
            const entry: unknown = JSON.parse(
                readFileSync(this.path(key), "utf8"),
            );
            if (
                !entry ||
                typeof entry !== "object" ||
                !("version" in entry) ||
                entry.version !== ASSESSMENT_CACHE_VERSION ||
                !("key" in entry) ||
                entry.key !== key ||
                !("assessment" in entry)
            ) {
                return undefined;
            }
            return parseAssessmentResponse(
                JSON.stringify(entry.assessment),
                expectedTaskIds,
            );
        } catch {
            return undefined;
        }
    }

    private write(key: string, assessment: Assessment): void {
        mkdirSync(this.root, { recursive: true });
        const path = this.path(key);
        const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
        const entry: AssessmentCacheEntry = {
            version: ASSESSMENT_CACHE_VERSION,
            key,
            assessment,
        };
        try {
            writeFileSync(temporaryPath, `${JSON.stringify(entry, null, 2)}\n`);
            renameSync(temporaryPath, path);
        } finally {
            if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
        }
    }

    private path(key: string): string {
        return join(this.root, `${key}.json`);
    }
}
