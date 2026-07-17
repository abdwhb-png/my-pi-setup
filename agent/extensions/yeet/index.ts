import { statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import {
    defineTool,
    type ExtensionAPI,
    type AgentToolResult,
} from '@earendil-works/pi-coding-agent';
import { CommitConfirmDialog } from './confirm';
import { CommitPlanSession } from './session';
import type { CommitPlanParams, CommitPlanResult } from './types';

const YEET_PROMPT_BASE = [
    'Commit the current repository changes.',
    '',
    "CRITICAL RULE: Before performing any git operations, you MUST use the 'propose_commit_plan' tool.",
    '',
    'Workflow:',
    '1. Analyze the current changes (git status, git diff) provided below.',
    '2. Group changes into logical, atomic units (e.g., separate a refactor from a feature, or a bugfix from a doc update).',
    "3. Propose the FIRST logical commit using 'propose_commit_plan'.",
    '4. The commit happens automatically on approval.',
    '5. After a commit is successful, analyze the REMAINING changes and repeat the process until all changes are committed.',
    '6. If the user rejects a plan, adjust it and propose again.',
    '',
    'Commit Quality Guidelines:',
    "- Use Conventional Commits (e.g., 'feat:', 'fix:', 'refactor:', 'docs:').",
    "- Be descriptive. Avoid 'update files' or 'fix bugs'.",
    '- Each commit should do one thing and do it completely.',
    '',
    'IMPORTANT: If the tool returns HARD_CANCEL, stop the entire commit process immediately and return to normal conversation.',
    'Do NOT push unless explicitly requested.',
    '',
    '--- Current Git Status ---',
    '',
    'The propose_commit_plan tool requires cwd. Always pass the canonical absolute working directory explicitly.',
];

/** Build the prompt for the LLM, injecting auto-approve instructions if needed. */
function buildYeetPrompt(isAutoApprove: boolean): string {
    if (!isAutoApprove) return YEET_PROMPT_BASE.join('\n');

    const workflowIdx = YEET_PROMPT_BASE.indexOf('Workflow:');
    const workflowLines = YEET_PROMPT_BASE.slice(workflowIdx);

    return [
        'Commit the current repository changes with AUTO-APPROVE mode.',
        '',
        "CRITICAL RULE: You MUST use the 'propose_commit_plan' tool with autoApprove=true.",
        '',
        ...workflowLines,
    ].join('\n');
}

/** Validate the explicit working directory before opening the commit UI. */
export function validateCommitCwd(cwd: string): string | null {
    if (typeof cwd !== 'string' || !cwd.trim()) return 'CWD is required';
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
            relativeFile.startsWith('..') ||
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
        await execFn('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
        await execFn('git', ['add', '--', ...files], { cwd });
        await execFn('git', ['commit', '-m', message], { cwd });
        const { stdout } = await execFn(
            'git',
            ['rev-parse', '--short', 'HEAD'],
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
    const proposeCommitPlanTool = defineTool({
        name: 'propose_commit_plan',
        label: 'Propose Commit Plan',
        description:
            'Propose a commit plan to the user. The user can review, edit the message, and toggle files in an interactive UI before approving.',
        promptSnippet:
            'Propose a commit plan for user review before staging or committing.',
        promptGuidelines: [
            'Analyze changes and group them into logical, atomic units (e.g., separate refactors from features).',
            'Propose the first logical commit using propose_commit_plan. Do NOT commit everything at once.',
            'If the tool returns ACCEPTED, the commit happens automatically.',
            'If the tool returns REJECTED, adjust the plan and propose again.',
            'After each successful commit, analyze remaining changes and propose the next commit until all are handled.',
            'If the tool returns HARD_CANCEL, stop the commit workflow immediately and return to normal conversation.',
            'Always provide cwd as the canonical absolute working directory for this commit.',
        ],
        parameters: Type.Object({
            cwd: Type.String({
                description:
                    'Required canonical absolute working directory. All files and git commands are validated against this path.',
            }),
            plan_summary: Type.String({
                description:
                    'Summary of the changes and why the commit is needed.',
            }),
            files: Type.Array(Type.String(), {
                description: 'File paths to include in the commit.',
            }),
            commit_message: Type.String({
                description: 'The proposed commit message.',
            }),
            autoApprove: Type.Optional(
                Type.Boolean({
                    description: 'Operational flag.',
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
                        'git',
                        ['rev-parse', '--is-inside-work-tree'],
                        { cwd: params.cwd },
                    );
                    if (result.stdout.trim() !== 'true') {
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
                            type: 'text',
                            text: `Commit plan rejected: ${error}`,
                        },
                    ],
                    details: {
                        accepted: false,
                        cancelled: false,
                        plan_summary: params.plan_summary,
                        cwd: params.cwd,
                        files: [],
                        commit_message: '',
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
                            anchor: 'center' as const,
                            width: '80%' as const,
                            maxWidth: 100,
                        },
                    },
                )) as CommitPlanResult;
            } else {
                // Full TUI editor
                result = (await ctx.ui.custom(
                    (
                        _tui: unknown,
                        theme: unknown,
                        _kb: unknown,
                        done: (r: CommitPlanResult) => void,
                    ) =>
                        new CommitPlanSession({
                            theme: theme as any,
                            params,
                            done,
                        }),
                    {
                        overlay: true,
                        overlayOptions: {
                            anchor: 'center' as const,
                            width: '80%' as const,
                            maxWidth: 100,
                        },
                    },
                )) as CommitPlanResult;
            }

            // Accept → commit programmatically with loading notification
            if (result.accepted) {
                ctx.ui.notify('Committing...', 'info');
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
                                type: 'text' as const,
                                text: [
                                    `Commit successful (${outcome.sha}).`,
                                    '',
                                    'Files: ' + result.files.join(', '),
                                    'Message: ' + result.commit_message,
                                ].join('\n'),
                            },
                        ],
                        details: result,
                    };
                }

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: [
                                'Commit FAILED. The approved plan could not be committed automatically.',
                                '',
                                'Error: ' + outcome.error,
                                '',
                                'You may need to investigate (e.g., run git status, check for conflicts) and propose a revised plan.',
                            ].join('\n'),
                        },
                    ],
                    details: result,
                };
            }

            // Reject (Ctrl+R) → repropose
            if (!result.cancelled) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: [
                                'User REJECTED the commit plan.',
                                '',
                                'You MUST call propose_commit_plan again with a different plan.',
                                'Do NOT stage or commit without approval.',
                            ].join('\n'),
                        },
                    ],
                    details: result,
                };
            }

            // Hard cancel (Esc) → stop everything
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: [
                            'HARD_CANCEL: The user cancelled the commit process.',
                            '',
                            'You MUST NOT call propose_commit_plan again.',
                            'Do NOT stage or commit anything.',
                            'Acknowledge the cancellation and return to normal conversation.',
                        ].join('\n'),
                    },
                ],
                details: result,
            };
        },
    });

    pi.registerTool(proposeCommitPlanTool);

    pi.registerCommand('yeet', {
        description:
            'Stage and commit repo changes. Use --go for auto-approve mode (skips TUI editor, shows confirm dialog).',
        handler: async (args: string, ctx: any) => {
            // Programmatically check git status so the LLM always has real data
            let gitStatus = '';
            let gitDiffStat = '';
            try {
                const statusResult = await pi.exec(
                    'git',
                    ['status', '--short'],
                    { cwd: ctx.cwd },
                );
                gitStatus = statusResult.stdout.trim();
            } catch {
                gitStatus = '(not a git repository or git status failed)';
            }

            try {
                const diffResult = await pi.exec('git', ['diff', '--stat'], {
                    cwd: ctx.cwd,
                });
                gitDiffStat = diffResult.stdout.trim();
            } catch {
                gitDiffStat = '(git diff failed)';
            }

            const hasChanges = gitStatus.length > 0;
            const trimmedArgs = args.trim();
            const isAutoApprove = trimmedArgs === '--go';
            const userArgs = isAutoApprove ? '' : trimmedArgs;

            const extraLines: string[] = [];
            if (!isAutoApprove && userArgs) {
                extraLines.push(
                    '',
                    'Additional instructions from the user:\n' + userArgs,
                );
            }

            const prompt = [
                buildYeetPrompt(isAutoApprove),
                '',
                gitStatus || '(no changes)',
                '',
                '--- Diff Summary ---',
                gitDiffStat || '(no diff)',
                '',
                hasChanges
                    ? 'There are pending changes. Analyze them and propose the first atomic commit.'
                    : 'The working tree is clean. There is nothing to commit.',
                ...extraLines,
            ].join('\n');

            if (ctx.isIdle()) {
                pi.sendUserMessage(prompt);
            } else {
                pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
                ctx.ui.notify('Queued /yeet as a follow-up', 'info');
            }
        },
    });
}
