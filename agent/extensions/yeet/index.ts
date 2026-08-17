import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
    defineTool,
    type ExtensionAPI,
    type AgentToolResult,
    type ExtensionCommandContext,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type TUI } from "@earendil-works/pi-tui";
import { fdSearch } from "../_shared/file-search/fd-utils";
import { getSearchDirectories } from "../_shared/file-search/path-resolver";
import {
    findLatestActiveRoleState,
    findUnprocessedSwitchRequest,
    getDefaultRole,
    writeRoleSwitchRequest,
} from "../_shared/pi-roles";
import { queueWhenIdle } from "../_shared/queue-when-idle";
import { expandHomePath, parseYeetCommandArgs } from "./command-args";
import { CommitConfirmDialog } from "./confirm";
import {
    findLatestYeetRoleTransition,
    writeYeetRoleTransition,
} from "./role-transition";
import { CommitPlanSession } from "./session";
import type { CommitPlanParams, CommitPlanResult } from "./types";

const YEET_PROMPT_BASE = [
    "Commit the current repository changes.",
    "",
    "CRITICAL RULE: Before performing any git operations, you MUST use the 'propose_commit_plan' tool.",
    "",
    "Workflow:",
    "1. Analyze the current changes (git status, git diff) provided below.",
    "2. Group changes into logical, atomic units (e.g., separate a refactor from a feature, or a bugfix from a doc update).",
    "3. Propose the FIRST logical commit using 'propose_commit_plan' with the required CWD shown below.",
    "4. The commit happens automatically on approval.",
    "5. After a commit is successful, analyze the REMAINING changes and repeat the process until all changes are committed.",
    "6. If the user rejects a plan, adjust it and propose again.",
    "",
    "Commit Quality Guidelines:",
    "- Use Conventional Commits (e.g., 'feat:', 'fix:', 'refactor:', 'docs:').",
    "- Be descriptive. Avoid 'update files' or 'fix bugs'.",
    "- Each commit should do one thing and do it completely.",
    "",
    "IMPORTANT: If the tool returns HARD_CANCEL, stop the entire commit process immediately and return to normal conversation.",
    "Do NOT push unless explicitly requested.",
];

interface YeetRequest {
    id: string;
    targetCwd: string;
    autoApprove: boolean;
    instructions: string;
    wasQueued: boolean;
}

interface ActiveYeetTransition {
    id: string;
    previousRole: string;
    targetCwd: string;
}

type SessionEntries = ReturnType<
    ExtensionContext["sessionManager"]["getEntries"]
>;

/** Build the prompt for the LLM, injecting auto-approve instructions if needed. */
function buildYeetPrompt(isAutoApprove: boolean): string {
    if (!isAutoApprove) return YEET_PROMPT_BASE.join("\n");

    const workflowIdx = YEET_PROMPT_BASE.indexOf("Workflow:");
    const workflowLines = YEET_PROMPT_BASE.slice(workflowIdx);

    return [
        "Commit the current repository changes with AUTO-APPROVE mode.",
        "",
        "CRITICAL RULE: You MUST use the 'propose_commit_plan' tool with autoApprove=true.",
        "",
        ...workflowLines,
    ].join("\n");
}

/** Validate the explicit working directory before opening the commit UI. */
export function validateCommitCwd(cwd: string): string | null {
    if (typeof cwd !== "string" || !cwd.trim()) return "CWD is required";
    if (!isAbsolute(cwd.trim())) return `CWD must be absolute: ${cwd}`;

    const resolvedCwd = resolve(cwd.trim());
    try {
        if (!statSync(resolvedCwd).isDirectory()) {
            return `CWD is not a directory: ${cwd}`;
        }
    } catch {
        return `CWD not found: ${cwd}`;
    }

    return null;
}

/** Reject file paths that escape the explicitly supplied working directory. */
export function validateCommitFiles(
    cwd: string,
    files: string[],
): string | null {
    const resolvedCwd = resolve(cwd.trim());
    for (const file of files) {
        const resolvedFile = resolve(resolvedCwd, file);
        const relativeFile = relative(resolvedCwd, resolvedFile);
        if (
            !relativeFile ||
            relativeFile.startsWith("..") ||
            isAbsolute(relativeFile)
        ) {
            return `File is outside the supplied CWD: ${file}`;
        }
    }

    return null;
}

/**
 * Execute a git commit programmatically: stage files, commit, return the short SHA.
 * Exported for testing with a mock execFn.
 */
export async function executeCommit(
    execFn: (
        cmd: string,
        args: string[],
        opts?: any,
    ) => Promise<{ stdout: string }>,
    files: string[],
    message: string,
    cwd: string,
): Promise<{ success: true; sha: string } | { success: false; error: string }> {
    try {
        await execFn("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
        await execFn("git", ["add", "--", ...files], { cwd });
        await execFn("git", ["commit", "-m", message], { cwd });
        const { stdout } = await execFn(
            "git",
            ["rev-parse", "--short", "HEAD"],
            { cwd },
        );
        return { success: true, sha: stdout.trim() };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export default function (pi: ExtensionAPI) {
    let activeYeet: ActiveYeetTransition | null = null;
    let queuedYeet: YeetRequest | null = null;

    const cancelQueuedRequest = (request: YeetRequest): void => {
        if (!request.wasQueued) return;
        writeYeetRoleTransition(pi, {
            id: request.id,
            phase: "cancelled",
            targetCwd: request.targetCwd,
        });
    };

    const completeRoleTransition = (
        transition: ActiveYeetTransition,
        entries: SessionEntries = [],
    ): void => {
        const pendingSwitch = findUnprocessedSwitchRequest(entries);
        const restoreAlreadyPending =
            pendingSwitch?.data.targetRole === transition.previousRole &&
            pendingSwitch.data.reason === "command:yeet:restore";
        if (transition.previousRole !== "commiter" && !restoreAlreadyPending) {
            writeRoleSwitchRequest(pi, {
                targetRole: transition.previousRole,
                reason: "command:yeet:restore",
            });
        }
        writeYeetRoleTransition(pi, {
            ...transition,
            phase: "completed",
        });
    };

    const startYeet = async (
        request: YeetRequest,
        ctx: ExtensionContext,
    ): Promise<void> => {
        const { targetCwd, autoApprove, instructions } = request;

        // Inspect only when this top-level Yeet run is ready to start so a
        // queued command cannot hand the model a stale worktree snapshot.
        let gitStatus = "";
        let gitDiffStat = "";
        try {
            const statusResult = await pi.exec("git", ["status", "--short"], {
                cwd: targetCwd,
            });
            gitStatus = statusResult.stdout.trim();
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            ctx.ui.notify(
                `Unable to inspect Git repository at ${targetCwd}: ${message}`,
                "error",
            );
            cancelQueuedRequest(request);
            return;
        }

        try {
            const diffResult = await pi.exec("git", ["diff", "--stat"], {
                cwd: targetCwd,
            });
            gitDiffStat = diffResult.stdout.trim();
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            ctx.ui.notify(
                `Unable to inspect Git diff at ${targetCwd}: ${message}`,
                "error",
            );
            cancelQueuedRequest(request);
            return;
        }

        if (!gitStatus) {
            ctx.ui.notify(`Working tree is clean: ${targetCwd}`, "info");
            cancelQueuedRequest(request);
            return;
        }
        const extraLines: string[] = [];
        if (instructions) {
            extraLines.push(
                "",
                "Additional instructions from the user:\n" + instructions,
            );
        }

        const prompt = [
            buildYeetPrompt(autoApprove),
            "",
            "--- Required Commit CWD ---",
            `Required commit CWD: ${targetCwd}`,
            `Call propose_commit_plan with cwd exactly "${targetCwd}".`,
            "",
            "--- Current Git Status ---",
            gitStatus || "(no changes)",
            "",
            "--- Diff Summary ---",
            gitDiffStat || "(no diff)",
            "",
            "There are pending changes. Analyze them and propose the first atomic commit.",
            ...extraLines,
        ].join("\n");

        let activeRole = null;
        try {
            activeRole = findLatestActiveRoleState(
                ctx.sessionManager.getEntries(),
            );
        } catch {}
        const previousRole = activeRole?.name ?? getDefaultRole();
        activeYeet = {
            id: request.id,
            previousRole,
            targetCwd,
        };
        writeYeetRoleTransition(pi, {
            id: request.id,
            phase: "active",
            previousRole,
            targetCwd,
        });
        writeRoleSwitchRequest(pi, {
            targetRole: "commiter",
            reason: "command:yeet",
        });
        try {
            pi.sendUserMessage(prompt);
        } catch (error) {
            const failedYeet = activeYeet;
            activeYeet = null;
            if (failedYeet) {
                let entries: SessionEntries = [];
                try {
                    entries = ctx.sessionManager.getEntries();
                } catch {}
                completeRoleTransition(failedYeet, entries);
            }
            const message =
                error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`Unable to start /yeet: ${message}`, "error");
        }
    };

    pi.on("session_start", (_event, ctx) => {
        let entries: SessionEntries;
        try {
            entries = ctx.sessionManager.getEntries();
        } catch {
            return;
        }

        const interrupted = findLatestYeetRoleTransition(entries);
        if (!interrupted) return;
        if (interrupted.phase === "queued") {
            writeYeetRoleTransition(pi, {
                id: interrupted.id,
                phase: "cancelled",
                targetCwd: interrupted.targetCwd,
            });
            ctx.ui.notify(
                "Queued /yeet cancelled after reload; run it again",
                "warning",
            );
            return;
        }
        if (interrupted.phase !== "active") return;

        const previousRole = interrupted.previousRole;
        if (!previousRole) return;

        completeRoleTransition(
            {
                id: interrupted.id,
                previousRole,
                targetCwd: interrupted.targetCwd,
            },
            entries,
        );
    });

    pi.on("agent_end", (_event, ctx) => {
        if (!activeYeet) {
            if (!queuedYeet) return;

            const request = queuedYeet;
            queuedYeet = null;
            queueWhenIdle(
                () => startYeet(request, ctx),
                () => ctx.isIdle(),
            );
            return;
        }

        const completedYeet = activeYeet;
        activeYeet = null;
        let entries: SessionEntries = [];
        try {
            entries = ctx.sessionManager.getEntries();
        } catch {}
        completeRoleTransition(completedYeet, entries);
    });

    const proposeCommitPlanTool = defineTool({
        name: "propose_commit_plan",
        label: "Propose Commit Plan",
        description:
            "Propose a commit plan to the user. The user can review, edit the message, and toggle files in an interactive UI before approving.",
        promptSnippet:
            "Propose a commit plan for user review before staging or committing.",
        promptGuidelines: [
            "Analyze changes and group them into logical, atomic units (e.g., separate refactors from features).",
            "Propose the first logical commit using propose_commit_plan. Do NOT commit everything at once.",
            "If the tool returns ACCEPTED, the commit happens automatically.",
            "If the tool returns REJECTED, adjust the plan and propose again.",
            "After each successful commit, analyze remaining changes and propose the next commit until all are handled.",
            "If the tool returns HARD_CANCEL, stop the commit workflow immediately and return to normal conversation.",
            "Always provide cwd as the canonical absolute working directory for this commit.",
        ],
        parameters: Type.Object({
            cwd: Type.String({
                description:
                    "Required canonical absolute working directory. All files and git commands are validated against this path.",
            }),
            plan_summary: Type.String({
                description:
                    "Summary of the changes and why the commit is needed.",
            }),
            files: Type.Array(Type.String(), {
                description: "File paths to include in the commit.",
            }),
            commit_message: Type.String({
                description: "The proposed commit message.",
            }),
            autoApprove: Type.Optional(
                Type.Boolean({
                    description: "Operational flag.",
                }),
            ),
        }),
        async execute(
            _toolCallId: string,
            params: CommitPlanParams,
            _signal: AbortSignal | undefined,
            _onUpdate: unknown,
            ctx: any,
        ): Promise<AgentToolResult<CommitPlanResult>> {
            const cwdError = validateCommitCwd(params.cwd);
            const filesError = cwdError
                ? null
                : validateCommitFiles(params.cwd, params.files);
            let worktreeError: string | null = null;
            if (!cwdError && !filesError) {
                try {
                    const result = await pi.exec(
                        "git",
                        ["rev-parse", "--is-inside-work-tree"],
                        { cwd: params.cwd },
                    );
                    if (result.stdout.trim() !== "true") {
                        worktreeError = `CWD is not a Git worktree: ${params.cwd}`;
                    }
                } catch {
                    worktreeError = `CWD is not a Git worktree: ${params.cwd}`;
                }
            }
            if (cwdError || filesError || worktreeError) {
                const error = cwdError ?? filesError ?? worktreeError;
                return {
                    content: [
                        {
                            type: "text",
                            text: `Commit plan rejected: ${error}`,
                        },
                    ],
                    details: {
                        accepted: false,
                        cancelled: false,
                        plan_summary: params.plan_summary,
                        cwd: params.cwd,
                        files: [],
                        commit_message: "",
                    },
                };
            }

            let result: CommitPlanResult;

            if (params.autoApprove) {
                // Auto-approve mode: show minimal confirm dialog
                result = (await ctx.ui.custom(
                    (
                        _tui: unknown,
                        theme: unknown,
                        _kb: unknown,
                        done: (r: CommitPlanResult) => void,
                    ) =>
                        new CommitConfirmDialog({
                            theme: theme as any,
                            params,
                            done,
                        }),
                    {
                        overlay: true,
                        overlayOptions: {
                            anchor: "center" as const,
                            width: "80%" as const,
                            maxWidth: 100,
                        },
                    },
                )) as CommitPlanResult;
            } else {
                // Full TUI editor
                result = (await ctx.ui.custom(
                    (
                        tui: TUI,
                        theme: unknown,
                        _kb: unknown,
                        done: (r: CommitPlanResult) => void,
                    ) =>
                        new CommitPlanSession({
                            tui,
                            theme: theme as any,
                            params,
                            done,
                        }),
                    {
                        overlay: true,
                        overlayOptions: {
                            anchor: "center" as const,
                            width: "80%" as const,
                            maxWidth: 100,
                        },
                    },
                )) as CommitPlanResult;
            }

            // Accept → commit programmatically with loading notification
            if (result.accepted) {
                ctx.ui.notify("Committing...", "info");
                const outcome = await executeCommit(
                    pi.exec.bind(pi),
                    result.files,
                    result.commit_message,
                    result.cwd,
                );

                if (outcome.success) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: [
                                    `Commit successful (${outcome.sha}).`,
                                    "",
                                    "Repo path: " + result.cwd,
                                    "Files: " + result.files.join(", "),
                                    "Message: " + result.commit_message,
                                ].join("\n"),
                            },
                        ],
                        details: result,
                    };
                }

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: [
                                "Commit FAILED. The approved plan could not be committed automatically.",
                                "",
                                "Error: " + outcome.error,
                                "",
                                "You may need to investigate (e.g., run git status, check for conflicts) and propose a revised plan.",
                            ].join("\n"),
                        },
                    ],
                    details: result,
                };
            }

            // Reject (Ctrl+R) → repropose
            if (!result.cancelled) {
                const rejectionReason = result.rejection_reason?.trim();
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: [
                                "User REJECTED the commit plan.",
                                "",
                                rejectionReason
                                    ? `Reason: ${rejectionReason}`
                                    : "Reason: No specific reason provided; the user wants a different plan.",
                                "",
                                "You MUST call propose_commit_plan again with a different plan.",
                                "Do NOT stage or commit without approval.",
                            ].join("\n"),
                        },
                    ],
                    details: result,
                };
            }

            // Hard cancel (Esc) → stop everything
            return {
                content: [
                    {
                        type: "text" as const,
                        text: [
                            "HARD_CANCEL: The user cancelled the commit process.",
                            "",
                            "You MUST NOT call propose_commit_plan again.",
                            "Do NOT stage or commit anything.",
                            "Acknowledge the cancellation and return to normal conversation.",
                        ].join("\n"),
                    },
                ],
                details: result,
            };
        },
    });

    pi.registerTool(proposeCommitPlanTool);

    pi.registerCommand("yeet", {
        description:
            "Stage and commit repo changes. Use --cwd <path> to select a repository and --go for auto-approve mode.",
        async getArgumentCompletions(argumentPrefix: string) {
            // Extract --cwd value from argument prefix
            let cwdPath: string | null = null;

            // Match --cwd=<value> form
            const eqMatch = argumentPrefix.match(/--cwd=(.*)/);
            if (eqMatch) {
                cwdPath = eqMatch[1];
            } else {
                // Match --cwd <value> form (tokens already parsed by Pi)
                const spaceMatch = argumentPrefix.match(/--cwd\s+(.*)/);
                if (spaceMatch) {
                    cwdPath = spaceMatch[1];
                }
            }

            if (!cwdPath && !argumentPrefix.includes("--cwd")) {
                return null;
            }

            // If --cwd is present but no path yet, return empty (don't start fd for nothing)
            if (!cwdPath || cwdPath.trim() === "") {
                return null;
            }

            const expandedPath = expandHomePath(cwdPath);
            const { dirs, query, matchingRoots } = getSearchDirectories(
                expandedPath,
                { cwd: process.cwd() },
            );

            if (dirs.length === 0 && matchingRoots.length === 0) return null;

            let allEntries: string[] = [];
            for (const dir of dirs) {
                try {
                    const entries = await fdSearch({
                        baseDir: dir,
                        types: ["d"],
                        maxResults: 20,
                    });
                    allEntries.push(...entries);
                } catch {}
            }

            allEntries = [...new Set(allEntries)];

            // Prepend matching roots as top suggestions
            const rootResults = matchingRoots.map((root) => ({
                value: root,
                label: root.split("/").pop() ?? root,
                description: root,
            }));

            if (allEntries.length === 0 && rootResults.length === 0) {
                return null;
            }

            let matched = allEntries;
            if (query) {
                matched = fuzzyFilter(
                    allEntries,
                    query,
                    (e) => e.split("/").pop() ?? "",
                );
            }

            const combined = [...rootResults];
            const seen = new Set(rootResults.map((r) => r.value));
            for (const entry of matched) {
                const mapped = {
                    value: entry,
                    label: entry.split("/").pop() ?? entry,
                    description: entry,
                };
                if (!seen.has(mapped.value)) {
                    combined.push(mapped);
                    seen.add(mapped.value);
                }
            }

            if (combined.length === 0) return null;

            return combined;
        },
        handler: async (args: string, ctx: ExtensionCommandContext) => {
            const parsedArgs = parseYeetCommandArgs(args, ctx.cwd);
            if (parsedArgs.error) {
                ctx.ui.notify(parsedArgs.error, "error");
                return;
            }

            const targetCwd = resolve(ctx.cwd, parsedArgs.cwd);
            const cwdError = validateCommitCwd(targetCwd);
            if (cwdError) {
                ctx.ui.notify(cwdError, "error");
                return;
            }

            if (activeYeet) {
                ctx.ui.notify("A /yeet workflow is already active", "warning");
                return;
            }

            if (!ctx.isIdle()) {
                if (queuedYeet) {
                    ctx.ui.notify(
                        "A /yeet command is already queued",
                        "warning",
                    );
                    return;
                }
                const transitionId = randomUUID();
                queuedYeet = {
                    id: transitionId,
                    targetCwd,
                    autoApprove: parsedArgs.autoApprove,
                    instructions: parsedArgs.instructions,
                    wasQueued: true,
                };
                writeYeetRoleTransition(pi, {
                    id: transitionId,
                    phase: "queued",
                    targetCwd,
                });
                ctx.ui.notify(
                    "Queued /yeet until the current agent run finishes",
                    "info",
                );
                return;
            }

            await startYeet(
                {
                    id: randomUUID(),
                    targetCwd,
                    autoApprove: parsedArgs.autoApprove,
                    instructions: parsedArgs.instructions,
                    wasQueued: false,
                },
                ctx,
            );
        },
    });
}
