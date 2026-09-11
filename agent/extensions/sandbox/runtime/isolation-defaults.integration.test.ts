import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createSandboxService } from "./service.ts";
import { createZeroboxBackend } from "./zerobox-backend.ts";
import { validatePiSandboxConfig } from "./policies.ts";
import { createSandboxedBashOps } from "../index.ts";
import { createBashProcessSupervisor } from "../../_shared/command-execution/exec.ts";
import { createPrivateTempLease, recoverStalePrivateTempLeases } from "./private-temp.ts";

test.skipIf(process.platform !== "linux" || !process.env.PI_SANDBOX_ZEROBOX_BINARY || !process.env.PI_SANDBOX_ZEROBOX_SHA256)("real isolated Bash cannot reach a host listener or overwrite its authority", async () => {
    const binaryPath = process.env.PI_SANDBOX_ZEROBOX_BINARY;
    const binarySha256 = process.env.PI_SANDBOX_ZEROBOX_SHA256;
    if (!binaryPath || !binarySha256) throw new Error("Explicit candidate binary and SHA256 required");
    const cwd = await mkdtemp("/var/tmp/pi-isolation-");
    const leaseRoot = await mkdtemp("/var/tmp/z-");
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = cwd;
    const authority = join(cwd, "sandbox.json");
    await writeFile(authority, "authority fixture", { mode: 0o600 });
    let requests = 0;
    const server = createServer((_request, response) => { requests++; response.end("host listener"); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing listener address");
    const future = join(cwd, "future-secret");
    const service = createSandboxService({
        backend: createZeroboxBackend({ binaryPath, expectedProvenance: { version: "0.3.3-fork.17", binarySha256 }, probeRoot: join(cwd, "probe") }),
        createLease: () => createPrivateTempLease({ rootDir: leaseRoot }),
        recoverStaleLeases: async () => { await recoverStalePrivateTempLeases({ rootDir: leaseRoot }); },
        config: validatePiSandboxConfig({ filesystem: { allowWrite: ["."], denyRead: [future], denyWrite: [future] } }),
    });
    const supervisor = createBashProcessSupervisor();
    try {
        await service.startBashSession(cwd);
        const operations = createSandboxedBashOps(service, supervisor);
        for (const command of [`curl --fail --silent --max-time 2 http://127.0.0.1:${address.port}`, "printf overwritten > sandbox.json"]) {
            const result = await operations.exec(command, cwd, { timeout: 5, onData() {} });
            expect(result.exitCode).not.toBe(0);
        }
        expect(requests).toBe(0);
        expect(await readFile(authority, "utf8")).toBe("authority fixture");
        // A missing deny must remain enforced if a host process creates the file later.
        await writeFile(future, "host-created secret");
        expect((await operations.exec("cat future-secret", cwd, { timeout: 5, onData() {} })).exitCode).not.toBe(0);
        expect((await operations.exec("printf overwritten > future-secret", cwd, { timeout: 5, onData() {} })).exitCode).not.toBe(0);
        expect(await readFile(future, "utf8")).toBe("host-created secret");
    } finally {
        supervisor.shutdown(); await service.shutdown();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
        await rm(cwd, { recursive: true, force: true });
        await rm(leaseRoot, { recursive: true, force: true });
    }
}, 30_000);
