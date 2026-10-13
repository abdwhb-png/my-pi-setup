import { expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createZeroboxBackend } from "./zerobox-backend.ts";
import { createRuntimeBundleFixture } from "./test-runtime-fixture.ts";
import { ExecutionDeadline } from "../../_shared/command-execution/deadline.ts";
import { resolvePrivateRuntime } from "./runtime-bundle.ts";

const io: {
    readFile: (...args: Parameters<typeof fs.readFile>) => ReturnType<typeof fs.readFile>;
} = fs;

test("engine verification reads the executable once with the admission signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-engine-read-"));
    const deadline = new ExecutionDeadline(30);
    let read: ReturnType<typeof spyOn<typeof io, "readFile">> | undefined;
    try {
        const binaryPath = join(root, "zerobox");
        await writeFile(binaryPath, "fixture engine", { mode: 0o700 });
        const fixture = await createRuntimeBundleFixture(binaryPath, "fixture-version");
        read = spyOn(io, "readFile");
        const backend = createZeroboxBackend({ ...fixture, binaryPath,
            runCommand: (_file, args) => ({ exitCode: 0, stdout: args.includes("--version") ? "zerobox fixture-version\n" : "", stderr: "" }),
        });
        await backend.probe(deadline);
        const reads = read.mock.calls.filter(([path]) => String(path) === binaryPath);
        expect(reads).toHaveLength(1);
        expect(reads[0][1]).toMatchObject({ signal: deadline.signal });
    } finally {
        read?.mockRestore();
        deadline.dispose();
        await rm(root, { recursive: true, force: true });
    }
});

test("a stalled asynchronous engine probe respects its startup deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-probe-deadline-"));
    let deadline: ExecutionDeadline | undefined;
    let started = false;
    try {
        const binaryPath = join(root, "zerobox");
        await writeFile(binaryPath, "fixture engine", { mode: 0o700 });
        const fixture = await createRuntimeBundleFixture(binaryPath, "fixture-version");
        await chmod(join(root, "manifest.json"), 0o600);
        deadline = new ExecutionDeadline(0.5);
        const backend = createZeroboxBackend({ ...fixture, binaryPath,
            runCommand: async (_file, _args, options) => new Promise((_, reject) => {
                started = true;
                options.signal?.throwIfAborted();
                options.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
            }),
        });
        await expect(backend.probe(deadline)).rejects.toThrow("timeout:");
        expect(started).toBe(true);
    } finally { deadline?.dispose(); await rm(root, { recursive: true, force: true }); }
});

test.each(["timeout:30", "aborted"])("%s during distribution verification prevents even a late engine start", async reasonText => {
    const root = await mkdtemp(join(tmpdir(), "pi-verification-deadline-"));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalRead = fs.readFile;
    let deadline: ExecutionDeadline | undefined;
    let read: ReturnType<typeof spyOn<typeof io, "readFile">> | undefined;
    let resolution: ReturnType<typeof resolvePrivateRuntime> | undefined;
    let probe: Promise<unknown> | undefined;
    try {
        const binaryPath = join(root, "zerobox");
        await writeFile(binaryPath, "fixture engine", { mode: 0o700 });
        const fixture = await createRuntimeBundleFixture(binaryPath, "fixture-version");
        read = spyOn(io, "readFile").mockImplementation(async (path, options) => {
            if (String(path) === join(root, "components/shell/bin/bash")) {
                entered.resolve();
                await release.promise;
            }
            return originalRead(path, options);
        });
        const runCommand = mock(() => ({ exitCode: 0, stdout: "", stderr: "" }));
        const backend = createZeroboxBackend({ ...fixture, binaryPath, runCommand,
            resolveRuntime: options => {
                resolution = resolvePrivateRuntime(options);
                return resolution;
            },
        });
        deadline = new ExecutionDeadline(30);
        probe = backend.probe(deadline).catch(error => error);
        await entered.promise;
        const reason = new Error(reasonText);
        deadline.cancel(reason);
        expect(await probe).toBe(reason);
        expect(runCommand).not.toHaveBeenCalled();
        release.resolve();
        await expect(resolution).rejects.toBe(reason);
        await new Promise(resolve => setImmediate(resolve));
        expect(runCommand).not.toHaveBeenCalled();
    } finally {
        release.resolve();
        await probe;
        await resolution?.catch(() => {});
        read?.mockRestore();
        deadline?.dispose();
        await rm(root, { recursive: true, force: true });
    }
});
