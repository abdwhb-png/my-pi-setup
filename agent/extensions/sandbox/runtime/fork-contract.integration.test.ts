import { beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { candidateRuntimeFixture, hasCandidateRuntime, hostToolReadClosure } from "./integration-fixtures.ts";
import { PRIVATE_BASH, PRIVATE_SHELL_PATH } from "./shell-baseline.ts";

const candidate = candidateRuntimeFixture();
const enabled = process.platform === "linux" && hasCandidateRuntime();

function runStrict(args: string[], cwd: string, sandboxArgs: string[] = []) {
    if (!candidate) throw new Error("An explicit private Zerobox runtime candidate is required");
    return Bun.spawnSync(
        [
            candidate.binaryPath,
            "--profile=analysis-strict",
            "--strict-sandbox",
            `--runtime-bundle=${candidate.runtimeBundlePath}`,
            "--runtime-component=shell",
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
                PATH: PRIVATE_SHELL_PATH,
            },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
        },
    );
}

// This direct CLI suite intentionally retains the legacy status-v1 route to
// keep engine compatibility coverage. Backend integration tests assert v2 and
// the FD4 admission receipt separately.
describe.skipIf(!enabled)("accepted Zerobox fork contract", () => {
    beforeAll(async () => {
        if (!candidate) throw new Error("An explicit private Zerobox runtime candidate is required");
        expect(createHash("sha256").update(await readFile(candidate.binaryPath)).digest("hex")).toBe(candidate.binarySha256);
    });
    it("requires strict Linux sandboxing", async () => {
        const root = await mkdtemp("/var/tmp/f-");
        try { expect(runStrict([`${PRIVATE_SHELL_PATH}/true`], root).exitCode).toBe(0); }
        finally { await rm(root, { recursive: true, force: true }); }
    });

    it("executes shebang scripts while enforcing dynamic write denies", async () => {
        const root = await mkdtemp("/var/tmp/f-");
        const denied = join(root, "package", "node_modules", "blocked.txt");
        const script = join(root, "runner.sh");
        await mkdir(join(root, "package", "node_modules"), { recursive: true });
        await writeFile(script, `#!${PRIVATE_BASH}\nprintf shebang-ok\n`);
        await chmod(script, 0o755);

        try {
            const result = runStrict(
                [
                    PRIVATE_BASH,
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
            `#!${PRIVATE_BASH}\nprintf 'real-target-error\\n' >&2\nexit 37\n`,
        );
        await chmod(script, 0o755);

        try {
            const result = runStrict(
                [PRIVATE_BASH, "-c", "./failure.sh"],
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
            const [unshareRead, bwrapRead, mountRead] = await Promise.all([
                hostToolReadClosure("/usr/bin/unshare"),
                hostToolReadClosure("/usr/bin/bwrap"),
                hostToolReadClosure("/usr/bin/mount"),
            ]);
            const attempts = [
                { args: ["/usr/bin/unshare", "--user", `${PRIVATE_SHELL_PATH}/true`], readable: unshareRead },
                { args: ["/usr/bin/unshare", "--user", "--mount", `${PRIVATE_SHELL_PATH}/true`], readable: unshareRead },
                { args: ["/usr/bin/bwrap", "--ro-bind", "/", "/", `${PRIVATE_SHELL_PATH}/true`], readable: bwrapRead },
                { args: ["/usr/bin/mount", "-t", "tmpfs", "tmpfs", mountpoint], readable: mountRead },
            ];

            for (const attempt of attempts) {
                const executable = attempt.args[0]!;
                expect(runStrict([executable, "--version"], root, attempt.readable.map(path => `--allow-read=${path}`)).exitCode, `${executable} must run before denial is asserted`).toBe(0);
                const result = runStrict(attempt.args, root, attempt.readable.map(path => `--allow-read=${path}`));
                expect(result.exitCode).not.toBe(0);
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
