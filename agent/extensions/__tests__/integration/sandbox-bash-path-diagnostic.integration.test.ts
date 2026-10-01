import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { runIsolatedContract } from "./isolated-contract.ts";

test.skipIf(
    process.platform !== "linux" ||
        process.env.PI_SANDBOX_PATH_DIAGNOSTIC_CONTRACT !== "1",
)(
    "Sandbox and Bash diagnose an unexposed sibling using an isolated pinned runtime",
    async () => {
        for (const key of [
            "PI_SANDBOX_ZEROBOX_BINARY",
            "PI_SANDBOX_RUNTIME_BUNDLE",
        ]) {
            const value = process.env[key];
            if (!value || !isAbsolute(value))
                throw new Error(`${key} must pin an absolute candidate path`);
        }
        if (!/^[a-f0-9]{64}$/.test(process.env.PI_SANDBOX_ZEROBOX_SHA256 ?? ""))
            throw new Error(
                "PI_SANDBOX_ZEROBOX_SHA256 must pin the candidate bytes",
            );
        // Zerobox's private socket paths must stay below Linux's AF_UNIX limit.
        const home = await mkdtemp("/tmp/");
        const root = await mkdtemp("/var/tmp/pi-path-");
        const cwd = process.cwd();
        const agentDir = process.env.PI_CODING_AGENT_DIR;
        try {
            const output = await runIsolatedContract(
                [
                    "test",
                    "--isolate",
                    join(
                        import.meta.dir,
                        "fixtures/sandbox-bash-path-diagnostic.contract.test.ts",
                    ),
                ],
                {
                    cwd: resolve(import.meta.dir, "../../.."),
                    timeoutMs: 45_000,
                    env: {
                        ...process.env,
                        HOME: home,
                        PI_CODING_AGENT_DIR: root,
                        PI_SANDBOX_PATH_DIAGNOSTIC_CHILD: "1",
                        PI_SANDBOX_PATH_DIAGNOSTIC_ROOT: root,
                        XDG_CONFIG_HOME: join(home, "config"),
                        XDG_CACHE_HOME: join(home, "cache"),
                        XDG_STATE_HOME: join(home, "state"),
                        TMPDIR: join(home, "tmp"),
                    },
                },
            );
            console.error(
                output
                    .split("\n")
                    .filter((line) => line.startsWith("[sandbox-path]"))
                    .join("\n"),
            );
            expect(output).toContain("[sandbox-path] complete");
            expect(process.cwd()).toBe(cwd);
            expect(process.env.PI_CODING_AGENT_DIR).toBe(agentDir);
        } finally {
            await rm(root, { recursive: true, force: true });
            await rm(home, { recursive: true, force: true });
        }
    },
    50_000,
);
