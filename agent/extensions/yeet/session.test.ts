import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommitPlanSession } from './session';
import type { CommitPlanParams, CommitPlanResult } from './types';

function createMockTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    inverse: (text: string) => text,
    underline: (text: string) => text,
  };
}

const defaultParams: CommitPlanParams = {
  plan_summary: 'Test plan',
  files: ['src/index.ts', 'src/utils.ts'],
  commit_message: 'feat: add new feature',
};

describe('CommitPlanSession', () => {
  let done: ReturnType<typeof vi.fn>;
  let session: CommitPlanSession;

  beforeEach(() => {
    done = vi.fn();
    session = new CommitPlanSession({
      theme: createMockTheme() as never,
      params: defaultParams,
      done,
    });
  });

  describe('render()', () => {
    it('returns a non-empty array of strings', () => {
      const output = session.render(80);
      expect(Array.isArray(output)).toBe(true);
      expect(output.length).toBeGreaterThan(0);
      output.forEach((line) => {
        expect(typeof line).toBe('string');
      });
    });

    it('includes the plan title', () => {
      const output = session.render(80);
      expect(output.some((line) => line.includes('Commit Plan Review'))).toBe(true);
    });

    it('includes the commit message', () => {
      const output = session.render(80);      // The Input component renders the value, so we check if it's present in the output      expect(output.some((line) => line.includes('feat: add new feature'))).toBe(true);
    });

    it('includes file paths', () => {
      const output = session.render(80);
      expect(output.some((line) => line.includes('src/index.ts'))).toBe(true);
      expect(output.some((line) => line.includes('src/utils.ts'))).toBe(true);
    });

    it('includes the help hint bar', () => {
      const output = session.render(80);
      expect(output.some((line) => line.includes('[Enter] Accept'))).toBe(true);
      expect(output.some((line) => line.includes('[Esc] Cancel'))).toBe(true);
      expect(output.some((line) => line.includes('[Tab] Switch'))).toBe(true);
    });
  });

  describe('invalidate()', () => {
    it('does not throw', () => {
      expect(() => session.invalidate()).not.toThrow();
    });
  });

  describe('handleInput()', () => {
    it('does not throw for common navigation keys', () => {
      expect(() => session.handleInput('\t')).not.toThrow();
      expect(() => session.handleInput(' ')).not.toThrow();
      expect(() => session.handleInput('ArrowUp')).not.toThrow();
      expect(() => session.handleInput('ArrowDown')).not.toThrow();
      expect(() => session.handleInput('a')).not.toThrow();
      expect(() => session.handleInput('Backspace')).not.toThrow();
    });

    it('calls done with accepted=true, cancelled=false on Enter', () => {
      session.handleInput('\r');
      expect(done).toHaveBeenCalledTimes(1);
      const result: CommitPlanResult = done.mock.calls[0][0];
      expect(result.accepted).toBe(true);
      expect(result.cancelled).toBe(false);
      expect(result.files).toEqual(['src/index.ts', 'src/utils.ts']);
      expect(result.commit_message).toBe('feat: add new feature');
      expect(result.plan_summary).toBe('Test plan');
    });

    it('calls done with accepted=false, cancelled=true on Escape', () => {
      session.handleInput('\x1b');
      expect(done).toHaveBeenCalledTimes(1);
      const result: CommitPlanResult = done.mock.calls[0][0];
      expect(result.accepted).toBe(false);
      expect(result.cancelled).toBe(true);
      expect(result.files).toEqual([]);
      expect(result.commit_message).toBe('');
    });

    it('calls done with accepted=false, cancelled=false on Ctrl+R (reject)', () => {
      session.handleInput('\x12');
      expect(done).toHaveBeenCalledTimes(1);
      const result: CommitPlanResult = done.mock.calls[0][0];
      expect(result.accepted).toBe(false);
      expect(result.cancelled).toBe(false);
    });

    it('processes text input and returns accepted result with updated message on Enter', () => {
      session.handleInput('!');
      session.handleInput('\r');
      const result: CommitPlanResult = done.mock.calls[0][0];
      expect(result.commit_message).toBe('feat: add new feature!');
    });
  });
});