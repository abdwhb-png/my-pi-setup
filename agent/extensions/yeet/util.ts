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

    // Handle both test strings ("ArrowUp") and actual terminal escape sequences
    const isUp = key === "ArrowUp" || key === "\x1b[A" || key === "\x1bOA";
    const isDown = key === "ArrowDown" || key === "\x1b[B" || key === "\x1bOB";

    if (isUp) {
      return { ...state, fileCursorIndex: Math.max(0, fileCursorIndex - 1) };
    }

    if (isDown) {
      return {
        ...state,
        fileCursorIndex: Math.min(files.length - 1, fileCursorIndex + 1),
      };
    }
  }

  return state;
}

