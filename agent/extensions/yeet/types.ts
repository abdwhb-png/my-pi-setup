export interface CommitPlanParams {
  plan_summary: string;
  files: string[];
  commit_message: string;
}

export interface CommitPlanResult {
  accepted: boolean;
  /** true = user pressed Esc (stop everything), false = user pressed Enter or Ctrl+R */
  cancelled: boolean;
  plan_summary: string;
  files: string[];
  commit_message: string;
}

export interface CommitPlanSessionState {
  commitMessage: string;
  /** Cursor position within commitMessage (0 = before first char, length = after last) */
  cursorPosition: number;
  files: { path: string; selected: boolean }[];
  focus: 'message' | 'files';
  /** File list cursor (index into files array) */
  fileCursorIndex: number;
}
