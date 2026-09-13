import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { normalizeAnalysisRequest } from "../../_shared/sandbox-runtime/analysis-protocol.ts";
import { validatePiSandboxConfig } from "../runtime/policies.ts";
import { createPrivateTempLease, recoverStalePrivateTempLeases, worstCaseProxySocketPath } from "../runtime/private-temp.ts";
import { createSandboxService } from "../runtime/service.ts";
import { createZeroboxBackend } from "../runtime/zerobox-backend.ts";
import { candidateBackendOptions, hasCandidateRuntime, stageCandidateRuntimeInHome } from "../runtime/integration-fixtures.ts";
import { PRIVATE_ANALYSIS_ROOT, PRIVATE_BASH } from "../runtime/shell-baseline.ts";
import { executeAnalysisHostRequest, runAnalysisChild } from "./host.ts";

const enabled = process.platform === "linux" &&
    process.env.PI_SANDBOX_REAL_ANALYSIS_CONTRACT === "1" &&
    hasCandidateRuntime();

async function createAnalysisFixture() {
    const root = await mkdtemp("/var/tmp/pi-analysis-");
    const leaseRoot = await mkdtemp("/var/tmp/z-");
    let leasesCreated = 0;
    let recoveries = 0;
    const service = createSandboxService({
        backend: createZeroboxBackend({
            ...candidateBackendOptions(join(root, "probe")),
        }),
        config: validatePiSandboxConfig({}),
        createLease: async () => {
            leasesCreated += 1;
            return createPrivateTempLease({ rootDir: leaseRoot });
        },
        recoverStaleLeases: async () => {
            recoveries += 1;
            await recoverStalePrivateTempLeases({ rootDir: leaseRoot });
        },
    });
    return {
        root, leaseRoot, service,
        counts: () => ({ leasesCreated, recoveries }),
        async dispose() {
            try { await service.shutdown(); }
            finally {
                await rm(root, { recursive: true, force: true });
                await rm(leaseRoot, { recursive: true, force: true });
            }
        },
    };
}

const cases = [
    {
        language: "typescript" as const,
        runtime: "quickjs",
        program: `const total: number = INPUTS[0].value + INPUTS[1].value;
try { INPUTS[0].value = 99; } catch {}
export default { total, value: INPUTS[0].value,
  immutable: Object.isFrozen(INPUTS) && Object.isFrozen(INPUTS[0]) };`,
        isolation: `export default await import('node:fs').then(fs => {
  try { return { filesystem: fs.readFileSync(HOST_MARKER, 'utf8') }; }
  catch { return { filesystem: 'blocked', process: typeof process }; }
}, () => ({ filesystem: 'blocked', process: typeof process }));`,
        expectedIsolation: { filesystem: "blocked", process: "undefined" },
    },
    {
        language: "python" as const,
        runtime: "python",
        program: `immutable = False
try:
    INPUTS[0]['value'] = 99
except Exception:
    immutable = isinstance(INPUTS, tuple)
result = {'total': INPUTS[0]['value'] + INPUTS[1]['value'],
          'value': INPUTS[0]['value'], 'immutable': immutable}`,
        isolation: `checks = {}
try:
    checks['filesystem'] = open(HOST_MARKER).read()
except Exception:
    checks['filesystem'] = 'blocked'
try:
    import subprocess
    checks['process'] = subprocess.check_output(['/bin/echo', 'host'])
except Exception:
    checks['process'] = 'blocked'
result = checks`,
        expectedIsolation: { filesystem: "blocked", process: "blocked" },
    },
];

test.skipIf(!enabled)("admits a real Analysis process before delivering its stdin", async () => {
    const fixture = await createAnalysisFixture();
    try {
        const handle = await fixture.service.prepareAnalysis({
            file: PRIVATE_BASH,
            args: ["-c", "IFS= read -r message; printf '%s' \"$message\""],
            cwd: fixture.root,
        }, [fixture.root]);
        try {
            const result = await runAnalysisChild({
                ...handle.spawn,
                stdin: "admission-ready\n",
                wallTimeMs: 3_000,
                outputBytes: 1_024,
            });
            expect(result.exitCode, result.stderr).toBe(0);
            expect(result.stdout).toBe("admission-ready");
            expect(handle.spawn.getSandboxContext?.()).toMatchObject({ version: 3, admission: "admitted" });
        } finally {
            await handle.dispose();
        }
    } finally {
        await fixture.dispose();
    }
}, 15_000);

test.skipIf(!enabled).each(cases)(
    "runs the real $language Analysis engine with immutable INPUTS and blocked host access",
    async ({ language, runtime, program, isolation, expectedIsolation }) => {
        const fixture = await createAnalysisFixture();
        const { root, leaseRoot, service } = fixture;
        try {
            const marker = join(root, "host-marker");
            await writeFile(marker, "host-private");
            // Use the supplied Analysis component. The host package tree must
            // stay unavailable to the target process.
            const dependencies = {
                service,
                runChild: runAnalysisChild,
                now: () => performance.now(),
                bunPath: join(PRIVATE_ANALYSIS_ROOT, "bin/bun"),
                nodePath: join(PRIVATE_ANALYSIS_ROOT, "bin/node"),
                prlimitPath: join(PRIVATE_ANALYSIS_ROOT, "bin/prlimit"),
                sandboxRoot: PRIVATE_ANALYSIS_ROOT,
            };
            const result = await executeAnalysisHostRequest(normalizeAnalysisRequest({
                id: `real-${language}-inputs`, language, program,
                bindings: { INPUTS: [{ value: 20 }, { value: 22 }] },
                limits: { wallTimeMs: 15_000 },
            }), dependencies);
            expect(JSON.parse(result.output)).toEqual({ total: 42, value: 20, immutable: true });
            expect(result).toMatchObject({
                runtime, truncated: false,
                execution: {
                    status: "sandboxed", backend: "zerobox", profile: "analysis-strict",
                    tmpNamespace: "lease-private", phase: "analysis", outcome: "succeeded", exitCode: 0,
                },
                sandboxContext: { tmp: { path: "/tmp", namespace: "lease-private" } },
            });
            const denied = await executeAnalysisHostRequest(normalizeAnalysisRequest({
                id: `real-${language}-host-denied`, language, program: isolation,
                bindings: { HOST_MARKER: marker },
                limits: { wallTimeMs: 15_000 },
            }), dependencies);
            expect(JSON.parse(denied.output)).toEqual(expectedIsolation);
            expect(denied.execution).toMatchObject({ status: "sandboxed", backend: "zerobox", outcome: "succeeded" });
            expect(await readFile(marker, "utf8")).toBe("host-private");
            expect(fixture.counts()).toEqual({ leasesCreated: 2, recoveries: 1 });
            expect(await readdir(leaseRoot)).toEqual([]);
        } finally {
            await fixture.dispose();
        }
    },
    45_000,
);

// The engines intentionally expose no host filesystem API. Exercise their
// outer Analysis process boundary separately to prove that /tmp writes do not
// reach host /tmp, without claiming a writable engine filesystem API exists.
test.skipIf(!enabled)("the real outer Analysis process uses private HOME and tmp and cannot read a host fixture", async () => {
    const fixture = await createAnalysisFixture();
    const { root, service, leaseRoot } = fixture;
    try {
        const marker = join(root, "host-marker");
        const cwd = join(root, "work");
        await mkdir(cwd);
        const privateName = `${basename(root)}-private`;
        const hostTmpPath = join("/tmp", privateName);
        await writeFile(marker, "host-private");
        await expect(readFile(hostTmpPath)).rejects.toMatchObject({ code: "ENOENT" });
        const handle = await service.prepareAnalysis({
            file: PRIVATE_BASH,
            args: ["-c", [
                'test ! -e "$1"',
                'test "$HOME" = /home/sandbox',
                'test "$TMPDIR" = /tmp',
                'printf private > "/tmp/$2"',
                'cat "/tmp/$2"',
            ].join(" && "), "analysis-fixture", marker, privateName],
            cwd,
        }, [cwd]);
        try {
            const result = await runAnalysisChild({
                ...handle.spawn,
                stdin: "", wallTimeMs: 10_000, outputBytes: 1_024,
            });
            expect(result.exitCode, result.stderr).toBe(0);
            expect(result.stdout).toBe("private");
            expect(result.execution).toMatchObject({
                status: "sandboxed", backend: "zerobox", profile: "analysis-strict",
                tmpNamespace: "lease-private", outcome: "succeeded",
            });
        } finally {
            await handle.dispose();
        }
        await expect(readFile(hostTmpPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(marker, "utf8")).toBe("host-private");
        expect(await readdir(leaseRoot)).toEqual([]);
    } finally {
        await fixture.dispose();
    }
}, 20_000);

test.skipIf(
    process.platform !== "linux" ||
        process.env.PI_SANDBOX_REAL_ANALYSIS_IPC_CONTRACT !== "1" ||
        !hasCandidateRuntime(),
)(
    "the default Analysis client carries successes and worker errors through real host IPC in a fixture HOME",
    async () => {
        // Default leases add .pi/zbx below HOME. Three random characters leave
        // the conservative AF_UNIX socket path at 107 bytes; mkdir is exclusive.
        let home = "";
        for (let attempt = 0; attempt < 32 && !home; attempt += 1) {
            const candidate = join("/var/tmp", randomBytes(2).toString("base64url"));
            try {
                await mkdir(candidate, { mode: 0o700 });
                home = candidate;
            } catch (error) {
                if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
            }
        }
        if (!home) throw new Error("Could not allocate an exclusive short fixture HOME");
        try {
            expect(Buffer.byteLength(worstCaseProxySocketPath(join(home, ".pi/zbx/l-123456/zerobox-home")))).toBeLessThan(108);
            // Stage the full candidate through the managed-entry publication
            // path. The child below uses production defaults unchanged.
            await stageCandidateRuntimeInHome(home);
            const entrypoint = join(home, "client.ts");
            await writeFile(entrypoint, `
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { createAnalysisSandboxService } from ${JSON.stringify(join(import.meta.dir, "client.ts"))};
assert.equal(homedir(), ${JSON.stringify(home)});
const service = createAnalysisSandboxService();
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 40_000);
process.once("SIGTERM", () => controller.abort());
try {
    const javascript = await service.run({ id: "ipc-js", language: "javascript",
        program: "export default Number(INPUT) * 2", bindings: { INPUT: "21" },
        limits: { wallTimeMs: 10_000 } }, controller.signal);
    const python = await service.run({ id: "ipc-python", language: "python",
        program: "result = int(INPUT) * 2", bindings: { INPUT: "21" },
        limits: { wallTimeMs: 10_000 } }, controller.signal);
    let failure;
    try {
        await service.run({ id: "ipc-error", language: "javascript",
            program: 'throw new Error("ipc worker fixture failure")',
            limits: { wallTimeMs: 10_000 } }, controller.signal);
    } catch (error) {
        failure = { message: error.message, execution: error.execution };
    }
    process.stdout.write(JSON.stringify({ home: homedir(), javascript, python, failure }));
} finally {
    clearTimeout(timer);
    await service.shutdown();
}
`);
            // Only this child changes HOME. Its production host subprocesses
            // inherit it and own all default probes, leases, and recovery paths.
            const child = Bun.spawn([process.execPath, entrypoint], {
                cwd: home,
                env: { HOME: home, PATH: process.env.PATH },
                stdout: "pipe",
                stderr: "pipe",
                timeout: 50_000,
            });
            const [exitCode, stdout, stderr] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
            ]);
            expect(exitCode, stderr).toBe(0);
            const result = JSON.parse(stdout);
            expect(result.home).toBe(home);
            for (const [language, runtime] of [["javascript", "quickjs"], ["python", "python"]]) {
                expect(result[language!]).toMatchObject({ output: "42", runtime,
                    execution: { status: "sandboxed", backend: "zerobox", profile: "analysis-strict",
                        tmpNamespace: "lease-private", phase: "analysis", outcome: "succeeded", exitCode: 0 } });
            }
            expect(result.failure).toMatchObject({
                message: expect.stringContaining("ipc worker fixture failure"),
                execution: { status: "sandboxed", backend: "zerobox", profile: "analysis-strict",
                    tmpNamespace: "lease-private", phase: "analysis", outcome: "failed", exitCode: expect.any(Number) },
            });
            expect(await readdir(join(home, ".pi", "zbx"))).toEqual([]);
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    },
    // Full bundle copying and integrity checks precede the separately bounded
    // 50-second child. Leave room for that setup on a busy test host.
    120_000,
);
