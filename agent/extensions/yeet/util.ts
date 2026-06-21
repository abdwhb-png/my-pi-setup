import type { CommitPlanSessionState } from "./types";
import { matchesKey } from "@earendil-works/pi-tui";

export function handleCommitPlanInput(
  state: CommitPlanSessionState,
  key: string,
): CommitPlanSessionState {
  const { focus, fileCursorIndex, files } = state;

  // --- Global keys ---
  if (matchesKey(key, "tab")) {
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
    const isUp = key === "ArrowUp" || matchesKey(key, "up");
    const isDown = key === "ArrowDown" || matchesKey(key, "down");

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

