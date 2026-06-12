import { describe, it, expect } from "vitest";
import { handleCommitPlanInput } from "./util";
import type { CommitPlanSessionState } from "./types";

function makeState(overrides?: Partial<CommitPlanSessionState>): CommitPlanSessionState {
  return {
    files: [
      { path: "file1.ts", selected: false },
      { path: "file2.ts", selected: false },
      { path: "file3.ts", selected: false },
    ],
    focus: "message",
    fileCursorIndex: 0,
    ...overrides,
  };
}

describe("handleCommitPlanInput", () => {
  // --- Focus toggling ---

  it("should toggle focus with Tab", () => {
    const state = handleCommitPlanInput(makeState(), "\t");
    expect(state.focus).toBe("files");
    const state2 = handleCommitPlanInput(state, "\t");
    expect(state2.focus).toBe("message");
  });

  // --- File list navigation ---

  it("should move file cursor with ArrowUp/ArrowDown", () => {
    const s0 = makeState({ focus: "files" });
    const s1 = handleCommitPlanInput(s0, "ArrowDown");
    expect(s1.fileCursorIndex).toBe(1);
    const s2 = handleCommitPlanInput(s1, "ArrowDown");
    expect(s2.fileCursorIndex).toBe(2);
    // Boundary
    const s3 = handleCommitPlanInput(s2, "ArrowDown");
    expect(s3.fileCursorIndex).toBe(2);

    const s4 = handleCommitPlanInput(s2, "ArrowUp");
    expect(s4.fileCursorIndex).toBe(1);
    const s5 = handleCommitPlanInput(s4, "ArrowUp");
    expect(s5.fileCursorIndex).toBe(0);
    // Boundary
    const s6 = handleCommitPlanInput(s5, "ArrowUp");
    expect(s6.fileCursorIndex).toBe(0);
  });

  it("should toggle file selection with Space when focus is files", () => {
    const s0 = makeState({ focus: "files" });
    const s1 = handleCommitPlanInput(s0, " ");
    expect(s1.files[0].selected).toBe(true);
    const s2 = handleCommitPlanInput(s1, " ");
    expect(s2.files[0].selected).toBe(false);
  });

  it("should ignore message editing keys when focus is message (handled by Input component)", () => {
    const s0 = makeState({ focus: "message" });
    const s1 = handleCommitPlanInput(s0, " ");
    expect(s1.files[0].selected).toBe(false);
    // State should remain unchanged as Input component handles text
    expect(s1.focus).toBe("message");
  });

  // --- Focus isolation ---

  it("should not update commit message when typing and focus is files", () => {
    const s0 = makeState({ focus: "files", commitMessage: "" });
    const s1 = handleCommitPlanInput(s0, "a");
    expect(s1.commitMessage).toBe("");
  });

  it("should not move cursor when ArrowLeft/Right and focus is files", () => {
    const s0 = makeState({ focus: "files", commitMessage: "hello", cursorPosition: 3 });
    const s1 = handleCommitPlanInput(s0, "ArrowLeft");
    expect(s1.cursorPosition).toBe(3);
  });
});

