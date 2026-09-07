import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolResultEvent } from '@earendil-works/pi-coding-agent';
import { recordExecution, hostExecution } from '../../_shared/execution-provenance/index.ts';
import { archiveOriginalToolResult } from './archive.ts';
import { createToolResultHandler } from './core.ts';

let root: string | undefined;
const previous = process.env.PI_TOOL_RESULT_ARCHIVE_DIR;
afterEach(async () => {
    if (previous === undefined) delete process.env.PI_TOOL_RESULT_ARCHIVE_DIR;
    else process.env.PI_TOOL_RESULT_ARCHIVE_DIR = previous;
    if (root) await rm(root, { recursive: true, force: true });
});

test('compression preserves process facts before the provenance hook and bypasses archive pages', async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-archive-provenance-'));
    process.env.PI_TOOL_RESULT_ARCHIVE_DIR = root;
    let calls = 0;
    const handler = createToolResultHandler({ backend: { id: 'headroom', compress: async () => { calls++; return { output: 'summary' }; } }, aggregates: false, archiveOriginal: archiveOriginalToolResult });
    const execution = { ...hostExecution('process'), backend: 'local' as const, exitCode: 0 };
    recordExecution('archive-process', execution);
    const text = 'raw source\n'.repeat(200);
    const event: ToolResultEvent = { type: 'tool_result', toolCallId: 'archive-process', toolName: 'bash', input: { command: 'printf data' }, content: [{ type: 'text', text }], details: { marker: 'preserved' }, isError: false };
    const model = { provider: 'test', id: 'test', contextWindow: 100000 };
    const result = await handler(event, model);
    expect(result?.details).toMatchObject({ marker: 'preserved', execution, compression: { sourceExecution: execution } });
    const path = result!.details.compression.archivePath!;
    expect(await readFile(path, 'utf8')).toBe(text);
    expect(JSON.parse(await readFile(`${path}.meta.json`, 'utf8')).sourceExecution).toEqual(execution);
    const page = await handler({ ...event, toolName: 'read', toolCallId: 'archive-read', input: { path, offset: 2, limit: 20 }, content: [{ type: 'text', text }] }, model);
    expect(page).toBeUndefined();
    expect(calls).toBe(1);
});
