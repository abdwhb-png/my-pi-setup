import { describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const MANAGED_ZEROBOX_PATH = join(homedir(), ".pi", "bin", "zerobox");

function runStrict(args: string[], cwd: string, sandboxArgs: string[] = []) {
    return Bun.spawnSync(
        [
            MANAGED_ZEROBOX_PATH,
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
                HOME: homedir(),
                PATH: "/usr/local/bin:/usr/bin:/bin",
            },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
        },
    );
}

describe("accepted Zerobox fork contract", () => {
    it("requires strict Linux sandboxing", () => {
        const result = runStrict(["/bin/true"], process.cwd());
        expect(result.exitCode).toBe(0);
    });

    it("executes shebang scripts while enforcing dynamic write denies", async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-zbx-fork-contract-"));
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
        const root = await mkdtemp(join(tmpdir(), "pi-zbx-fork-contract-"));
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
        const root = await mkdtemp(join(tmpdir(), "pi-zbx-fork-contract-"));
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
