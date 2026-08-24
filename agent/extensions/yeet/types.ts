export interface CommitPlanParams {
    plan_summary: string;
    /** Canonical absolute working directory used for validation and git commands. */
    cwd: string;
    files: string[];
    commit_message: string;
    /** When true, the plan is auto-approved (no TUI). A confirmation dialog still appears before committing. */
    autoApprove?: boolean;
}

export interface CommitPlanResult {
    accepted: boolean;
    /** true = user pressed Esc (stop everything), false = user pressed Enter or Ctrl+R */
    cancelled: boolean;
    /** Optional explanation supplied when the user rejects the plan. */
    rejection_reason?: string;
    plan_summary: string;
    /** The explicit working directory used for this commit. */
    cwd: string;
    files: string[];
    commit_message: string;
    /** Set after an accepted plan commits successfully. */
    sha?: string;
    branch?: string;
    durationMs?: number;
    /** Populated when the automatic commit of an accepted plan failed. */
    commitError?: string;
    commitStderr?: string;
}

export interface CommitPlanSessionState {
    files: { path: string; selected: boolean }[];
    focus: "message" | "files";
    /** File list cursor (index into files array) */
    fileCursorIndex: number;
    /** Current commit message text being edited */
    commitMessage?: string;
    /** Cursor position within the commit message */
    cursorPosition?: number;
}
