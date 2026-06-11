export interface CommitPlanParams {
  plan_summary: string;
  files: string[];
  commit_message: string;
}

export interface CommitPlanResult {
  accepted: boolean;
  plan_summary: string;
  files: string[];
  commit_message: string;
}

export interface CommitPlanSessionState {
  commitMessage: string;
  files: { path: string; selected: boolean }[];
  focus: 'message' | 'files';
  cursorIndex: number;
}
