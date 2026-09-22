import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestSession } from "@abdwhb-png/pi-test-harness";
import { createSandboxBashOperations, getSandboxRuntime } from "../../_shared/sandbox-runtime/index.ts";
import { createSandboxExtension } from "../index.ts";
import { localMachineId } from "../capabilities/authority.ts";
import {
    candidateBackendOptions,
    hasCandidateRuntime,
    hostToolReadClosure,
} from "./integration-fixtures.ts";
import { createPrivateTempLease, recoverStalePrivateTempLeases } from "./private-temp.ts";

test.skipIf(process.platform !== "linux" || !hasCandidateRuntime()).each([false, true])(
    "real Pi revocation terminates retained descriptors and descendants before a failed replacement (files=%s)",
    async (files) => {
        const root = await mkdtemp("/var/tmp/pi-revocation-");
        const leaseRoot = await mkdtemp("/var/tmp/z-");
        const cwd = join(root, "project");
        const agentDir = join(root, "agent");
        const tools = join(root, "tools");
        const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
        let replacementMustFail = false;
        let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
        let running: Promise<unknown> | undefined;
        try {
            await Promise.all([cwd, agentDir, tools].map(path => mkdir(path, { mode: 0o700 })));
            await writeFile(join(tools, "resource"), "retained descriptor fixture", { mode: 0o600 });
            const global = { version: 2, machineId: localMachineId(), docker: { allowed: false } };
            const authority = join(agentDir, "sandbox.json");
            await writeFile(authority, JSON.stringify({ ...global, environment: { installations: { local: [{ root: tools, path: [], ...(files ? { files: ["resource"] } : {}) }] } } }), { mode: 0o600 });
            process.env.PI_CODING_AGENT_DIR = agentDir;
            session = await createTestSession({ cwd, extensionFactories: [pi => createSandboxExtension(pi, {
                zeroboxBackend: candidateBackendOptions(join(root, "probe")),
                sandboxServiceOptions: {
                    createLease: () => createPrivateTempLease({ rootDir: leaseRoot }),
                    recoverStaleLeases: async () => { await recoverStalePrivateTempLeases({ rootDir: leaseRoot }); },
                },
                // Only the unrelated Analysis preflight is simulated. Every
                // shell admission, descriptor and descendant uses real Zerobox.
                analysisServiceOptions: { runHost: async request => {
                    if (replacementMustFail) throw new Error("replacement fixture failed");
                    if (!request.id.startsWith("sandbox-preflight-")) throw new Error("unexpected Analysis request");
                    return { output: "1", stderr: "", runtime: request.worker, durationMs: 0, truncated: false };
                } },
            })] });
            let ready!: () => void;
            const admitted = new Promise<void>(resolve => { ready = resolve; });
            let finished = false;
            const operations = createSandboxBashOperations();
            running = operations.exec(
                `exec 9< '${join(tools, "resource")}'; printf admitted > admitted; printf READY; (sleep 4; cat <&9 > escaped-access) & wait`,
                cwd,
                { timeout: 15, onData: chunk => { if (chunk.toString().includes("READY")) ready(); } },
            ).then(value => { finished = true; return value; }, error => { finished = true; return error; });
            await Promise.race([admitted, Bun.sleep(12_000).then(() => { throw new Error("real command did not reach admission"); })]);
            expect(await readFile(join(cwd, "admitted"), "utf8")).toBe("admitted");
            replacementMustFail = true;
            const revokedAt = Date.now();
            await writeFile(authority, JSON.stringify(global), { mode: 0o600 });
            await Promise.race([running, Bun.sleep(3_000).then(() => { throw new Error("revocation did not terminate the old runtime"); })]);
            expect(finished).toBe(true);
            expect(Date.now() - revokedAt).toBeLessThan(3_000);
            await expect(operations.exec("printf replacement", cwd, { timeout: 10, onData() {} })).rejects.toThrow();
            expect(getSandboxRuntime().state).toBe("error");
            // Wait beyond the descendant's scheduled write to prove it cannot
            // continue using an already-open descriptor after its parent stops.
            await Bun.sleep(Math.max(0, 4_200 - (Date.now() - revokedAt)));
            expect(await Bun.file(join(cwd, "escaped-access")).exists()).toBe(false);
            expect(await readFile(join(tools, "resource"), "utf8")).toBe("retained descriptor fixture");
        } finally {
            await session?.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
            await running;
            session?.dispose();
            if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
            await rm(root, { recursive: true, force: true });
            await rm(leaseRoot, { recursive: true, force: true });
        }
    },
    45_000,
);

test.skipIf(
    process.platform !== "linux" ||
        process.env.PI_SANDBOX_MEDIATED_DIRECT_CONTRACT !== "1" ||
        !hasCandidateRuntime(),
)(
    "removing the direct TCP grant terminates a live brokered connection",
    async () => {
        const root = await mkdtemp("/var/tmp/pi-direct-revocation-");
        const leaseRoot = await mkdtemp("/var/tmp/z-");
        const cwd = join(root, "project");
        const agentDir = join(root, "agent");
        const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
        let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
        let running: Promise<unknown> | undefined;
        try {
            await Promise.all(
                [cwd, agentDir, join(cwd, ".pi")].map((path) =>
                    mkdir(path, { recursive: true, mode: 0o700 }),
                ),
            );
            const authority = join(agentDir, "sandbox.json");
            const project = join(cwd, ".pi", "sandbox.json");
            await writeFile(
                authority,
                JSON.stringify({
                    version: 2,
                    machineId: localMachineId(),
                    filesystem: {
                        allowRead: await hostToolReadClosure("/usr/bin/node"),
                    },
                    network: {
                        allowedDomains: ["example.com"],
                        mediatedDirectTcp: {
                            allowed: true,
                            ports: [443],
                        },
                    },
                }),
                { mode: 0o600 },
            );
            await writeFile(
                project,
                JSON.stringify({
                    network: {
                        allowedDomains: ["example.com"],
                        mediatedDirectTcp: {
                            enabled: true,
                            ports: [443],
                        },
                    },
                }),
                { mode: 0o600 },
            );
            await writeFile(
                join(cwd, "hold.cjs"),
                [
                    'const tls = require("node:tls");',
                    "let ready = false;",
                    'const socket = tls.connect({ host: "example.com", port: 443, servername: "example.com", rejectUnauthorized: false }, () => { ready = true; process.stdout.write("READY\\n"); });',
                    "socket.on(\"error\", () => { if (!ready) process.exitCode = 41; });",
                    "setInterval(() => {}, 1_000);",
                ].join("\n"),
                { mode: 0o600 },
            );
            process.env.PI_CODING_AGENT_DIR = agentDir;
            session = await createTestSession({
                cwd,
                extensionFactories: [
                    (pi) =>
                        createSandboxExtension(pi, {
                            zeroboxBackend: candidateBackendOptions(
                                join(root, "probe"),
                            ),
                            sandboxServiceOptions: {
                                createLease: () =>
                                    createPrivateTempLease({
                                        rootDir: leaseRoot,
                                    }),
                                recoverStaleLeases: async () => {
                                    await recoverStalePrivateTempLeases({
                                        rootDir: leaseRoot,
                                    });
                                },
                            },
                            analysisServiceOptions: {
                                runHost: async (request) => {
                                    if (
                                        !request.id.startsWith(
                                            "sandbox-preflight-",
                                        )
                                    )
                                        throw new Error(
                                            "unexpected Analysis request",
                                        );
                                    return {
                                        output: "1",
                                        stderr: "",
                                        runtime: request.worker,
                                        durationMs: 0,
                                        truncated: false,
                                    };
                                },
                            },
                        }),
                ],
            });
            let ready!: () => void;
            const connected = new Promise<void>((resolve) => {
                ready = resolve;
            });
            let finished = false;
            const operations = createSandboxBashOperations();
            running = operations
                .exec("/usr/bin/node hold.cjs", cwd, {
                    timeout: 20,
                    onData: (chunk) => {
                        if (chunk.toString().includes("READY")) ready();
                    },
                })
                .then(
                    (value) => {
                        finished = true;
                        return value;
                    },
                    (error) => {
                        finished = true;
                        return error;
                    },
                );
            await Promise.race([
                connected,
                Bun.sleep(15_000).then(() => {
                    throw new Error("direct TLS connection was not admitted");
                }),
            ]);
            const revokedAt = Date.now();
            await writeFile(
                project,
                JSON.stringify({
                    network: {
                        allowedDomains: ["example.com"],
                        mediatedDirectTcp: { enabled: false, ports: [] },
                    },
                }),
                { mode: 0o600 },
            );
            await Promise.race([
                running,
                Bun.sleep(3_000).then(() => {
                    throw new Error(
                        "direct TCP revocation did not terminate the brokered command",
                    );
                }),
            ]);
            expect(finished).toBe(true);
            expect(Date.now() - revokedAt).toBeLessThan(3_000);
        } finally {
            await session?.session.extensionRunner.emit({
                type: "session_shutdown",
                reason: "quit",
            });
            await running;
            session?.dispose();
            if (priorAgentDir === undefined)
                delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
            await rm(root, { recursive: true, force: true });
            await rm(leaseRoot, { recursive: true, force: true });
        }
    },
    45_000,
);
