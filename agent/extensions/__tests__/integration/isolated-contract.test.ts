import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIsolatedContract } from "./isolated-contract.ts";

test.skipIf(process.platform !== "linux")(
    "a child deadline preserves parent cwd and environment and stops detached owned descendants",
    async () => {
        const cwd = process.cwd();
        const agentDir = process.env.PI_CODING_AGENT_DIR;
        const home = process.env.HOME;
        const root = await mkdtemp(join(tmpdir(), "pi-contract-"));
        try {
            await expect(
                runIsolatedContract(
                    [
                        "-e",
                        `
            const {spawn} = require('node:child_process');
            process.chdir(process.env.HOME);
            process.env.PI_CODING_AGENT_DIR = 'child-only';
            const child = spawn('/bin/sleep', ['30'], {stdio:'ignore', detached: true});
            require('node:fs').writeFileSync('pid', String(child.pid));
            console.error('phase: stalled-fixture');
            setInterval(() => {}, 1000);
        `,
                    ],
                    {
                        cwd,
                        env: { ...process.env, HOME: root },
                        timeoutMs: 1_000,
                    },
                ),
            ).rejects.toThrow("phase: stalled-fixture");
            expect(process.cwd()).toBe(cwd);
            expect(process.env.HOME).toBe(home);
            expect(process.env.PI_CODING_AGENT_DIR).toBe(agentDir);
            const pid = Number(await readFile(join(root, "pid"), "utf8"));
            // A terminated child may briefly remain as a reparented zombie in Linux.
            let state: string | undefined;
            try {
                state = (await readFile(`/proc/${pid}/stat`, "utf8")).split(
                    ") ",
                )[1]?.[0];
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                    throw error;
            }
            expect(state === undefined || state === "Z").toBe(true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);
