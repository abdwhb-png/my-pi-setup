/**
 * §4 AXI — Programmatic aggregates for compressed tool results.
 *
 * Pure, deterministic parsers that produce a single-line metadata prefix
 * from the original tool output. The header gives the LLM enough context
 * to decide whether it needs to retrieve the full archived output, reducing
 * expensive follow-up calls.
 *
 * Max 3-4 fields per §2 (minimal schemas).
 */

/**
 * Build a one-line aggregate header from the original tool output.
 *
 * @returns A `[stats] ...` prefix line, or `null` if no aggregate applies
 *          (empty output, unrecognized format, unsupported tool).
 */
export function buildAggregateHeader(
    toolName: string,
    _input: object | undefined,
    text: string,
): string | null {
    if (toolName === 'grep') return grepAggregate(text);
    if (toolName === 'ls' || toolName === 'find')
        return entryCountAggregate(text);
    if (toolName === 'bash' || toolName === 'safe_bash')
        return lineCountAggregate(text);
    if (toolName === 'read') return readAggregate(text);
    return null;
}

/** Pattern for ripgrep content-mode lines: `file:line:content` */
const GREP_CONTENT_LINE_RE = /^(.+?):(\d+):/;

function grepAggregate(text: string): string | null {
    const lines = text.split('\n');
    const contentLines: string[] = [];
    const files = new Set<string>();

    for (const line of lines) {
        if (line.trim() === '') continue;
        const match = line.match(GREP_CONTENT_LINE_RE);
        if (match) {
            contentLines.push(line);
            files.add(match[1]);
        }
    }

    if (contentLines.length > 0) {
        return `[stats] matches: ${contentLines.length} | files: ${files.size}`;
    }

    // file_paths mode: each non-empty line is a file path
    const filePaths = lines.filter((l) => l.trim() !== '');
    if (filePaths.length === 0) return null;
    return `[stats] files: ${filePaths.length}`;
}

function entryCountAggregate(text: string): string | null {
    const entries = text.split('\n').filter((l) => l.trim() !== '');
    if (entries.length === 0) return null;
    return `[stats] entries: ${entries.length}`;
}

function lineCountAggregate(text: string): string | null {
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) return null;
    return `[stats] lines: ${lines.length}`;
}

function readAggregate(text: string): string {
    const lineCount = text === '' ? 1 : text.split('\n').length;
    return `[stats] chars: ${text.length} | lines: ${lineCount}`;
}
