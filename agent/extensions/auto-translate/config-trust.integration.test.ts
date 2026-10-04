import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createTestSession } from "@abdwhb-png/pi-test-harness";
import translateExtension from "./index.ts";

test("commands match project languages when saved trust is granted after factory loading", async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    const root = mkdtempSync(join(tmpdir(), "translate-trust-"));
    try {
        const agentDir = join(root, "agent"), cwd = join(root, "project");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        mkdirSync(agentDir);
        mkdirSync(join(cwd, ".pi/config"), { recursive: true });
        writeFileSync(join(cwd, ".pi/config/translate.json"), JSON.stringify({ languages: { fr: "French" }, defaultTargetLanguage: "fr" }));
        const session = await createTestSession({ cwd, extensionFactories: [translateExtension] });
        try {
            const runner = session.session.extensionRunner!;
            expect(runner.getCommand("translate-to-fr")).toBeUndefined();
            new ProjectTrustStore(agentDir).set(cwd, true);
            await runner.emit({ type: "session_start", reason: "startup" });
            expect(runner.getCommand("translate-to-fr")).toBeDefined();
            await session.session.prompt("/translate-to-fr");
            expect(session.events.uiCallsFor("notify").at(-1)?.args[0]).toContain("French");
        } finally { session.dispose(); }
    } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(root, { recursive: true, force: true });
    }
});
