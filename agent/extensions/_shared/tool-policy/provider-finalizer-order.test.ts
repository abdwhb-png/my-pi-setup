import { expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import {
    DefaultPackageManager,
    SettingsManager,
    getAgentDir,
} from "@earendil-works/pi-coding-agent";

test("the installed package resolver loads the provider finalizer owner last", async () => {
    const agentDir = getAgentDir();
    const cwd = dirname(agentDir);
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const packageManager = new DefaultPackageManager({
        cwd,
        agentDir,
        settingsManager,
    });
    const resolvedPaths = await packageManager.resolve();
    const enabled = resolvedPaths.extensions.filter((entry) => entry.enabled);
    expect(resolve(enabled.at(-1)?.path ?? "")).toBe(
        join(agentDir, "extensions", "tool-groups", "index.ts"),
    );
});
