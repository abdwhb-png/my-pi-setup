import { expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { resolvePiLaunchToolPlan } from "pi-subagents/child-tool-plan";
import { publicExtensionEntrypoint } from "./public-extension-session.ts";

it("passes group members through the native child SDK allowlist", async () => {
    const originalCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const tempDir = await mkdtemp(join(tmpdir(), "pi-subagent-groups-sdk-"));
    try {
        process.env.PI_CODING_AGENT_DIR = tempDir;
        process.chdir(tempDir);
        await writeFile(join(tempDir, "tool-groups.json"), JSON.stringify({ groups: { inspect: ["read", "grep"] } }));
        const configPath = join(tempDir, "addons.json");
        await writeFile(configPath, JSON.stringify({ fallbackAdvice: { enabled: false } }));
        // Pi loads the public entrypoint; this fixture supplies only an isolated config path.
        const addonEntrypoint = join(tempDir, "addons-fixture.ts");
        await writeFile(addonEntrypoint, `import register from ${JSON.stringify(publicExtensionEntrypoint("pi-subagents-addons"))};\nexport default (pi) => register(pi, ${JSON.stringify(configPath)});\n`);

        const settings = SettingsManager.inMemory({});
        const modelRuntime = await ModelRuntime.create({
            credentials: new InMemoryCredentialStore(),
            modelsStore: new InMemoryModelsStore(),
            modelsPath: null,
        });
        const parentLoader = new DefaultResourceLoader({
            cwd: tempDir,
            agentDir: tempDir,
            settingsManager: settings,
            additionalExtensionPaths: [addonEntrypoint, publicExtensionEntrypoint("tool-groups")],
            noExtensions: true,
            noSkills: true,
            noThemes: true,
            noPromptTemplates: true,
            noContextFiles: true,
        });
        await parentLoader.reload();
        const { session: parent } = await createAgentSession({
            cwd: tempDir,
            agentDir: tempDir,
            tools: ["read", "grep"],
            settingsManager: settings,
            sessionManager: SessionManager.inMemory(tempDir),
            modelRuntime,
            resourceLoader: parentLoader,
        });
        try {
            await parent.bindExtensions({ mode: "print" });
            const plan = resolvePiLaunchToolPlan({ tools: ["@inspect"], cwd: tempDir });
            expect(plan.requiredChildTools).toEqual(["read", "grep"]);
            const childLoader = new DefaultResourceLoader({
                cwd: tempDir,
                agentDir: tempDir,
                settingsManager: settings,
                additionalExtensionPaths: [publicExtensionEntrypoint("tool-groups")],
                noExtensions: true,
                noSkills: true,
                noThemes: true,
                noPromptTemplates: true,
                noContextFiles: true,
            });
            await childLoader.reload();
            const { session: child } = await createAgentSession({
                cwd: tempDir,
                agentDir: tempDir,
                tools: plan.effectiveToolAllowlist,
                settingsManager: settings,
                sessionManager: SessionManager.inMemory(tempDir),
                modelRuntime,
                resourceLoader: childLoader,
            });
            try {
                await child.bindExtensions({ mode: "print" });
                expect(child.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "grep"]));
                expect(child.getActiveToolNames()).not.toContain("@inspect");
            } finally {
                child.dispose();
            }
        } finally {
            parent.dispose();
        }
    } finally {
        process.chdir(originalCwd);
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(tempDir, { recursive: true, force: true });
    }
}, 30_000);
