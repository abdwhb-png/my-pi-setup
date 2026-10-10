import { expect, mock, test } from "bun:test";
import { createBashOperations } from "./exec.ts";

test("pre-spawn preparation cannot reset the execution timeout", async () => {
    const spawn = mock(() => { throw new Error("unexpected dispatch"); });
    const operations = createBashOperations({
        prepareCommand: async context => { await Bun.sleep(80); return context; },
        spawn,
    });
    await expect(operations.exec("true", process.cwd(), { onData() {}, timeout: 0.01 })).rejects.toThrow("timeout:");
    expect(spawn).not.toHaveBeenCalled();
});

test("a spawn specification arriving after cancellation is cleaned up without dispatch", async () => {
    const cleanup = mock(async () => {});
    const spawn = mock(() => { throw new Error("unexpected dispatch"); });
    const operations = createBashOperations({
        prepareSpawn: async context => {
            await Bun.sleep(80);
            return { ...context, file: "/bin/true", args: [], extraStdio: [], cleanup, supervise: () => ({ ready: Promise.resolve(), settled: Promise.resolve() }) };
        },
        spawn,
    });
    await expect(operations.exec("true", process.cwd(), { onData() {}, timeout: 0.01 })).rejects.toThrow("timeout:");
    await Bun.sleep(100);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
});

test("a late cleanup failure remains attached to the timeout and is reported", async () => {
    const events: import("../execution-provenance/types.ts").ExecutionProvenance[] = [];
    const cleanupError = new Error("fixture cleanup failed");
    const operations = createBashOperations({
        onExecution: event => events.push(event),
        prepareSpawn: async context => {
            await Bun.sleep(80);
            return { ...context, file: "/bin/true", args: [], extraStdio: [], cleanup: async () => { throw cleanupError; }, supervise: () => ({ ready: Promise.resolve(), settled: Promise.resolve() }) };
        },
    });
    const failure = await operations.exec("true", process.cwd(), { onData() {}, timeout: 0.01 }).catch(error => error);
    expect(failure.message).toContain("timeout:");
    await Bun.sleep(100);
    expect(failure.cleanupError).toBe(cleanupError);
    expect(events.at(-1)).toMatchObject({ phase: "cleanup", outcome: "failed" });
});
