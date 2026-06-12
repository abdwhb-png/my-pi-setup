import type { CommitPlanSessionState } from "./types";

export function handleCommitPlanInput(
  state: CommitPlanSessionState,
  key: string,
): CommitPlanSessionState {
  const { focus, fileCursorIndex, files } = state;

  // --- Global keys ---
  if (key === "\t") {
    return {
      ...state,
      focus: focus === "message" ? "files" : "message",
    };
  }

  // --- File list navigation ---
  if (focus === "files") {
    if (key === " ") {
      const newFiles = [...files];
      if (fileCursorIndex >= 0 && fileCursorIndex < newFiles.length) {
        newFiles[fileCursorIndex] = {
          ...newFiles[fileCursorIndex],
          selected: !newFiles[fileCursorIndex].selected,
        };
      }
      return { ...state, files: newFiles };
    }

    if (key === "ArrowUp") {
      return { ...state, fileCursorIndex: Math.max(0, fileCursorIndex - 1) };
    }

    if (key === "ArrowDown") {
      return {
        ...state,
        fileCursorIndex: Math.min(files.length - 1, fileCursorIndex + 1),
      };
    }
  }

  return state;
}

