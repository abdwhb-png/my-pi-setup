import { describe, it, expect } from 'vitest';
import { handleCommitPlanInput } from './util';
import { CommitPlanSessionState } from './types';

describe('handleCommitPlanInput', () => {
  const initialState: CommitPlanSessionState = {
    commitMessage: '',
    files: [
      { path: 'file1.ts', selected: false },
      { path: 'file2.ts', selected: false },
      { path: 'file3.ts', selected: false },
    ],
    focus: 'message',
    cursorIndex: 0,
  };

  it('should toggle focus with Tab', () => {
    const state = handleCommitPlanInput(initialState, '\t');
    expect(state.focus).toBe('files');
    const state2 = handleCommitPlanInput(state, '\t');
    expect(state2.focus).toBe('message');
  });

  it('should toggle file selection with Space when focus is files', () => {
    const stateWithFocus = { ...initialState, focus: 'files' };
    const state = handleCommitPlanInput(stateWithFocus, ' ');
    expect(state.files[0].selected).toBe(true);
    const state2 = handleCommitPlanInput(state, ' ');
    expect(state2.files[0].selected).toBe(false);
  });

  it('should not toggle file selection with Space when focus is message', () => {
    const state = handleCommitPlanInput(initialState, ' ');
    expect(state.files[0].selected).toBe(false);
  });

  it('should update commit message when typing and focus is message', () => {
    const state = handleCommitPlanInput(initialState, 'a');
    expect(state.commitMessage).toBe('a');
    const state2 = handleCommitPlanInput(state, 'b');
    expect(state2.commitMessage).toBe('ab');
    const state3 = handleCommitPlanInput(state2, ' ');
    expect(state3.commitMessage).toBe('ab ');
  });

  it('should not update commit message when typing and focus is files', () => {
    const stateWithFocus = { ...initialState, focus: 'files' };
    const state = handleCommitPlanInput(stateWithFocus, 'a');
    expect(state.commitMessage).toBe('');
  });

  it('should remove last char from commit message with Backspace when focus is message', () => {
    const stateWithMsg = { ...initialState, commitMessage: 'hello' };
    const state = handleCommitPlanInput(stateWithMsg, 'Backspace');
    expect(state.commitMessage).toBe('hell');
  });

  it('should move cursor up and down when focus is files', () => {
    const stateWithFocus = { ...initialState, focus: 'files' };
    const stateDown = handleCommitPlanInput(stateWithFocus, 'ArrowDown');
    expect(stateDown.cursorIndex).toBe(1);
    const stateDown2 = handleCommitPlanInput(stateDown, 'ArrowDown');
    expect(stateDown2.cursorIndex).toBe(2);
    const stateDown3 = handleCommitPlanInput(stateDown2, 'ArrowDown');
    expect(stateDown3.cursorIndex).toBe(2); // Boundary

    const stateUp = handleCommitPlanInput(stateDown2, 'ArrowUp');
    expect(stateUp.cursorIndex).toBe(1);
    const stateUp2 = handleCommitPlanInput(stateUp, 'ArrowUp');
    expect(stateUp2.cursorIndex).toBe(0);
    const stateUp3 = handleCommitPlanInput(stateUp2, 'ArrowUp');
    expect(stateUp3.cursorIndex).toBe(0); // Boundary
  });
});

