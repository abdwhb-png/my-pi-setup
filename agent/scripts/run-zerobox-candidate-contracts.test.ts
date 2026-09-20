import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runner = join(import.meta.dir, "run-zerobox-candidate-contracts.sh");

function runValidation(env: Record<string, string | undefined> = {}) {
    const childEnv = { ...process.env, ...env };
    for (const key of [
        "PI_SANDBOX_RUNTIME_BUNDLE",
        "PI_SANDBOX_ZEROBOX_BINARY",
        "PI_SANDBOX_ZEROBOX_SHA256",
        "PI_SANDBOX_ZEROBOX_SOURCE_ROOT",
    ]) {
        if (!(key in env)) delete childEnv[key];
    }
    return Bun.spawnSync(["/bin/bash", runner, "--validate"], {
        env: childEnv,
        stdout: "pipe",
        stderr: "pipe",
    });
}

test("candidate contract runner rejects an incomplete candidate before executing tests", () => {
    const result = runValidation({
        PI_SANDBOX_ZEROBOX_BINARY: "/tmp/not-a-candidate",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
        "PI_SANDBOX_RUNTIME_BUNDLE is required",
    );
});

test("candidate contract runner accepts a verified private bundle during validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-candidate-runner-"));
    const bundle = join(root, "candidate");
    const binary = join(bundle, "bin", "zerobox");
    try {
        await mkdir(join(bundle, "bin"), { recursive: true });
        await writeFile(binary, "fixture");
        await chmod(binary, 0o500);
        await writeFile(join(bundle, "manifest.json"), "{}\n");
        await writeFile(join(bundle, "provenance.json"), "{}\n");
        const sha256 = new Bun.CryptoHasher("sha256")
            .update("fixture")
            .digest("hex");

        const result = runValidation({
            PI_SANDBOX_RUNTIME_BUNDLE: bundle,
            PI_SANDBOX_ZEROBOX_BINARY: binary,
            PI_SANDBOX_ZEROBOX_SHA256: sha256,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString()).toContain(
            "Zerobox candidate contract configuration is valid",
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
