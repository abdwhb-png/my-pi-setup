import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    ChildProcessVerificationRunner,
    DEFAULT_VERIFY_TIMEOUT_MS,
    MAX_VERIFY_OUTPUT_CHARS,
} from './verification.ts';

function nodeCommand(source: string): string {
    return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

function run(command: string, cwd: string, timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS) {
    return new ChildProcessVerificationRunner().run({
        command: { id: 'local', command },
        cwd,
        timeoutMs,
        signal: new AbortController().signal,
    });
}

test('ChildProcessVerificationRunner executes the approved command in its requested cwd', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sdd-verify-cwd-'));
    try {
        const result = await run(nodeCommand('process.stdout.write(process.cwd())'), cwd);
        expect(result).toMatchObject({
            status: 'completed',
            exitCode: 0,
            output: cwd,
            truncated: false,
        });
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
// Process startup can be queued behind parallel isolated suites; the runner's
// own timeout remains the production default and the timeout test stays 50ms.
}, 10_000);

test('ChildProcessVerificationRunner bounds stdout deterministically', async () => {
    const result = await run(
        nodeCommand(`process.stdout.write('x'.repeat(${MAX_VERIFY_OUTPUT_CHARS + 100}))`),
        process.cwd(),
    );
    expect(result).toMatchObject({
        status: 'completed',
        exitCode: 0,
        truncated: true,
    });
    expect(result.output).toHaveLength(MAX_VERIFY_OUTPUT_CHARS);
}, 10_000);

test('ChildProcessVerificationRunner hashes the complete interleaved byte stream beyond its preview', async () => {
    const prefix = 'x'.repeat(MAX_VERIFY_OUTPUT_CHARS);
    const first = await run(
        nodeCommand(`process.stdout.write(${JSON.stringify(prefix)}); process.stderr.write('first-suffix')`),
        process.cwd(),
    );
    const second = await run(
        nodeCommand(`process.stdout.write(${JSON.stringify(prefix)}); process.stderr.write('second-suffix')`),
        process.cwd(),
    );

    expect(first.output).toBe(second.output);
    expect(first.output).toHaveLength(MAX_VERIFY_OUTPUT_CHARS);
    expect(first.outputSha256).not.toBe(second.outputSha256);
    expect(first.outputBytes).toBe(Buffer.byteLength(`${prefix}first-suffix`));
    expect(second.outputBytes).toBe(Buffer.byteLength(`${prefix}second-suffix`));
}, 10_000);

test('ChildProcessVerificationRunner truncates a UTF-8 preview before an incomplete code point', async () => {
    const prefix = 'x'.repeat(MAX_VERIFY_OUTPUT_CHARS - 1);
    const raw = `${prefix}étail`;
    const result = await run(nodeCommand(`process.stdout.write(${JSON.stringify(raw)})`), process.cwd());

    expect(result).toMatchObject({
        status: 'completed',
        output: prefix,
        truncated: true,
        outputBytes: Buffer.byteLength(raw),
    });
    expect(result.output).not.toContain('\uFFFD');
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(
        MAX_VERIFY_OUTPUT_CHARS,
    );
    expect(result.outputSha256).toBe(
        createHash('sha256').update(raw).digest('hex'),
    );
}, 10_000);

test('ChildProcessVerificationRunner reports a timed out command', async () => {
    const result = await run(nodeCommand('setInterval(() => {}, 1_000)'), process.cwd(), 50);
    expect(result).toMatchObject({ status: 'timed_out', exitCode: null });
});

test('ChildProcessVerificationRunner cancels a real local command', async () => {
    const controller = new AbortController();
    const running = new ChildProcessVerificationRunner().run({
        command: { id: 'local', command: nodeCommand('setInterval(() => {}, 1_000)') },
        cwd: process.cwd(),
        timeoutMs: 5_000,
        signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);

    const result = await running;
    expect(result).toMatchObject({ status: 'signaled', exitCode: null });
});

async function expectResistantGrandchildStopped(
    termination: 'cancel' | 'timeout',
): Promise<void> {
    const cwd = mkdtempSync(join(tmpdir(), 'sdd-verify-tree-'));
    const escapedWrite = join(cwd, 'grandchild-survived');
    const ready = join(cwd, 'grandchild-started');
    const timeoutMs = 5_000;
    const writeAfterMs = termination === 'timeout' ? 6_200 : 1_300;
    const grandchild = [
        "process.on('SIGTERM', () => {})",
        `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(escapedWrite)}, 'survived'), ${writeAfterMs})`,
    ].join(';');
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1_000)`;
    const controller = new AbortController();
    let running: Promise<unknown> | undefined;
    try {
        running = new ChildProcessVerificationRunner().run({
            command: { id: 'tree', command: nodeCommand(parent) },
            cwd,
            timeoutMs,
            signal: controller.signal,
        });
        for (let attempts = 0; !existsSync(ready) && attempts < 500; attempts += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(existsSync(ready)).toBe(true);
        if (termination === 'cancel') controller.abort();

        await expect(running).resolves.toMatchObject({
            status: termination === 'cancel' ? 'signaled' : 'timed_out',
        });
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        expect(existsSync(escapedWrite)).toBe(false);
    } finally {
        controller.abort();
        await running?.catch(() => undefined);
        rmSync(cwd, { recursive: true, force: true });
    }
}

test('ChildProcessVerificationRunner kills a signal-resistant grandchild before it can write after cancellation', async () => {
    await expectResistantGrandchildStopped('cancel');
// This intentionally starts a real shell, parent, and grandchild; isolated
// suites can delay that startup, while the runner cancellation remains 5s.
}, 10_000);

test('ChildProcessVerificationRunner kills a signal-resistant grandchild before it can write after timeout', async () => {
    await expectResistantGrandchildStopped('timeout');
}, 10_000);
