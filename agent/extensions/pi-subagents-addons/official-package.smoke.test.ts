import { calls, createTestSession, says, when } from "@abdwhb-png/pi-test-harness";
import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const officialRoot = realpathSync(dirname(fileURLToPath(import.meta.resolve("pi-subagents"))));
const packageInfo = JSON.parse(readFileSync(join(officialRoot, "package.json"), "utf8"));

// Opt-in: validates the package registered through Pi CLI, not a separately imported source checkout.
test.skipIf(process.env.PI_SUBAGENTS_PR_SMOKE !== "1")("installed upstream PR branch owns the Pi subagent tool", async () => {
    const agentDir = resolve(import.meta.dir, "../..");
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as { packages: string[] };
    const sources = settings.packages.filter(source => source.includes("pi-subagents"));
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatch(/\/pi-subagents-upstream-peer-fix\/dist-pkg$/);
    expect(officialRoot).toBe(realpathSync(resolve(agentDir, sources[0]!)));
    expect(packageInfo.name).toBe("pi-subagents");
    expect(packageInfo.version).toBe("0.71.0");
    expect(existsSync(join(officialRoot, "src/runs/shared/model-fallback-workflow.js"))).toBe(false);
    // Harness cannot load the package root's top-level await through Jiti; load compiled extension directly.
    expect(typeof (await import(join(officialRoot, "index.js"))).default).toBe("function");
    const session = await createTestSession({ extensions: [join(officialRoot, "src/extension/index.js")] });
    try {
        expect(session.session.getAllTools().filter(tool => tool.name === "subagent")).toHaveLength(1);
        await session.run(when("List available Pi agents", [
            calls("subagents_enable", {}),
            calls("subagent", { action: "list", capabilities: true }),
            says("done"),
        ]));
        const result = session.events.toolResultsFor("subagent");
        expect(result).toHaveLength(1);
        expect(result[0]!.isError).toBe(false);
        expect(result[0]!.text).toContain("agent");
    } finally {
        session.dispose();
    }
});
