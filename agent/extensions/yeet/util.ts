import { CommitPlanSessionState } from './types';

export function handleCommitPlanInput(
  state: CommitPlanSessionState,
  key: string
): CommitPlanSessionState {
  const { focus, cursorIndex, commitMessage, files } = state;

  if (key === '\t') {
    return {
      ...state,
      focus: focus === 'message' ? 'files' : 'message',
    };
  }

  if (focus === 'files') {
    if (key === ' ') {
      const newFiles = [...files];
      if (cursorIndex >= 0 && cursorIndex < newFiles.length) {
        newFiles[cursorIndex] = { ...newFiles[cursorIndex], selected: !newFiles[cursorIndex].selected };
      }
      return { ...state, files: newFiles };
    }

    if (key === 'ArrowUp') {
      return {
        ...state,
        cursorIndex: Math.max(0, cursorIndex - 1),
      };
    }

    if (key === 'ArrowDown') {
      return {
        ...state,
        cursorIndex: Math.min(files.length - 1, cursorIndex + 1),
      };
    }
  }

  if (focus === 'message') {
    if (key === 'Backspace') {
      return {
        ...state,
        commitMessage: commitMessage.slice(0, -1),
      };
    }

    if (/^[a-zA-Z0-9\s.,!?-]$/.test(key)) {
      return {
        ...state,
        commitMessage: commitMessage + key,
      };
    }
  }

  return state;
}

