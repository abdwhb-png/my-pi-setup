/// <reference types="bun" />

import { beforeEach, afterEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
    createSandboxBashOperations,
    getSandboxAnalysisPort,
    getSandboxRuntime,
    isSandboxUnavailableError,
} from "../_shared/sandbox-runtime/index.ts";
import { createSandboxExtension } from "./index.ts";
import { localMachineId } from "./capabilities/authority.ts";
import { createPrivateTempLease, recoverStalePrivateTempLeases } from "./runtime/private-temp.ts";

const realBackendEnabled = process.platform === "linux" &&
    !!process.env.PI_SANDBOX_ZEROBOX_BINARY && !!process.env.PI_SANDBOX_ZEROBOX_SHA256;
let fixtureRoot: string;
let leaseRoot: string;
let analysisRequests: string[];

type SessionHandler = (
    event: unknown,
    ctx: ExtensionContext,
) => Promise<void>;

function registerSandbox(options: { noSandbox?: boolean } = {}): {
    start: SessionHandler;
    stop?: SessionHandler;
} {
    let start: SessionHandler | undefined;
    let stop: SessionHandler | undefined;
    const pi = {
        registerFlag: () => undefined,
        registerTool: () => {
            throw new Error("sandbox must not register a tool");
        },
        registerCommand: () => undefined,
        on: (event: string, handler: SessionHandler) => {
            if (event === "session_start") start = handler;
            if (event === "session_shutdown") stop = handler;
        },
        getFlag: () => options.noSandbox ?? true,
    } as unknown as ExtensionAPI;

    createSandboxExtension(pi, {
        zeroboxBackend: {
            // The malformed-config unit test never reaches backend probing.
            // Its explicit missing fixture path still prevents personal fallback.
            binaryPath: process.env.PI_SANDBOX_ZEROBOX_BINARY ?? join(fixtureRoot, "missing-zerobox"),
            expectedProvenance: {
                version: "0.3.3-fork.17",
                binarySha256: process.env.PI_SANDBOX_ZEROBOX_SHA256 ?? "0".repeat(64),
            },
            probeRoot: join(fixtureRoot, "probe"),
        },
        sandboxServiceOptions: {
            createLease: () => createPrivateTempLease({ rootDir: leaseRoot }),
            recoverStaleLeases: async () => {
                await recoverStalePrivateTempLeases({ rootDir: leaseRoot });
            },
        },
        // This file tests runtime publication and Bash. Real Analysis engines
        // are covered separately; these preflights perform no host I/O.
        analysisServiceOptions: { runHost: async (request) => {
            if (!["sandbox-preflight-typescript", "sandbox-preflight-python"].includes(request.id)) {
                throw new Error("Unexpected Analysis execution in publication test");
            }
            analysisRequests.push(request.id);
            return { output: "1", stderr: "", runtime: request.worker, durationMs: 0, truncated: false };
        } },
    });
    if (!start) throw new Error("sandbox session_start was not registered");
    return { start, stop };
}

const context = {
    cwd: process.cwd(),
    hasUI: false,
    isProjectTrusted: () => true,
    ui: { notify: mock(() => undefined) },
} as unknown as ExtensionContext;

describe("sandbox runtime publication", () => {
    let previousAgentDir: string | undefined;
    let agentDir: string;
    beforeEach(async () => {
        previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        fixtureRoot = await mkdtemp("/var/tmp/pi-exec-");
        leaseRoot = await mkdtemp("/var/tmp/z-");
        agentDir = join(fixtureRoot, "agent");
        await mkdir(agentDir);
        analysisRequests = [];
        process.env.PI_CODING_AGENT_DIR = agentDir;
    });
    afterEach(async () => {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(fixtureRoot, { recursive: true, force: true });
        await rm(leaseRoot, { recursive: true, force: true });
    });
    it.skipIf(!realBackendEnabled)("keeps the strict engine enabled when the legacy flag requests host shell", async () => {
        await writeFile(join(agentDir, "sandbox.json"), JSON.stringify({
            version: 2, machineId: localMachineId(), mode: "host",
        }));
        const hostContext = { ...context, cwd: fixtureRoot } as ExtensionContext;
        const registered = registerSandbox({ noSandbox: true });
        try {
            await registered.start({}, hostContext);
            expect(getSandboxRuntime().state).toBe("enabled");
            expect(getSandboxAnalysisPort()).toBeDefined();
        } finally { await registered.stop?.({}, hostContext); }
        expect(analysisRequests.sort()).toEqual(["sandbox-preflight-python", "sandbox-preflight-typescript"]);
    }, 15_000);

    it("publishes a bounded error snapshot for malformed config", async () => {
        const cwd = await mkdtemp(join(fixtureRoot, "malformed-"));
        await mkdir(join(cwd, ".pi"));
        await writeFile(join(cwd, ".pi", "sandbox.json"), "{ invalid");
        const malformedContext = { ...context, cwd } as ExtensionContext;

        const registered = registerSandbox({ noSandbox: false });
        try {
            await registered.start({}, malformedContext);
            expect(getSandboxRuntime()).toEqual({ state: "error" });
            let captured: unknown;
            try {
                await createSandboxBashOperations().exec(
                    "printf should-not-run",
                    cwd,
                    { onData: () => undefined },
                );
            } catch (error) {
                captured = error;
            }
            expect(isSandboxUnavailableError(captured)).toBe(true);
            if (isSandboxUnavailableError(captured)) {
                expect(captured.getKind()).toBe("initialization-failed");
                expect(captured.message).not.toContain("sandbox.json");
                expect(JSON.stringify(captured)).not.toContain("sandbox.json");
            }
        } finally {
            await registered.stop?.({}, malformedContext);
            await rm(cwd, { recursive: true, force: true });
        }
    });

    it.skipIf(!realBackendEnabled)("publishes executable Zerobox operations and analysis together", async () => {
        const cwd = await mkdtemp(join(fixtureRoot, "project-"));
        await mkdir(join(cwd, ".pi"));
        await writeFile(
            join(cwd, ".pi", "sandbox.json"),
            JSON.stringify({
                filesystem: { allowWrite: ["."], denyWrite: [".env"] },
                network: { allowedDomains: [], deniedDomains: [] },
            }),
        );
        const realContext = { ...context, cwd } as ExtensionContext;
        const registered = registerSandbox({ noSandbox: false });
        const chunks: string[] = [];
        try {
            await registered.start({}, realContext);
            expect(getSandboxRuntime().state).toBe("enabled");
            const result = await createSandboxBashOperations().exec(
                "printf zerobox-index",
                cwd,
                { onData: (chunk) => chunks.push(chunk.toString()) },
            );
            expect(result.exitCode).toBe(0);
            expect(chunks.join("")).toBe("zerobox-index");
        } finally {
            await registered.stop?.({}, realContext);
            await rm(cwd, { recursive: true, force: true });
        }
        expect(analysisRequests.sort()).toEqual(["sandbox-preflight-python", "sandbox-preflight-typescript"]);
    }, 30_000);
});
