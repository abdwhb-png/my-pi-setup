import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createZeroboxBackend } from "./zerobox-backend.ts";
import { createRuntimeBundleFixture } from "./test-runtime-fixture.ts";
import { ExecutionDeadline } from "../../_shared/command-execution/deadline.ts";

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
