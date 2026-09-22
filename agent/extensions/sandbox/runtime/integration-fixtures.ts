import { realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { stageRuntimeRelease } from "./distribution/stage-release.ts";
import type { ZeroboxBackendOptions } from "./zerobox-backend.ts";

const CANDIDATE_BINARY = "PI_SANDBOX_ZEROBOX_BINARY";
const CANDIDATE_SHA256 = "PI_SANDBOX_ZEROBOX_SHA256";
const CANDIDATE_BUNDLE = "PI_SANDBOX_RUNTIME_BUNDLE";
const CANDIDATE_VERSION = "PI_SANDBOX_ZEROBOX_VERSION";

export interface CandidateRuntimeFixture {
    binaryPath: string;
    binarySha256: string;
    runtimeBundlePath: string;
    version: string;
}

/**
 * Real-engine tests are opt-in and must pin both the engine bytes and its
 * private runtime bundle. A bare host-installed engine is never a candidate.
 */
export function candidateRuntimeFixture(): CandidateRuntimeFixture | undefined {
    const binaryPath = process.env[CANDIDATE_BINARY];
    const binarySha256 = process.env[CANDIDATE_SHA256];
    if (!binaryPath && !binarySha256) return undefined;
    if (!binaryPath || !binarySha256) {
        throw new Error(
            `${CANDIDATE_BINARY} and ${CANDIDATE_SHA256} must be supplied together`,
        );
    }
    const runtimeBundlePath =
        process.env[CANDIDATE_BUNDLE] ?? dirname(dirname(binaryPath));
    if (
        process.env[CANDIDATE_BUNDLE] === undefined &&
        join(runtimeBundlePath, "bin", "zerobox") !== binaryPath
    ) {
        throw new Error(
            `${CANDIDATE_BINARY} must be a private bundle bin/zerobox or ${CANDIDATE_BUNDLE} must be supplied`,
        );
    }
    return {
        binaryPath,
        binarySha256,
        runtimeBundlePath,
        version: process.env[CANDIDATE_VERSION] ?? "0.3.3-fork.17",
    };
}

export function hasCandidateRuntime(): boolean {
    return candidateRuntimeFixture() !== undefined;
}

export function candidateBackendOptions(
    probeRoot: string,
): ZeroboxBackendOptions {
    const candidate = candidateRuntimeFixture();
    if (!candidate)
        throw new Error(
            "An explicit private Zerobox runtime candidate is required",
        );
    return {
        binaryPath: candidate.binaryPath,
        expectedProvenance: {
            version: candidate.version,
            binarySha256: candidate.binarySha256,
        },
        runtimeBundlePath: candidate.runtimeBundlePath,
        probeRoot,
    };
}

/**
 * Install a complete candidate release under a disposable HOME using the same
 * managed-entry publication route as production. The fixture provenance is
 * adjacent to that release only; checked-in provenance is never rewritten.
 */
export async function stageCandidateRuntimeInHome(home: string): Promise<void> {
    const candidate = candidateRuntimeFixture();
    if (!candidate)
        throw new Error(
            "An explicit private Zerobox runtime candidate is required",
        );
    if (
        join(candidate.runtimeBundlePath, "bin", "zerobox") !==
        candidate.binaryPath
    ) {
        throw new Error(
            "Managed-entry integration tests require PI_SANDBOX_ZEROBOX_BINARY to be the candidate bundle bin/zerobox",
        );
    }
    const provenanceSource = join(home, "candidate-provenance.json");
    await writeFile(
        provenanceSource,
        `${JSON.stringify({ version: candidate.version, binarySha256: candidate.binarySha256 })}\n`,
        { mode: 0o600, flag: "wx" },
    );
    await stageRuntimeRelease({
        candidateRoot: candidate.runtimeBundlePath,
        runtimeBase: join(home, ".pi", "runtimes"),
        managedBinary: join(home, ".pi", "bin", "zerobox"),
        provenanceSource,
        expectedBinarySha256: candidate.binarySha256,
    });
}

/**
 * Return only the executable and ELF objects required to run one intentional
 * host tool in a real-engine test. Callers must still state why that tool is
 * exposed and assert its target-side behavior.
 */
export async function hostToolReadClosure(
    executable: string,
): Promise<string[]> {
    const ldd = Bun.spawnSync(["/usr/bin/ldd", executable], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    const lddOutput = `${ldd.stdout.toString()}\n${ldd.stderr.toString()}`;
    if (
        ldd.exitCode !== 0 &&
        !/not a dynamic executable|statically linked/i.test(lddOutput)
    ) {
        throw new Error(
            `Could not inspect host test tool ${executable}: ${ldd.stderr.toString()}`,
        );
    }
    const candidates = new Set<string>([executable]);
    for (const line of ldd.stdout.toString().split("\n")) {
        const match = line.match(/=>\s+(\/[^\s(]+)|^\s*(\/[^\s(]+)/);
        const dependency = match?.[1] ?? match?.[2];
        if (dependency) candidates.add(dependency);
    }
    const paths = await Promise.all(
        [...candidates].map(async (path) => [path, await realpath(path)]),
    );
    return [...new Set(paths.flat())];
}
