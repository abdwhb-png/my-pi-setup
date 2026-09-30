import { expect, test } from "bun:test";
import { createTestSession, type TestSession } from "@abdwhb-png/pi-test-harness";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashOperations } from "../../_shared/command-execution/exec.ts";
import { registerSafeBash } from "./index.ts";

test("/safe-bash status reports rejected guard policies from loaded settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "safe-bash-policy-notes-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    let session: TestSession | undefined;
    try {
        const agentDir = join(root, "agent");
        const cwd = join(root, "project");
        await mkdir(agentDir);
        await mkdir(cwd);
        await writeFile(
            join(agentDir, "settings.json"),
            JSON.stringify({
                safeBash: {
                    guardPolicy: { sudo: "cwd-only" },
                    telemetry: { directory: join(root, "telemetry") },
                },
            }),
        );
        process.env.PI_CODING_AGENT_DIR = agentDir;
        session = await createTestSession({
            cwd,
            extensionFactories: [
                (pi) => registerSafeBash(pi, { createOperations: createBashOperations }),
            ],
        });

        await session.session.prompt("/safe-bash reload");
        await session.session.prompt("/safe-bash status");

        expect(session.events.uiCallsFor("notify").at(-1)?.args[0]).toContain(
            "Ignored guardPolicy: guardPolicy.sudo: cwd-only needs a path target",
        );
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        session?.dispose();
        await rm(root, { recursive: true, force: true });
    }
});
