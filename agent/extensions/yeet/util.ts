import type { CommitPlanSessionState } from "./types";

export function handleCommitPlanInput(
  state: CommitPlanSessionState,
  key: string,
): CommitPlanSessionState {
  const { focus, fileCursorIndex, commitMessage, cursorPosition, files } = state;

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

  // --- Message editing ---

  if (focus === "message") {
    if (key === "ArrowLeft") {
      return {
        ...state,
        cursorPosition: Math.max(0, cursorPosition - 1),
      };
    }

    if (key === "ArrowRight") {
      return {
        ...state,
        cursorPosition: Math.min(commitMessage.length, cursorPosition + 1),
      };
    }

    if (key === "Backspace") {
      if (cursorPosition === 0) return state;
      return {
        ...state,
        commitMessage:
          commitMessage.slice(0, cursorPosition - 1) +
          commitMessage.slice(cursorPosition),
        cursorPosition: cursorPosition - 1,
      };
    }

    if (key === "Delete") {
      if (cursorPosition >= commitMessage.length) return state;
      return {
        ...state,
        commitMessage:
          commitMessage.slice(0, cursorPosition) +
          commitMessage.slice(cursorPosition + 1),
      };
    }

    // Accept any printable character (not control sequences)
    if (key.length === 1 && key.charCodeAt(0) >= 0x20) {
      return {
        ...state,
        commitMessage:
          commitMessage.slice(0, cursorPosition) +
          key +
          commitMessage.slice(cursorPosition),
        cursorPosition: cursorPosition + 1,
      };
    }
  }

  return state;
}

