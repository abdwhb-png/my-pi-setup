import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { requiresPlanSubmission } from "../_shared/pi-roles/index.ts";
import {
    loadPlansConfig,
    resolvePlanFileDir,
} from "../_shared/plans-config.ts";
import {
    getToolPolicy,
    registerToolPolicyContribution,
} from "../_shared/tool-policy/index.ts";
import {
    runPlannotator,
    type ReviewDecision,
    type ReviewMode,
} from "./plannotator-cli.ts";

const GATE_ERROR =
    "submit_plan requires an active role with handoffGuard: plan-submission.";
function within(root: string, target: string) {
    const path = relative(root, target);
    return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
function resolveFile(cwd: string, raw: string): string {
    const path = raw.trim();
    if (!path) throw new Error("A local file path is required.");
    const file = realpathSync(
        resolve(
            cwd,
            path.startsWith("~/") ? join(homedir(), path.slice(2)) : path,
        ),
    );
    if (!statSync(file).isFile())
        throw new Error("Review requires a local file.");
    return file;
}
function hash(file: string): string {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function registerReviews(pi: ExtensionAPI): void {
    const policy = registerToolPolicyContribution(
        pi,
        "plans.review",
        ({ role }) =>
            requiresPlanSubmission(role)
                ? { grants: ["submit_plan"] }
                : { deny: ["submit_plan"] },
    );
    let generation = 0;
    let active: AbortController | undefined;
    pi.on("session_shutdown", () => {
        generation++;
        active?.abort();
        active = undefined;
    });
    pi.on("tool_call", (event) => {
        if (
            event.toolName === "submit_plan" &&
            !requiresPlanSubmission(getToolPolicy().getRole())
        )
            return { block: true, reason: GATE_ERROR };
        return undefined;
    });

    async function review<T>(
        ctx: ExtensionContext,
        mode: ReviewMode,
        raw: string | undefined,
        signal: AbortSignal | undefined,
        receive: (
            decision: ReviewDecision,
            file?: string,
            digest?: string,
        ) => T,
    ): Promise<T> {
        if (active)
            throw new Error("A review is already open in this session.");
        const controller = new AbortController();
        active = controller;
        const origin = generation;
        const sessionId = ctx.sessionManager.getSessionId();
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        try {
            const assertCurrent = policy.captureGuard();
            const config = loadPlansConfig(ctx.cwd, ctx.isProjectTrusted());
            const file =
                mode === "code" ? undefined : resolveFile(ctx.cwd, raw ?? "");
            if (mode === "submit") {
                const dir = resolvePlanFileDir(config);
                if (!dir)
                    throw new Error(
                        "Set plans.planFileDir in settings.json before submitting a plan.",
                    );
                const root = realpathSync(resolve(ctx.cwd, dir));
                if (
                    !file ||
                    ![".md", ".mdx"].includes(extname(file).toLowerCase()) ||
                    !within(root, file)
                )
                    throw new Error(
                        "Plan must be a Markdown file inside plans.planFileDir (including symlink targets).",
                    );
                if (statSync(file).size > 1_048_576)
                    throw new Error("Plan exceeds 1 MiB.");
            }
            const digest = mode === "submit" ? hash(file!) : undefined;
            const result = await runPlannotator({
                mode,
                cwd: ctx.cwd,
                filePath: file,
                browserCommand: config.browserCommand,
                signal: controller.signal,
            });
            assertCurrent();
            if (
                origin !== generation ||
                controller.signal.aborted ||
                ctx.sessionManager.getSessionId() !== sessionId
            )
                throw new Error("Review cancelled: session changed.");
            if (mode === "submit") {
                if (!requiresPlanSubmission(getToolPolicy().getRole()))
                    throw new Error(GATE_ERROR);
                if (
                    resolveFile(ctx.cwd, raw!) !== file ||
                    hash(file) !== digest
                )
                    throw new Error(
                        "Plan changed during review. Submit the current revision again.",
                    );
            }
            return receive(result, file, digest);
        } finally {
            signal?.removeEventListener("abort", abort);
            if (active === controller) active = undefined;
        }
    }

    pi.registerTool({
        name: "submit_plan",
        label: "Review Plan",
        description:
            "Open a saved Markdown plan in Plannotator for human review and explicit approval. filePath is relative to the project, not the plan directory. Only available to guarded planning roles.",
        parameters: Type.Object({ filePath: Type.String() }),
        executionMode: "sequential",
        async execute(_id, params, signal, _update, ctx) {
            if (!requiresPlanSubmission(getToolPolicy().getRole()))
                throw new Error(GATE_ERROR);
            return review(
                ctx,
                "submit",
                params.filePath,
                signal,
                (result, file, digest) => {
                    const approved = result.decision === "approved";
                    if (approved)
                        pi.appendEntry("plans:approved", {
                            approved,
                            planPath: file,
                            contentHash: digest,
                            feedback: result.feedback,
                            timestamp: Date.now(),
                        });
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text:
                                    result.feedback ||
                                    `Plan review: ${result.decision}.`,
                            },
                        ],
                        details: { ...result, approved, planPath: file },
                        terminate: approved,
                    };
                },
            );
        },
    });

    for (const [name, mode] of [
        ["review-file", "file"],
        ["review-code", "code"],
    ] as const) {
        pi.registerCommand(name, {
            description:
                mode === "file"
                    ? "Annotate a local document: /review-file <path>. Feedback is not sent automatically."
                    : "Review project changes in Plannotator. Feedback is not sent automatically.",
            async handler(args, ctx) {
                const origin = generation;
                try {
                    if (!ctx.hasUI)
                        throw new Error(
                            "Manual review requires an interactive Pi editor.",
                        );
                    if (mode === "code" && args.trim())
                        throw new Error(
                            "/review-code takes no arguments; choose the diff in Plannotator.",
                        );
                    await review(
                        ctx,
                        mode,
                        mode === "file" ? args : undefined,
                        ctx.signal,
                        (result) => {
                            ctx.ui.notify(
                                result.feedback ||
                                    `Review: ${result.decision}.`,
                                "info",
                            );
                            if (
                                result.feedback &&
                                ctx.ui.getEditorText() === ""
                            )
                                ctx.ui.setEditorText(result.feedback);
                        },
                    );
                } catch (error) {
                    if (origin === generation)
                        ctx.ui.notify(String(error), "error");
                }
            },
        });
    }
}
