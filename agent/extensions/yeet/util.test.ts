import { describe, it, expect } from "vitest";
import { handleCommitPlanInput } from "./util";
import type { CommitPlanSessionState } from "./types";

function makeState(overrides?: Partial<CommitPlanSessionState>): CommitPlanSessionState {
  return {
    commitMessage: "",
    cursorPosition: 0,
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

  it("should not toggle file selection with Space when focus is message", () => {
    const s0 = makeState({ focus: "message" });
    const s1 = handleCommitPlanInput(s0, " ");
    expect(s1.files[0].selected).toBe(false);
    // Space should be inserted into message instead
    expect(s1.commitMessage).toBe(" ");
  });

  // --- Message editing ---

  it("should insert characters at cursor position", () => {
    let s = makeState();
    s = handleCommitPlanInput(s, "h");
    expect(s.commitMessage).toBe("h");
    expect(s.cursorPosition).toBe(1);
    s = handleCommitPlanInput(s, "i");
    expect(s.commitMessage).toBe("hi");
    expect(s.cursorPosition).toBe(2);
  });

  it("should insert space into commit message", () => {
    let s = makeState({ commitMessage: "hello", cursorPosition: 5 });
    s = handleCommitPlanInput(s, " ");
    expect(s.commitMessage).toBe("hello ");
    expect(s.cursorPosition).toBe(6);
  });

  it("should insert special characters into commit message", () => {
    let s = makeState({ commitMessage: "fix", cursorPosition: 3 });
    s = handleCommitPlanInput(s, ":");
    expect(s.commitMessage).toBe("fix:");
    s = handleCommitPlanInput(s, " ");
    expect(s.commitMessage).toBe("fix: ");
    s = handleCommitPlanInput(s, "(");
    expect(s.commitMessage).toBe("fix: (");
  });

  it("should delete char before cursor with Backspace", () => {
    const s0 = makeState({ commitMessage: "hello", cursorPosition: 5 });
    const s1 = handleCommitPlanInput(s0, "Backspace");
    expect(s1.commitMessage).toBe("hell");
    expect(s1.cursorPosition).toBe(4);
  });

  it("should not delete with Backspace at position 0", () => {
    const s0 = makeState({ commitMessage: "hello", cursorPosition: 0 });
    const s1 = handleCommitPlanInput(s0, "Backspace");
    expect(s1).toBe(s0); // same reference = no change
  });

  it("should delete char after cursor with Delete", () => {
    const s0 = makeState({ commitMessage: "hello", cursorPosition: 0 });
    const s1 = handleCommitPlanInput(s0, "Delete");
    expect(s1.commitMessage).toBe("ello");
    expect(s1.cursorPosition).toBe(0);
  });

  it("should not delete at end of message", () => {
    const s0 = makeState({ commitMessage: "hello", cursorPosition: 5 });
    const s1 = handleCommitPlanInput(s0, "Delete");
    expect(s1).toBe(s0);
  });

  // --- Cursor movement ---

  it("should move cursor left/right within message", () => {
    const s0 = makeState({ commitMessage: "hello", cursorPosition: 5 });
    const s1 = handleCommitPlanInput(s0, "ArrowLeft");
    expect(s1.cursorPosition).toBe(4);
    const s2 = handleCommitPlanInput(s1, "ArrowLeft");
    expect(s2.cursorPosition).toBe(3);
    // Boundary
    const s3 = handleCommitPlanInput(s0, "ArrowRight");
    expect(s3.cursorPosition).toBe(5); // at end, no change
  });

  it("should insert in the middle of the message", () => {
    // "helo" with cursor at 3 → insert "l" → "hello"
    const s0 = makeState({ commitMessage: "helo", cursorPosition: 3 });
    const s1 = handleCommitPlanInput(s0, "l");
    expect(s1.commitMessage).toBe("hello");
    expect(s1.cursorPosition).toBe(4);
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

