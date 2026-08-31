/**
 * debug-tools — scoped write_debug_probe / edit_debug_probe tools.
 *
 * Throwaway probe/repro/harness/test scripts and notes for the `diagnose`
 * feedback loop, sandboxed under `.pi/debug/<role>/<session>/` so they can
 * never clobber real source. Registered for per-run purge (diagnose Phase 6).
 *
 * In-source instrumentation (tagged logs in real source) is deliberately out
 * of scope — use `safe_bash` for that. This tool only owns throwaway files.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { getActiveRole } from "../_shared/pi-roles.ts";
import {
    createArtifactRootRegistry,
    createScopedWriter,
    type ArtifactRootRegistry,
    type ArtifactRunRoot,
    type ScopedWriter,
} from "../_shared/scoped-write.ts";

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const DEBUG_MAX_BYTES = 4 * 1024 * 1024;
const DEBUG_EXTENSIONS = [".js", ".mjs", ".ts", ".sh", ".json", ".md"];

interface DebugProbeWriterInput {
    readonly cwd: string;
    readonly role: string | undefined;
    readonly sessionId: string;
    readonly agent: string;
}

function safeSegment(value: string | undefined, fallback: string): string {
    return value && SAFE_SEGMENT.test(value) ? value : fallback;
}

export function createDebugProbeWriter(
    input: DebugProbeWriterInput,
): ScopedWriter {
    const role = safeSegment(input.role, "unassigned");
    const sessionId = safeSegment(input.sessionId, "unassigned-session");
    return createScopedWriter({
        projectRoot: input.cwd,
        policy: {
            id: "debug-probe-v1",
            root: join(".pi", "debug", role, sessionId),
            allowedExtensions: DEBUG_EXTENSIONS,
            operations: ["create", "edit"],
            maxBytes: DEBUG_MAX_BYTES,
            auditNamespace: "debug",
            allowNestedDirectories: true,
        },
        actor: {
            agent: safeSegment(input.agent, "unknown-agent"),
            role,
            runId: sessionId,
        },
    });
}

export const commonDebugRoot: ArtifactRunRoot = {
    id: "common-debug",
    resolve(projectRoot, runId) {
        if (!SAFE_SEGMENT.test(runId)) return [];
        const debugRoot = join(projectRoot, ".pi", "debug");
        if (!existsSync(debugRoot)) return [];
        return readdirSync(debugRoot, { withFileTypes: true })
            .filter(
                (entry) => entry.isDirectory() && SAFE_SEGMENT.test(entry.name),
            )
            .map((entry) => join(debugRoot, entry.name, runId))
            .filter((path) => existsSync(path));
    },
};

export function createCommonDebugRoots(): ArtifactRootRegistry {
    const registry = createArtifactRootRegistry();
    registry.register(commonDebugRoot);
    return registry;
}

function currentRole(ctx: ExtensionContext): string | undefined {
    const activeRole = getActiveRole(ctx.sessionManager.getEntries())?.name;
    if (activeRole) return activeRole;
    return process.env.PI_SUBAGENT_CHILD === "1"
        ? process.env.PI_SUBAGENT_CHILD_AGENT
        : undefined;
}

function debugQueuePath(
    ctx: ExtensionContext,
    role: string | undefined,
): string {
    return join(
        ctx.cwd,
        ".pi",
        "debug",
        safeSegment(role, "unassigned"),
        safeSegment(ctx.sessionManager.getSessionId(), "unassigned-session"),
        ".mutation-queue",
    );
}

function toolFailure(result: { kind: string; reason?: string }): never {
    throw new Error(result.reason ?? `Scoped write failed: ${result.kind}`);
}

const writeDebugProbeSchema = Type.Object({
    path: Type.String({
        description:
            "Relative path below this role/session debug root. Throwaway probe/repro/harness/test scripts or notes.",
    }),
    content: Type.String({
        description: "Complete file content for the probe script or note.",
    }),
});

const editDebugProbeSchema = Type.Object({
    path: Type.String({
        description: "Relative path below this role/session debug root.",
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

export function registerDebugTools(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "write_debug_probe",
        label: "Write Debug Probe",
        description:
            "Create a throwaway probe, repro, harness, test script, or note under the active role/session debug root (.pi/debug/<role>/<session>/). For diagnose feedback loops; never touches real source.",
        parameters: writeDebugProbeSchema,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const role = currentRole(ctx);
            const writer = createDebugProbeWriter({
                cwd: ctx.cwd,
                role,
                sessionId: ctx.sessionManager.getSessionId(),
                agent: role ?? "unassigned",
            });
            const result = await withFileMutationQueue(
                debugQueuePath(ctx, role),
                async () =>
                    writer.create({
                        path: params.path,
                        content: params.content,
                        tool: "write_debug_probe",
                    }),
            );
            if (result.kind !== "success") toolFailure(result);
            return {
                content: [
                    {
                        type: "text",
                        text: `Debug probe written: ${result.path}`,
                    },
                ],
                details: result,
            };
        },
    });

    pi.registerTool({
        name: "edit_debug_probe",
        label: "Edit Debug Probe",
        description:
            "Edit a throwaway debug probe under the active role/session debug root using exact replacement.",
        parameters: editDebugProbeSchema,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const role = currentRole(ctx);
            const writer = createDebugProbeWriter({
                cwd: ctx.cwd,
                role,
                sessionId: ctx.sessionManager.getSessionId(),
                agent: role ?? "unassigned",
            });
            const result = await withFileMutationQueue(
                debugQueuePath(ctx, role),
                async () =>
                    writer.edit({
                        path: params.path,
                        edits: params.edits,
                        tool: "edit_debug_probe",
                    }),
            );
            if (result.kind !== "success") toolFailure(result);
            return {
                content: [
                    {
                        type: "text",
                        text: `Debug probe edited: ${result.path}`,
                    },
                ],
                details: result,
            };
        },
    });
}
