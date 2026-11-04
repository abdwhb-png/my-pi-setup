import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestSession } from "@abdwhb-png/pi-test-harness";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { writeFixtureFileAsync as writeFile } from "../_shared/testing/config-fixture.ts";
import { localMachineId } from "./capabilities/authority.ts";
import { createSandboxExtension } from "./index.ts";
import { SANDBOX_RUN_MESSAGE } from "./run-command.ts";
import { candidateBackendOptions, candidateRuntimeFixture, hasCandidateRuntime } from "./runtime/integration-fixtures.ts";
import { createPrivateTempLease, recoverStalePrivateTempLeases } from "./runtime/private-temp.ts";

test.skipIf(process.platform !== "linux" || process.env.PI_SANDBOX_RUN_INTEGRATION !== "1" || !hasCandidateRuntime())(
    "real Pi runs an explicitly sandboxed command with verified Zerobox admission in agent host mode",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-manual-runtime-"));
        const agentDir = join(root, "agent");
        const cwd = join(root, "project");
        const leases = await mkdtemp(join(tmpdir(), "z-"));
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        try {
            await mkdir(cwd);
            const candidate = candidateRuntimeFixture();
            if (!candidate) throw new Error("Missing explicit runtime candidate");
            const binaryPath = join(root, "engine", "bin", "zerobox");
            await mkdir(join(root, "engine", "bin"), { recursive: true });
            // Pin test-owned bytes without acquiring the personal runtime's publication lock.
            await copyFile(candidate.binaryPath, binaryPath);
            await writeFile(join(agentDir, "config", "sandbox.json"), JSON.stringify({ version: 2, machineId: localMachineId(), host: { allowed: true } }));
            const witness = join(root, "host-only");
            await writeFile(witness, "host fixture");
            new ProjectTrustStore(agentDir).set(cwd, true);
            session = await createTestSession({ cwd, extensionFactories: [pi => createSandboxExtension(pi, {
                zeroboxBackend: { ...candidateBackendOptions(join(root, "probe")), binaryPath },
                sandboxServiceOptions: {
                    createLease: () => createPrivateTempLease({ rootDir: leases }),
                    recoverStaleLeases: async () => { await recoverStalePrivateTempLeases({ rootDir: leases }); },
                },
                analysisServiceOptions: { runHost: async request => {
                    if (!['sandbox-preflight-typescript', 'sandbox-preflight-python'].includes(request.id)) throw new Error("Unexpected Analysis execution");
                    return { output: "1", stderr: "", runtime: request.worker, durationMs: 0, truncated: false };
                } },
            })] });
            await session.session.prompt("/sandbox mode host");
            await session.session.prompt(`/sandbox run if test -r '${witness}'; then printf escaped; else printf isolated; fi`);
            const messages = session.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === SANDBOX_RUN_MESSAGE);
            expect(messages).toHaveLength(1);
            expect(messages[0]).toMatchObject({ details: { output: "isolated", execution: { mode: "sandbox", status: "sandboxed", backend: "zerobox", outcome: "succeeded", exitCode: 0 } } });
        } finally {
            await session?.close();
            if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            await rm(root, { recursive: true, force: true });
            await rm(leases, { recursive: true, force: true });
        }
    },
    30_000,
);
