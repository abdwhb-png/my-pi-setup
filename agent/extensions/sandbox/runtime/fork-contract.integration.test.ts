import { beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const candidateBinary = process.env.PI_SANDBOX_ZEROBOX_BINARY;
const candidateSha = process.env.PI_SANDBOX_ZEROBOX_SHA256;
const enabled = process.platform === "linux" && !!candidateBinary && !!candidateSha;

function runStrict(args: string[], cwd: string, sandboxArgs: string[] = []) {
    if (!candidateBinary || !candidateSha) throw new Error("Explicit candidate binary and SHA256 required");
    return Bun.spawnSync(
        [
            candidateBinary,
            "--profile=analysis-strict",
            "--strict-sandbox",
            `--allow-read=${cwd}`,
            `--allow-write=${cwd}`,
            ...sandboxArgs,
            "--",
            ...args,
        ],
        {
            cwd,
            env: {
                HOME: cwd,
                ZEROBOX_HOME: join(cwd, "z"),
                PATH: "/usr/local/bin:/usr/bin:/bin",
            },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
        },
    );
}

describe.skipIf(!enabled)("accepted Zerobox fork contract", () => {
    beforeAll(async () => {
        if (!candidateBinary || !candidateSha) throw new Error("Explicit candidate binary and SHA256 required");
        expect(createHash("sha256").update(await readFile(candidateBinary)).digest("hex")).toBe(candidateSha);
    });
    it("requires strict Linux sandboxing", async () => {
        const root = await mkdtemp("/var/tmp/f-");
        try { expect(runStrict(["/bin/true"], root).exitCode).toBe(0); }
        finally { await rm(root, { recursive: true, force: true }); }
    });

    it("executes shebang scripts while enforcing dynamic write denies", async () => {
        const root = await mkdtemp("/var/tmp/f-");
        const denied = join(root, "package", "node_modules", "blocked.txt");
        const script = join(root, "runner.sh");
        await mkdir(join(root, "package", "node_modules"), { recursive: true });
        await writeFile(script, "#!/bin/sh\nprintf shebang-ok\n");
        await chmod(script, 0o755);

        try {
            const result = runStrict(
                [
                    "/bin/sh",
                    "-c",
                    "./runner.sh && ! printf blocked >package/node_modules/blocked.txt 2>/dev/null",
                ],
                root,
                ["--deny-write-glob=*/node_modules/*"],
            );

            expect(result.exitCode).toBe(0);
            expect(new TextDecoder().decode(result.stdout)).toBe("shebang-ok");
            expect(await Bun.file(denied).exists()).toBe(false);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("preserves a shebang process stderr and exit code", async () => {
        const root = await mkdtemp("/var/tmp/f-");
        const script = join(root, "failure.sh");
        await mkdir(join(root, "package", "node_modules"), { recursive: true });
        await writeFile(
            script,
            "#!/bin/sh\nprintf 'real-target-error\\n' >&2\nexit 37\n",
        );
        await chmod(script, 0o755);

        try {
            const result = runStrict(
                ["/bin/sh", "-c", "./failure.sh"],
                root,
                ["--deny-write-glob=*/node_modules/*"],
            );

            expect(result.exitCode).toBe(37);
            expect(new TextDecoder().decode(result.stderr)).toBe(
                "real-target-error\n",
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("blocks nested user namespaces and mounts", async () => {
        const root = await mkdtemp("/var/tmp/f-");
        const mountpoint = join(root, "mountpoint");
        await mkdir(mountpoint);
        try {
            const attempts = [
                ["/usr/bin/unshare", "--user", "/bin/true"],
                ["/usr/bin/unshare", "--user", "--mount", "/bin/true"],
                ["/usr/bin/bwrap", "--ro-bind", "/", "/", "/bin/true"],
                ["/usr/bin/mount", "-t", "tmpfs", "tmpfs", mountpoint],
            ];

            for (const attempt of attempts) {
                const result = runStrict(attempt, root);
                expect(result.exitCode).not.toBe(0);
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
