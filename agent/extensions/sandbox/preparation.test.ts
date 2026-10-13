import { expect, test, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestSession } from "@abdwhb-png/pi-test-harness";
import { createSandboxExtension } from "./index.ts";
import { localMachineId } from "./capabilities/authority.ts";
import { createPrivateTempLease } from "./runtime/private-temp.ts";
import { createRuntimeBundleFixture } from "./runtime/test-runtime-fixture.ts";
import { resolvePrivateRuntime } from "./runtime/runtime-bundle.ts";
import { ExecutionDeadline } from "../_shared/command-execution/deadline.ts";
import { getSandboxRuntime, getSandboxAnalysisPort } from "../_shared/sandbox-runtime/index.ts";
import { resolveShellPolicyForExecution } from "../_shared/shell-runtime/index.ts";

const io: {
    readFile: (...args: Parameters<typeof fs.readFile>) => ReturnType<typeof fs.readFile>;
} = fs;

test.each(["same", "cancel", "supersede", "shutdown", "cleanup"])("replacement preserves admission across %s", async scenario => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const keys = [Symbol.for("pi.shell-capabilities.v1"), Symbol.for("pi.sandbox-runtime.v2")];
    const previous = keys.map(key => Reflect.get(globalThis, key));
    const cancelWaiter = scenario === "cancel";
    let stopped = false;
    let releaseHost: (() => void) | undefined;
    let hostStarted = false;
    let pendingRun: Promise<unknown> | undefined;
    let pendingStop: Promise<unknown> | undefined;
    let clock: ReturnType<typeof spyOn> | undefined;
    let waiter: ExecutionDeadline | undefined;
    let root: string | undefined;
    let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
    const releaseRead = Promise.withResolvers<void>();
    const readEntered = Promise.withResolvers<void>();
    const originalRead = fs.readFile;
    let read: ReturnType<typeof spyOn<typeof io, "readFile">> | undefined;
    let cancelledSignal: AbortSignal | undefined;
    let activeRead = false;
    const engineSignals: (AbortSignal | undefined)[] = [];
    const resolutions: Promise<unknown>[] = [];
    try {
        root = await mkdtemp(join(tmpdir(), "pp-"));
        const agentDir = join(root, "agent"), cwd = join(root, "project"), binaryPath = join(root, "runtime/zerobox");
        await mkdir(join(agentDir, "config"), { recursive: true });
        await mkdir(cwd); await mkdir(join(root, "runtime"));
        await writeFile(binaryPath, "fixture engine", { mode: 0o700 });
        const bundle = await createRuntimeBundleFixture(binaryPath, "fixture-version");
        for (const directory of ["runtime", "runtime/helper", "runtime/components", "runtime/components/shell", "runtime/components/shell/bin", "runtime/components/analysis"]) await chmod(join(root, directory), 0o700);
        await chmod(join(root, "runtime/manifest.json"), 0o600);
        const configPath = join(agentDir, "config/sandbox.json");
        const config = { version: 2, machineId: localMachineId(), docker: { allowed: false } };
        await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
        process.env.PI_CODING_AGENT_DIR = agentDir;
        let probes = 0;
        session = await createTestSession({ cwd, extensionFactories: [pi => createSandboxExtension(pi, {
            zeroboxBackend: { ...bundle, binaryPath,
                resolveRuntime: async options => {
                    probes++;
                    await Bun.sleep(40);
                    const pending = resolvePrivateRuntime(options);
                    resolutions.push(pending.catch(error => error));
                    return pending;
                },
                runCommand: (_file, args, options) => {
                    engineSignals.push(options.signal);
                    return { exitCode: 0, stdout: args.includes("--version") ? "zerobox fixture-version\n" : "", stderr: "" };
                },
            },
            sandboxServiceOptions: { createLease: () => createPrivateTempLease({ rootDir: join(root!, "l") }), recoverStaleLeases: async () => {} },
            analysisServiceOptions: { runHost: async request => {
                if (request.id === "stall") { hostStarted = true; await new Promise<void>(resolve => { releaseHost = resolve; }); }
                return { output: "ok", stderr: "", runtime: request.worker, durationMs: 1, truncated: false };
            } },
        })] });
        await resolveShellPolicyForExecution(cwd);
        if (scenario === "cleanup") {
            const readyLimit = performance.now() + 2000;
            while (true) {
                const runtime = getSandboxRuntime();
                if (runtime.state === "enabled" && runtime.analysis.state === "ready") break;
                if (performance.now() > readyLimit) throw new Error("fixture analysis did not become ready");
                await Bun.sleep(1);
            }
            pendingRun = getSandboxAnalysisPort().run({ id: "stall", language: "python", program: "print(1)" }).catch(error => error);
            while (!hostStarted) { if (performance.now() > readyLimit) throw new Error("fixture analysis did not start"); await Bun.sleep(1); }
            const realTimer = globalThis.setTimeout;
            const scaledTimer = Object.assign((...parameters: Parameters<typeof setTimeout>) => {
                const [handler, ms, ...args] = parameters;
                return realTimer.call(globalThis, handler, ms === 30_000 ? 10 : ms, ...args);
            }, realTimer);
            clock = spyOn(globalThis, "setTimeout").mockImplementation(scaledTimer);
            pendingStop = session.session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" });
            const finished = await Promise.race([pendingStop.then(() => true), Bun.sleep(150).then(() => false)]);
            expect(finished).toBe(true);
            expect(getSandboxRuntime().state).toBe("error");
            stopped = true;
            return;
        }
        const initialProbes = probes;
        if (scenario === "supersede") {
            read = spyOn(io, "readFile").mockImplementation(async (path, options) => {
                if (!cancelledSignal && String(path) === join(root!, "runtime/components/shell/bin/bash")) {
                    cancelledSignal = typeof options === "object" ? options?.signal : undefined;
                    activeRead = true;
                    readEntered.resolve();
                    try {
                        await releaseRead.promise;
                        return await originalRead(path, options);
                    } finally { activeRead = false; }
                }
                return originalRead(path, options);
            });
        }
        await writeFile(configPath, JSON.stringify({ ...config, environment: { variables: { PI_PREPARATION_FIXTURE: "next" } } }), { mode: 0o600 });
        if (cancelWaiter) waiter = new ExecutionDeadline(0.01);
        const first = resolveShellPolicyForExecution(cwd, waiter);
        // Attach the rejection observer before a superseding request cancels startup.
        const firstResult = first.then(value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason }));
        if (scenario === "supersede" || scenario === "shutdown") {
            while (probes === initialProbes) await Bun.sleep(1);
            if (scenario === "supersede") await readEntered.promise;
            if (scenario === "shutdown") {
                await session.session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" });
                stopped = true;
                expect((await firstResult).status).toBe("rejected");
                expect(getSandboxRuntime().state).not.toBe("enabled");
                return;
            }
            await writeFile(configPath, JSON.stringify({ ...config, environment: { variables: { PI_PREPARATION_FIXTURE: "newer" } } }), { mode: 0o600 });
        }
        const [firstOutcome, secondOutcome] = await Promise.all([firstResult, resolveShellPolicyForExecution(cwd).then(value => ({ status: "fulfilled" as const, value }))]);
        expect([firstOutcome.status, secondOutcome.status]).toEqual([cancelWaiter || scenario === "supersede" ? "rejected" : "fulfilled", "fulfilled"]);
        expect(getSandboxRuntime().state).toBe("enabled");
        expect(probes - initialProbes).toBe(scenario === "supersede" ? 2 : 1);
        if (scenario === "supersede") {
            expect(activeRead).toBe(true);
            expect(cancelledSignal?.aborted).toBe(true);
            expect(engineSignals).not.toContain(cancelledSignal);
            const callsBeforeDrain = engineSignals.length;
            releaseRead.resolve();
            await Promise.all(resolutions);
            await new Promise(resolve => setImmediate(resolve));
            expect(activeRead).toBe(false);
            expect(engineSignals).toHaveLength(callsBeforeDrain);
            expect(engineSignals).not.toContain(cancelledSignal);
            expect(getSandboxRuntime().state).toBe("enabled");
        }

    } finally {
        releaseRead.resolve();
        await Promise.all(resolutions);
        read?.mockRestore();
        clock?.mockRestore();
        releaseHost?.();
        await pendingRun;
        await pendingStop;
        waiter?.dispose();
        if (session) { if (!stopped) await session.session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        for (let i = 0; i < keys.length; i++) {
            if (previous[i] === undefined) Reflect.deleteProperty(globalThis, keys[i]); else Reflect.set(globalThis, keys[i], previous[i]);
        }
        if (root) await rm(root, { recursive: true, force: true });
    }
});
