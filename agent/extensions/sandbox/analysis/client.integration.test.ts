import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { validatePiSandboxConfig } from "../runtime/policies.ts";
import { createPrivateTempLease, recoverStalePrivateTempLeases } from "../runtime/private-temp.ts";
import { createSandboxService, type SandboxService } from "../runtime/service.ts";
import { createZeroboxBackend } from "../runtime/zerobox-backend.ts";
import { executeAnalysisHostRequest, runAnalysisChild } from "./host.ts";

import {
    createAnalysisSandboxService,
    type AnalysisSandboxService,
} from "./client.ts";

let service: AnalysisSandboxService | undefined;
let runtime: SandboxService | undefined;
let fixtureRoot: string | undefined;
let leaseRoot: string | undefined;
const enabled = process.platform === "linux" &&
    !!process.env.PI_SANDBOX_ZEROBOX_BINARY && !!process.env.PI_SANDBOX_ZEROBOX_SHA256;

async function createIsolatedAnalysisService(): Promise<AnalysisSandboxService> {
    const binaryPath = process.env.PI_SANDBOX_ZEROBOX_BINARY;
    const binarySha256 = process.env.PI_SANDBOX_ZEROBOX_SHA256;
    if (!binaryPath || !binarySha256) throw new Error("Explicit Zerobox binary and SHA256 are required");
    fixtureRoot = await mkdtemp("/var/tmp/pi-client-");
    leaseRoot = await mkdtemp("/var/tmp/z-");
    const isolatedLeaseRoot = leaseRoot;
    runtime = createSandboxService({
        backend: createZeroboxBackend({
            binaryPath,
            expectedProvenance: { version: "0.3.3-fork.17", binarySha256 },
            probeRoot: join(fixtureRoot, "probe"),
        }),
        config: validatePiSandboxConfig({}),
        createLease: () => createPrivateTempLease({ rootDir: isolatedLeaseRoot }),
        recoverStaleLeases: async () => {
            await recoverStalePrivateTempLeases({ rootDir: isolatedLeaseRoot });
        },
    });
    const dependencies = {
        service: runtime,
        runChild: runAnalysisChild,
        now: () => performance.now(),
        bunPath: await realpath(process.execPath),
        nodePath: await realpath("/usr/bin/node"),
        prlimitPath: await realpath("/usr/bin/prlimit"),
        sandboxRoot: await realpath(resolve(import.meta.dir, "..")),
    };
    // Exercise the real client and engines with isolated host dependencies.
    // The host-process IPC transport is outside this fixture's coverage.
    return createAnalysisSandboxService({
        runHost: (request, signal) => executeAnalysisHostRequest(request, { ...dependencies, signal }),
    });
}

afterEach(async () => {
    try {
        await service?.shutdown();
    } finally {
        try { await runtime?.shutdown(); }
        finally {
            if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
            if (leaseRoot) await rm(leaseRoot, { recursive: true, force: true });
            service = undefined;
            runtime = undefined;
            fixtureRoot = undefined;
            leaseRoot = undefined;
        }
    }
});

describe.skipIf(!enabled)("strict analysis sandbox integration", () => {
    it('retains actual worker execution facts on an analysis error', async () => {
        service = await createIsolatedAnalysisService();
        let error: unknown;
        try {
            await service.run({ id: 'provenance-analysis-error', language: 'javascript', program: 'throw new Error("fixture failure")', limits: { wallTimeMs: 15000 } });
        } catch (failure) { error = failure; }
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({ execution: { status: 'sandboxed', profile: 'analysis-strict', tmpNamespace: 'lease-private', phase: 'analysis', outcome: 'failed', exitCode: expect.any(Number) } });
    }, 20000);
    it("executes QuickJS and Eryx only through the outer sandbox", async () => {
        service = await createIsolatedAnalysisService();

        const javascript = await service.run({
            id: "integration-js",
            language: "javascript",
            program: "export default INPUT.length",
            bindings: { INPUT: "abcdef" },
            limits: { wallTimeMs: 15_000 },
        });
        const python = await service.run({
            id: "integration-python",
            language: "python",
            program: "result = int(INPUT) * 2",
            bindings: { INPUT: "21" },
            limits: { wallTimeMs: 15_000 },
        });

        expect(javascript).toMatchObject({
            execution: { status: "sandboxed", profile: "analysis-strict", backend: "zerobox", tmpNamespace: "lease-private", phase: "analysis", outcome: "succeeded", exitCode: 0 },
            output: "6",
            runtime: "quickjs",
            truncated: false,
        });
        expect(python).toMatchObject({
            output: "42",
            runtime: "python",
            truncated: false,
        });
    }, 20_000);

    it("executes TypeScript through the outer sandbox", async () => {
        service = await createIsolatedAnalysisService();

        const result = await service.run({
            id: "integration-typescript",
            language: "typescript",
            program:
                "const value: number = Number(INPUT) * 2; export default value",
            bindings: { INPUT: "21" },
            limits: { wallTimeMs: 15_000 },
        });

        expect(result).toMatchObject({
            output: "42",
            runtime: "quickjs",
            truncated: false,
        });
    }, 20_000);

    it("accepts logical output exactly at the configured byte cap", async () => {
        service = await createIsolatedAnalysisService();

        const result = await service.run({
            id: "integration-exact-output-cap",
            language: "typescript",
            program: "export default 'x'",
            limits: { wallTimeMs: 15_000, outputBytes: 1 },
        });

        expect(result.output).toBe("x");
    }, 20_000);

    it("exposes immutable structured INPUTS to TypeScript and Python", async () => {
        service = await createIsolatedAnalysisService();
        const inputs = [
            { id: "one", payload: { value: "original" } },
        ] as unknown as string;

        const typescript = await service.run({
            id: "integration-structured-typescript",
            language: "typescript",
            program: [
                "const item = INPUTS[0];",
                "try { item.payload.value = 'mutated'; } catch {}",
                "export default JSON.stringify({",
                "  array: Array.isArray(INPUTS),",
                "  frozenArray: Object.isFrozen(INPUTS),",
                "  frozenItem: Object.isFrozen(item),",
                "  frozenPayload: Object.isFrozen(item.payload),",
                "  value: item.payload.value,",
                "});",
            ].join("\n"),
            bindings: { INPUTS: inputs },
            limits: { wallTimeMs: 15_000 },
        });
        const python = await service.run({
            id: "integration-structured-python",
            language: "python",
            program: [
                "mutation = 'allowed'",
                "try:",
                "    INPUTS[0]['payload']['value'] = 'mutated'",
                "except Exception:",
                "    mutation = 'blocked'",
                "result = {",
                "    'tuple': isinstance(INPUTS, tuple),",
                "    'mutation': mutation,",
                "    'value': INPUTS[0]['payload']['value'],",
                "}",
            ].join("\n"),
            bindings: { INPUTS: inputs },
            limits: { wallTimeMs: 5_000 },
        });

        expect(JSON.parse(typescript.output)).toEqual(
            JSON.parse(
                '{"array":true,"frozenArray":true,"frozenItem":true,"frozenPayload":true,"value":"original"}',
            ),
        );
        expect(JSON.parse(python.output)).toEqual(
            JSON.parse(
                '{"tuple":true,"mutation":"blocked","value":"original"}',
            ),
        );
    }, 20_000);

    it("kills infinite loops and oversized output", async () => {
        service = await createIsolatedAnalysisService();

        await expect(
            service.run({
                id: "integration-timeout",
                language: "python",
                program: "while True: pass",
                limits: { wallTimeMs: 200, cpuSeconds: 1 },
            }),
        ).rejects.toThrow(/wall time|timed out|aborted|signal|killed/i);
        await expect(
            service.run({
                id: "integration-output",
                language: "javascript",
                program: "export default 'x'.repeat(10_000)",
                limits: { wallTimeMs: 5_000, outputBytes: 1_024 },
            }),
        ).rejects.toThrow(/output exceeds/i);
    }, 20_000);
});
