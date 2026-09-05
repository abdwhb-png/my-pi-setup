import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const MANAGED_ZEROBOX_PATH = join(homedir(), ".pi", "bin", "zerobox");

function runStrict(args: string[], cwd: string) {
    return Bun.spawnSync(
        [
            MANAGED_ZEROBOX_PATH,
            "--profile=analysis-strict",
            "--strict-sandbox",
            `--allow-read=${cwd}`,
            `--allow-write=${cwd}`,
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
