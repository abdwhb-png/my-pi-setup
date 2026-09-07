import { expect, test } from "bun:test";
import { createBashOperations } from "./exec.ts";

test("reports the actual host process exit independently from stdout and stderr", async () => {
    const events: object[] = [];
    let output = "";
    const operations = createBashOperations({ onExecution: event => events.push(event) });
    const result = await operations.exec("printf stdout; printf stderr >&2; exit 37", process.cwd(), {
        onData: chunk => { output += chunk.toString(); },
    });
    expect(result.exitCode).toBe(37);
    expect(output).toContain("stdout");
    expect(output).toContain("stderr");
    expect(events.at(-1)).toMatchObject({
        status: "unsandboxed", backend: "local", profile: "none", tmpNamespace: "host",
        phase: "process", outcome: "failed", exitCode: 37,
    });
});

test("does not claim a sandbox ran when preparation fails", async () => {
    const events: object[] = [];
    const operations = createBashOperations({
        onExecution: event => events.push(event),
        prepareSpawn: async () => { throw new Error("fixture preparation failure"); },
    });
    await expect(operations.exec("printf never", process.cwd(), { onData: () => undefined }))
        .rejects.toThrow("fixture preparation failure");
    expect(events.at(-1)).toMatchObject({ status: "unknown", phase: "setup", outcome: "failed" });
    expect(events.every(event => !("status" in event) || event.status !== "sandboxed")).toBe(true);
});

test.each(['timeout', 'abort'] as const)('preserves process facts and partial output on %s', async kind => {
    const controller = new AbortController();
    const events: object[] = [];
    let output = '';
    const operations = createBashOperations({ onExecution: value => events.push(value) });
    const pending = operations.exec('printf started; sleep 10', process.cwd(), { timeout: kind === 'timeout' ? 0.2 : undefined, signal: controller.signal, onData: chunk => { output += chunk.toString(); if (kind === 'abort') controller.abort(); } });
    await expect(pending).rejects.toThrow(kind === 'timeout' ? 'timeout:' : 'aborted');
    expect(output).toContain('started');
    expect(events.at(-1)).toMatchObject({ status: 'unsandboxed', phase: 'process', outcome: kind === 'timeout' ? 'timed-out' : 'aborted', exitCode: null });
});

test('reports setup failure when a command rewrite throws before spawning', async () => {
    const events: object[] = [];
    const operations = createBashOperations({ onExecution: value => events.push(value), rewriteCommand: () => { throw new Error('invalid rewrite'); } });
    await expect(operations.exec('printf never', process.cwd(), { onData: () => undefined })).rejects.toThrow('invalid rewrite');
    expect(events.at(-1)).toMatchObject({ status: 'unknown', phase: 'setup', outcome: 'failed' });
});
