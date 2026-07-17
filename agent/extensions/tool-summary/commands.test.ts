import { describe, expect, it, mock } from 'bun:test';
import { createUiColors } from '../_shared/ui-colors.ts';
import {
    ToolFilter,
    formatFilterState,
    handleToolSummaryCommand,
} from './commands.ts';

function makeTheme() {
    return {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
        dim: (text: string) => text,
        italic: (text: string) => text,
        underline: (text: string) => text,
        strikethrough: (text: string) => text,
        reset: (text: string) => text,
        ansi: (_code: number, text: string) => text,
        palette: {},
    } as any;
}

describe('ToolFilter', () => {
    it('starts with empty filter (show all)', () => {
        const f = new ToolFilter();
        expect(f.getFilter()).toBeNull();
    });

    it('getFilterArray returns empty array when filter is null', () => {
        const f = new ToolFilter();
        expect(f.getFilterArray()).toEqual([]);
    });

    it('add initializes filter and adds tools', () => {
        const f = new ToolFilter();
        f.add('read', 'grep');
        expect(f.getFilter()).toEqual(['read', 'grep']);
    });

    it('add does not duplicate', () => {
        const f = new ToolFilter();
        f.add('read');
        f.add('read');
        expect(f.getFilter()).toEqual(['read']);
    });

    it('remove removes tools', () => {
        const f = new ToolFilter();
        f.add('read', 'grep', 'bash');
        f.remove('grep');
        expect(f.getFilter()).toEqual(['read', 'bash']);
    });

    it('remove resets to null when list becomes empty', () => {
        const f = new ToolFilter();
        f.add('read');
        f.remove('read');
        expect(f.getFilter()).toBeNull();
    });

    it('reset clears filter', () => {
        const f = new ToolFilter();
        f.add('read', 'grep');
        f.reset();
        expect(f.getFilter()).toBeNull();
    });
});

describe('formatFilterState', () => {
    const colors = createUiColors(makeTheme());

    it('shows All tools when filter is null', () => {
        const f = new ToolFilter();
        expect(formatFilterState(f, colors)).toContain('All tools');
    });

    it('shows tool list when filter is set', () => {
        const f = new ToolFilter();
        f.add('read', 'grep');
        expect(formatFilterState(f, colors)).toContain('read, grep');
    });
});

describe('handleToolSummaryCommand', () => {
    const colors = createUiColors(makeTheme());

    function makeCtx() {
        return {
            hasUI: true,
            ui: {
                notify: mock(),
            },
        } as any;
    }

    it('list subcommand shows current filter (null = All tools)', async () => {
        const ctx = makeCtx();
        const filter = new ToolFilter();
        await handleToolSummaryCommand('list', ctx, filter, colors);
        expect(ctx.ui.notify).toHaveBeenCalledWith(
            expect.stringContaining('All tools'),
            'info',
        );
    });

    it('empty args shows filter too', async () => {
        const ctx = makeCtx();
        const filter = new ToolFilter();
        await handleToolSummaryCommand('', ctx, filter, colors);
        expect(ctx.ui.notify).toHaveBeenCalledWith(
            expect.stringContaining('All tools'),
            'info',
        );
    });

    it('add adds tools to filter', async () => {
        const ctx = makeCtx();
        const filter = new ToolFilter();
        await handleToolSummaryCommand('add read grep', ctx, filter, colors);
        expect(filter.getFilter()).toEqual(['read', 'grep']);
        expect(ctx.ui.notify).toHaveBeenCalledWith(
            expect.stringContaining('read, grep'),
            'info',
        );
    });

    it('add with no args shows error', async () => {
        const ctx = makeCtx();
        const filter = new ToolFilter();
        await handleToolSummaryCommand('add', ctx, filter, colors);
        expect(ctx.ui.notify).toHaveBeenCalledWith(
            expect.stringContaining('Usage'),
            'error',
        );
    });

    it('remove removes tools from filter', async () => {
        const ctx = makeCtx();
        const filter = new ToolFilter();
        filter.add('read', 'grep', 'bash');
        await handleToolSummaryCommand('remove grep', ctx, filter, colors);
        expect(filter.getFilter()).toEqual(['read', 'bash']);
    });

    it('remove with no args shows error', async () => {
        const ctx = makeCtx();
        const filter = new ToolFilter();
        await handleToolSummaryCommand('remove', ctx, filter, colors);
        expect(ctx.ui.notify).toHaveBeenCalledWith(
            expect.stringContaining('Usage'),
            'error',
        );
    });

    it('reset clears filter', async () => {
        const ctx = makeCtx();
        const filter = new ToolFilter();
        filter.add('read');
        await handleToolSummaryCommand('reset', ctx, filter, colors);
        expect(filter.getFilter()).toBeNull();
        expect(ctx.ui.notify).toHaveBeenCalledWith(
            expect.stringContaining('reset'),
            'info',
        );
    });

    it('unknown subcommand shows error', async () => {
        const ctx = makeCtx();
        const filter = new ToolFilter();
        await handleToolSummaryCommand('bogus', ctx, filter, colors);
        expect(ctx.ui.notify).toHaveBeenCalledWith(
            expect.stringContaining('Unknown'),
            'error',
        );
    });
});
