import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LiveRunTokens } from './fleet-store.ts';

const DEFAULT_MAX_STATUS_BYTES = 1_048_576;
const DEFAULT_MAX_TRANSCRIPT_BYTES = 262_144;
const DEFAULT_MAX_TRANSCRIPT_LINES = 200;

export interface AsyncArtifactSnapshot {
    runId?: string;
    state?: string;
    currentTool?: string;
    activity?: string;
    model?: string;
    effort?: string;
    tokens: LiveRunTokens;
    transcript: string;
}

interface ArtifactReaderOptions {
    maxStatusBytes?: number;
    maxTranscriptBytes?: number;
    maxTranscriptLines?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function count(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
        : 0;
}

function parseTokens(status: Record<string, unknown>): LiveRunTokens {
    const value = isRecord(status.totalTokens)
        ? status.totalTokens
        : isRecord(status.tokens)
          ? status.tokens
          : isRecord(status.usage)
            ? status.usage
            : {};
    const input = count(value.input ?? value.inputTokens);
    const output = count(value.output ?? value.outputTokens);
    return {
        input,
        output,
        total: Math.max(input + output, count(value.total ?? value.totalTokens)),
    };
}

function isInside(root: string, candidate: string): boolean {
    return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function safeFile(root: string, candidate: string): string | undefined {
    const resolved = path.resolve(candidate);
    if (!isInside(root, resolved)) return undefined;
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    const real = fs.realpathSync(resolved);
    return isInside(root, real) ? real : undefined;
}

function sanitizeTerminalText(value: string): string {
    return value.replace(
        /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b][\s\S]*?(?:\x07|\x1b\\)|\x1b[PX^_][\s\S]*?\x1b\\|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,
        '',
    );
}

function readTail(filePath: string, maxBytes: number, maxLines: number): string {
    const stat = fs.statSync(filePath);
    if (stat.size === 0 || maxBytes <= 0 || maxLines <= 0) return '';
    const length = Math.min(stat.size, Math.max(1, Math.floor(maxBytes)));
    const start = Math.max(0, stat.size - length);
    const buffer = Buffer.alloc(length);
    const descriptor = fs.openSync(filePath, 'r');
    try {
        fs.readSync(descriptor, buffer, 0, length, start);
    } finally {
        fs.closeSync(descriptor);
    }
    let text = buffer.toString('utf8');
    if (start > 0) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    return sanitizeTerminalText(lines.slice(-maxLines).join('\n'));
}

export function readAsyncArtifacts(
    asyncDir: string,
    options: ArtifactReaderOptions = {},
): AsyncArtifactSnapshot | undefined {
    try {
        const directoryStat = fs.lstatSync(asyncDir);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
            return undefined;
        }
        const root = fs.realpathSync(asyncDir);
        const statusPath = safeFile(root, path.join(root, 'status.json'));
        if (!statusPath) return undefined;
        const maxStatusBytes =
            options.maxStatusBytes ?? DEFAULT_MAX_STATUS_BYTES;
        if (fs.statSync(statusPath).size > maxStatusBytes) return undefined;
        const parsed: unknown = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        if (!isRecord(parsed)) return undefined;

        const configuredOutput = optionalText(parsed.outputFile);
        const outputCandidate = configuredOutput
            ? path.isAbsolute(configuredOutput)
                ? configuredOutput
                : path.join(root, configuredOutput)
            : path.join(root, 'output-0.log');
        const outputPath = fs.existsSync(outputCandidate)
            ? safeFile(root, outputCandidate)
            : undefined;
        const transcript = outputPath
            ? readTail(
                  outputPath,
                  options.maxTranscriptBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES,
                  options.maxTranscriptLines ?? DEFAULT_MAX_TRANSCRIPT_LINES,
              )
            : '';

        return {
            ...(optionalText(parsed.runId) ? { runId: optionalText(parsed.runId) } : {}),
            ...(optionalText(parsed.state) ? { state: optionalText(parsed.state) } : {}),
            ...(optionalText(parsed.currentTool)
                ? { currentTool: optionalText(parsed.currentTool) }
                : {}),
            ...(optionalText(parsed.activity ?? parsed.lastActivity)
                ? { activity: optionalText(parsed.activity ?? parsed.lastActivity) }
                : {}),
            ...(optionalText(parsed.model) ? { model: optionalText(parsed.model) } : {}),
            ...(optionalText(parsed.effort ?? parsed.thinking)
                ? { effort: optionalText(parsed.effort ?? parsed.thinking) }
                : {}),
            tokens: parseTokens(parsed),
            transcript,
        };
    } catch {
        return undefined;
    }
}
