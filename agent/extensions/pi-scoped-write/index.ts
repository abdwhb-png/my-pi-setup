import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
    type ExtensionAPI,
    type ExtensionContext,
    withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { getActiveRole } from "../_shared/pi-roles.ts";
import {
    createArtifactRootRegistry,
    createScopedWriter,
    purgeArtifacts,
    type ArtifactRunRoot,
    type ArtifactRootRegistry,
    type ScopedWriter,
} from "../_shared/scoped-write.ts";
import { commonDebugRoot, registerDebugTools } from "./debug-tools.ts";

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const REPORT_MAX_BYTES = 1_048_576;

interface ReportWriterInput {
    readonly cwd: string;
    readonly role: string | undefined;
    readonly sessionId: string;
    readonly agent: string;
}

function safeSegment(value: string | undefined, fallback: string): string {
    return value && SAFE_SEGMENT.test(value) ? value : fallback;
}

export function createReportWriter(input: ReportWriterInput): ScopedWriter {
    const role = safeSegment(input.role, "unassigned");
    const sessionId = safeSegment(input.sessionId, "unassigned-session");
    return createScopedWriter({
        projectRoot: input.cwd,
        policy: {
            id: "report-v1",
            root: join(".pi", "artifacts", "reports", role, sessionId),
            allowedExtensions: [".md", ".json"],
            operations: ["create", "edit"],
            maxBytes: REPORT_MAX_BYTES,
            auditNamespace: "reports",
            allowNestedDirectories: true,
        },
        actor: {
            agent: safeSegment(input.agent, "unknown-agent"),
            role,
            runId: sessionId,
        },
    });
}

export function createCommonArtifactRoots(): ArtifactRootRegistry {
    const registry = createArtifactRootRegistry();
    registry.register({
        id: "common-reports",
        resolve(projectRoot, runId) {
            if (!SAFE_SEGMENT.test(runId)) return [];
            const reportsRoot = join(
                projectRoot,
                ".pi",
                "artifacts",
                "reports",
            );
            if (!existsSync(reportsRoot)) return [];
            return readdirSync(reportsRoot, { withFileTypes: true })
                .filter(
                    (entry) =>
                        entry.isDirectory() && SAFE_SEGMENT.test(entry.name),
                )
                .map((entry) => join(reportsRoot, entry.name, runId))
                .filter((path) => existsSync(path));
        },
    });
    return registry;
}

const sharedRoots = createCommonArtifactRoots();
// Also expose throwaway debug probes for per-run purge (diagnose Phase 6).
sharedRoots.register(commonDebugRoot);

export function sharedArtifactRootRegistry(): ArtifactRootRegistry {
    return sharedRoots;
}

export function registerArtifactRunRoot(root: ArtifactRunRoot): void {
    sharedRoots.register(root);
}

function currentRole(ctx: ExtensionContext): string | undefined {
    const activeRole = getActiveRole(ctx.sessionManager.getEntries())?.name;
    if (activeRole) return activeRole;
    return process.env.PI_SUBAGENT_CHILD === "1"
        ? process.env.PI_SUBAGENT_CHILD_AGENT
        : undefined;
}

function reportQueuePath(
    ctx: ExtensionContext,
    role: string | undefined,
): string {
    return join(
        ctx.cwd,
        ".pi",
        "artifacts",
        "reports",
        safeSegment(role, "unassigned"),
        safeSegment(ctx.sessionManager.getSessionId(), "unassigned-session"),
        ".mutation-queue",
    );
}

function toolFailure(result: { kind: string; reason?: string }): never {
    throw new Error(result.reason ?? `Scoped write failed: ${result.kind}`);
}

const writeReportSchema = Type.Object({
    path: Type.String({
        description:
            "Relative .md or .json path below this role/session report root.",
    }),
    content: Type.String({ description: "Complete report content." }),
});

const editReportSchema = Type.Object({
    path: Type.String({
        description:
            "Relative .md or .json path below this role/session report root.",
    }),
    edits: Type.Array(
        Type.Object({
            oldText: Type.String({
                description: "Exact, unique text to replace.",
            }),
            newText: Type.String({ description: "Replacement text." }),
        }),
    ),
});

const purgeArtifactsSchema = Type.Object({
    runId: Type.String({
        description: "Exact session/run identifier to purge.",
    }),
});

export default function registerScopedWrite(pi: ExtensionAPI): void {
    const roots = sharedArtifactRootRegistry();

    registerDebugTools(pi);

    pi.registerTool({
        name: "write_report",
        label: "Write Report",
        description:
            "Create a Markdown or JSON report inside the active role and session artefact root.",
        parameters: writeReportSchema,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const role = currentRole(ctx);
            const writer = createReportWriter({
                cwd: ctx.cwd,
                role,
                sessionId: ctx.sessionManager.getSessionId(),
                agent: role ?? "unassigned",
            });
            const result = await withFileMutationQueue(
                reportQueuePath(ctx, role),
                async () =>
                    writer.create({
                        path: params.path,
                        content: params.content,
                        tool: "write_report",
                    }),
            );
            if (result.kind !== "success") toolFailure(result);
            return {
                content: [
                    { type: "text", text: `Report written: ${result.path}` },
                ],
                details: result,
            };
        },
    });

    pi.registerTool({
        name: "edit_report",
        label: "Edit Report",
        description:
            "Edit a Markdown or JSON report inside the active role and session artefact root using exact replacement.",
        parameters: editReportSchema,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const role = currentRole(ctx);
            const writer = createReportWriter({
                cwd: ctx.cwd,
                role,
                sessionId: ctx.sessionManager.getSessionId(),
                agent: role ?? "unassigned",
            });
            const result = await withFileMutationQueue(
                reportQueuePath(ctx, role),
                async () =>
                    writer.edit({
                        path: params.path,
                        edits: params.edits,
                        tool: "edit_report",
                    }),
            );
            if (result.kind !== "success") toolFailure(result);
            return {
                content: [
                    { type: "text", text: `Report edited: ${result.path}` },
                ],
                details: result,
            };
        },
    });

    pi.registerTool({
        name: "artifacts_purge",
        label: "Purge Artefacts",
        description:
            "Purge the explicitly registered artefacts of one confirmed run.",
        parameters: purgeArtifactsSchema,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            if (!ctx.hasUI) {
                throw new Error(
                    "Artifact purge requires an interactive confirmation.",
                );
            }
            const targets = roots.resolve(ctx.cwd, params.runId);
            const choice = await ctx.ui.select(
                `Purge artefacts for '${params.runId}'?\n${targets.join("\n") || "(no artefacts found)"}`,
                ["Purge", "Cancel"],
            );
            if (choice !== "Purge") {
                throw new Error("Artifact purge was cancelled.");
            }
            const role = currentRole(ctx);
            const result = purgeArtifacts({
                projectRoot: ctx.cwd,
                runId: params.runId,
                actor: {
                    agent: role ?? "unassigned",
                    role: safeSegment(role, "unassigned"),
                    runId: params.runId,
                },
                tool: "artifacts_purge",
                registry: roots,
                confirmed: true,
            });
            if (result.kind !== "success") toolFailure(result);
            return {
                content: [
                    {
                        type: "text",
                        text: `Purged ${result.removedPaths.length} artefact(s).`,
                    },
                ],
                details: result,
            };
        },
    });
}
