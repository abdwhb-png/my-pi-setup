import { describe, expect, it } from 'bun:test';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { createUiColors } from '../_shared/ui/ui-colors.ts';
import { countToolUsage, formatSummary } from './summary.ts';

function makeTheme(): Theme {
    return {
        fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
        dim: (text: string) => text,
        italic: (text: string) => text,
        underline: (text: string) => text,
        strikethrough: (text: string) => text,
        reset: (text: string) => text,
        ansi: (_code: number, text: string) => text,
        palette: {},
    } as unknown as Theme;
}

function makeResult(
    toolName: string,
    isError = false,
    toolCallId = 'id-' + Math.random().toString(36).slice(2),
): ToolResultMessage {
    return {
        role: 'toolResult',
        toolCallId,
        toolName,
        content: [{ type: 'text', text: 'output' }],
        isError,
        timestamp: Date.now(),
    };
}

describe('countToolUsage', () => {
    it('returns empty counts for empty input', () => {
        const counts = countToolUsage([]);
        expect(counts.total).toEqual({});
        expect(counts.errors).toEqual({});
    });

    it('counts single tool', () => {
        const results = [makeResult('read')];
        const counts = countToolUsage(results);
        expect(counts.total).toEqual({ read: 1 });
        expect(counts.errors).toEqual({});
    });

    it('counts multiple calls of same tool', () => {
        const results = [
            makeResult('read'),
            makeResult('read'),
            makeResult('read'),
        ];
        const counts = countToolUsage(results);
        expect(counts.total).toEqual({ read: 3 });
        expect(counts.errors).toEqual({});
    });

    it('tracks errors separately', () => {
        const results = [
            makeResult('bash', false),
            makeResult('bash', true),
            makeResult('bash', false),
            makeResult('grep', false),
        ];
        const counts = countToolUsage(results);
        expect(counts.total).toEqual({ bash: 3, grep: 1 });
        expect(counts.errors).toEqual({ bash: 1 });
    });

    it('handles mixed tools with no errors', () => {
        const results = [
            makeResult('read'),
            makeResult('grep'),
            makeResult('bash'),
            makeResult('read'),
            makeResult('ls'),
        ];
        const counts = countToolUsage(results);
        expect(counts.total).toEqual({ read: 2, grep: 1, bash: 1, ls: 1 });
        expect(counts.errors).toEqual({});
    });

    it('handles all errors', () => {
        const results = [makeResult('bash', true), makeResult('bash', true)];
        const counts = countToolUsage(results);
        expect(counts.total).toEqual({ bash: 2 });
        expect(counts.errors).toEqual({ bash: 2 });
    });
});

describe('formatSummary', () => {
    const theme = makeTheme();
    const colors = createUiColors(theme);

    it('returns empty string for empty counts', () => {
        expect(formatSummary({ total: {}, errors: {} }, [], colors)).toBe('');
    });

    it('formats tool counts with muted color', () => {
        const counts = { total: { read: 3 }, errors: {} };
        const result = formatSummary(counts, [], colors);
        expect(result).toBe('read<muted>(3)</muted>');
    });

    it('formats multiple tools', () => {
        const counts = {
            total: { read: 3, grep: 1, bash: 2 },
            errors: {},
        };
        const result = formatSummary(counts, [], colors);
        expect(result).toContain('read');
        expect(result).toContain('grep');
        expect(result).toContain('bash');
        expect(result).toContain('3');
        expect(result).toContain('1');
        expect(result).toContain('2');
    });

    it('applies color for errors', () => {
        const counts = {
            total: { bash: 2 },
            errors: { bash: 2 },
        };
        const result = formatSummary(counts, [], colors);
        // With mock theme, danger() returns the text itself
        // but the formatting structure should still be there
        expect(result).toContain('bash');
        expect(result).toContain('2');
    });

    it('filters out tools not in allowlist', () => {
        const counts = {
            total: { read: 3, grep: 1, bash: 2 },
            errors: {},
        };
        const result = formatSummary(counts, ['read', 'bash'], colors);
        expect(result).toContain('read');
        expect(result).toContain('bash');
        expect(result).not.toContain('grep');
    });

    it('empty allowlist shows all tools', () => {
        const counts = {
            total: { read: 3, grep: 1 },
            errors: {},
        };
        const result = formatSummary(counts, [], colors);
        expect(result).toContain('read');
        expect(result).toContain('grep');
    });

    it('only shows tools that were actually used', () => {
        const counts = {
            total: { read: 3 },
            errors: {},
        };
        // grep is in allowlist but was not used — should not appear
        const result = formatSummary(counts, ['read', 'grep'], colors);
        expect(result).toContain('read');
        expect(result).not.toContain('grep');
    });
});
