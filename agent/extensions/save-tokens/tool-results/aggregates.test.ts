import { describe, expect, it } from 'bun:test';
import { buildAggregateHeader } from './aggregates';

describe('buildAggregateHeader', () => {
  describe('grep', () => {
    it('counts matches and distinct files from content-mode output', () => {
      const text = [
        'src/a.ts:10: const foo = 1;',
        'src/a.ts:25: const foo = 2;',
        'src/b.ts:5: const foo = 3;',
      ].join('\n');
      const result = buildAggregateHeader('grep', { pattern: 'foo' }, text);
      expect(result).toBe('[stats] matches: 3 | files: 2');
    });

    it('counts files from file_paths-mode output', () => {
      const text = 'src/a.ts\nsrc/b.ts\nsrc/c.ts';
      const result = buildAggregateHeader('grep', { pattern: 'foo', output_mode: 'file_paths' }, text);
      expect(result).toBe('[stats] files: 3');
    });

    it('returns null for empty grep output', () => {
      expect(buildAggregateHeader('grep', { pattern: 'foo' }, '')).toBeNull();
    });

    it('returns null for whitespace-only grep output', () => {
      expect(buildAggregateHeader('grep', { pattern: 'foo' }, '   \n  ')).toBeNull();
    });
  });

  describe('ls / find', () => {
    it('counts entries for ls', () => {
      const text = 'file1.ts\nfile2.ts\ndir1\nfile3.ts';
      const result = buildAggregateHeader('ls', { path: '.' }, text);
      expect(result).toBe('[stats] entries: 4');
    });

    it('counts entries for find', () => {
      const text = 'src/a.ts\nsrc/b.ts\nsrc/c.ts';
      const result = buildAggregateHeader('find', { path: 'src' }, text);
      expect(result).toBe('[stats] entries: 3');
    });

    it('returns null for empty ls output', () => {
      expect(buildAggregateHeader('ls', { path: '.' }, '')).toBeNull();
    });
  });

  describe('bash / safe_bash', () => {
    it('counts non-empty lines for bash', () => {
      const text = 'line1\nline2\nline3\n';
      const result = buildAggregateHeader('bash', { command: 'cat file' }, text);
      expect(result).toBe('[stats] lines: 3');
    });

    it('counts non-empty lines for safe_bash', () => {
      const text = 'output1\noutput2';
      const result = buildAggregateHeader('safe_bash', { command: 'ls' }, text);
      expect(result).toBe('[stats] lines: 2');
    });

    it('returns null for empty bash output', () => {
      expect(buildAggregateHeader('bash', { command: 'echo' }, '')).toBeNull();
    });
  });

  describe('read', () => {
    it('counts chars and lines for read', () => {
      const text = 'line1\nline2\nline3';
      const result = buildAggregateHeader('read', { path: 'file.ts' }, text);
      expect(result).toBe('[stats] chars: 17 | lines: 3');
    });

    it('handles single-line read output', () => {
      const text = 'hello world';
      const result = buildAggregateHeader('read', { path: 'file.ts' }, text);
      expect(result).toBe('[stats] chars: 11 | lines: 1');
    });

    it('handles empty read output', () => {
      const result = buildAggregateHeader('read', { path: 'file.ts' }, '');
      expect(result).toBe('[stats] chars: 0 | lines: 1');
    });
  });

  describe('unknown tools', () => {
    it('returns null for unsupported tool names', () => {
      expect(buildAggregateHeader('write', {}, 'some text')).toBeNull();
      expect(buildAggregateHeader('edit', {}, 'some text')).toBeNull();
      expect(buildAggregateHeader('custom', {}, 'some text')).toBeNull();
    });
  });

  describe('import verification', () => {
    it('exports buildAggregateHeader as a function', async () => {
      const mod = await import('./aggregates');
      expect(typeof mod.buildAggregateHeader).toBe('function');
    });
  });
});
