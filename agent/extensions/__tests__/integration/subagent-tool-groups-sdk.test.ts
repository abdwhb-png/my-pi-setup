import { expect, it } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxToolCall,
    InMemoryCredentialStore,
    InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { resolveSubagentLaunchContract } from "pi-subagents/preflight";
import { publicExtensionEntrypoint } from "./public-extension-session.ts";

it("generated snapshot reaches the SDK allowlist and enforces native tool calls", async () => {
    const originalCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const tempDir = await mkdtemp(join(tmpdir(), "pi-subagent-groups-sdk-"));
    try {
        process.env.PI_CODING_AGENT_DIR = tempDir;
        process.chdir(tempDir);
        await writeFile(
            join(tempDir, "tool-groups.json"),
            JSON.stringify({ groups: { inspect: ["read", "grep"] } }),
        );
        await mkdir(join(tempDir, "agents"));
        // Mark the fixture root; /tmp may itself expose an ancestor .agents directory.
        await mkdir(join(tempDir, ".pi"));
        const markdown =
            "---\nname: reader\ndescription: SDK fixture\ntools: '@inspect'\nexcludeTools: grep\n---\nRead fixture only.\n";
        const agentPath = join(tempDir, "agents", "reader.md");
        await writeFile(agentPath, markdown);
        await writeFile(join(tempDir, "fixture.txt"), "sdk-read-proof");
        const configPath = join(tempDir, "addons.json");
        await writeFile(
            configPath,
            JSON.stringify({
                toolGroupOverrides: {
                    enabled: true,
                    userAgentDirs: ["agents"],
                    projectAgentDirs: [],
                    agentTools: {},
                },
            }),
        );
        // Pi loads the public entrypoint; this fixture supplies only an isolated config path.
        const addonEntrypoint = join(tempDir, "addons-fixture.ts");
        await writeFile(
            addonEntrypoint,
            `import register from ${JSON.stringify(publicExtensionEntrypoint("pi-subagents-addons"))};\nexport default (pi) => register(pi, ${JSON.stringify(configPath)});\n`,
        );

        const settings = SettingsManager.inMemory({});
        const modelRuntime = await ModelRuntime.create({
            credentials: new InMemoryCredentialStore(),
            modelsStore: new InMemoryModelsStore(),
            modelsPath: null,
        });
        const faux = fauxProvider({ provider: "fixture-sdk" });
        modelRuntime.registerNativeProvider(faux.provider);
        const parentLoader = new DefaultResourceLoader({
            cwd: tempDir,
            agentDir: tempDir,
            settingsManager: settings,
            additionalExtensionPaths: [addonEntrypoint],
            noExtensions: true,
            noSkills: true,
            noThemes: true,
            noPromptTemplates: true,
            noContextFiles: true,
        });
        await parentLoader.reload();
        expect(parentLoader.getExtensions().errors).toEqual([]);
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
            const startupErrors: string[] = [];
            await parent.bindExtensions({
                mode: "print",
                onError: (error) => startupErrors.push(error.error),
                uiContext: {
                    ...parent.extensionRunner.getUIContext(),
                    notify(message, type) {
                        if (type === "error") startupErrors.push(message);
                    },
                },
            });
            expect(startupErrors).toEqual([]);
            const generated = JSON.parse(
                await readFile(join(tempDir, "settings.json"), "utf8"),
            );
            expect(generated.subagents.agentOverrides.reader.tools).toEqual([
                "read",
                "grep",
            ]);
            const result = await resolveSubagentLaunchContract({
                agent: "reader",
                cwd: tempDir,
                context: "fresh",
                skill: false,
                intercomBridge: { mode: "off" },
            });
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error(result.message);
            const plan = result.contract.tools;
            expect(plan.requestedBuiltin).toEqual(["read", "grep"]);
            expect(plan.effectiveAllowlist).toContain("read");
            expect(plan.effectiveAllowlist).not.toContain("grep");
            expect(plan.effectiveAllowlist).not.toContain("@inspect");
            expect(await readFile(agentPath, "utf8")).toBe(markdown);
            const childLoader = new DefaultResourceLoader({
                cwd: tempDir,
                agentDir: tempDir,
                settingsManager: settings,
                additionalExtensionPaths: [],
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
                tools: plan.effectiveAllowlist,
                model: faux.getModel(),
                settingsManager: settings,
                sessionManager: SessionManager.inMemory(tempDir),
                modelRuntime,
                resourceLoader: childLoader,
            });
            try {
                await child.bindExtensions({ mode: "print" });
                expect(child.getActiveToolNames()).toContain("read");
                expect(child.getActiveToolNames()).not.toContain("grep");
                expect(child.getActiveToolNames()).not.toContain("write");
                const results: Array<{
                    toolName: string;
                    isError: boolean;
                    result: unknown;
                }> = [];
                const unsubscribe = child.subscribe((event) => {
                    if (event.type === "tool_execution_end")
                        results.push(event);
                });
                try {
                    faux.setResponses([
                        fauxAssistantMessage(
                            fauxToolCall("read", { path: "fixture.txt" }),
                        ),
                        fauxAssistantMessage(
                            fauxToolCall("write", {
                                path: "forbidden.txt",
                                content: "must not write",
                            }),
                        ),
                        fauxAssistantMessage("sdk-complete"),
                    ]);
                    await child.prompt(
                        "Exercise allowed read and forbidden write",
                    );
                    expect(
                        results.map((entry) => [entry.toolName, entry.isError]),
                    ).toEqual([
                        ["read", false],
                        ["write", true],
                    ]);
                    expect(JSON.stringify(results[0]?.result)).toContain(
                        "sdk-read-proof",
                    );
                    expect(JSON.stringify(results[1]?.result)).toContain(
                        "not found",
                    );
                    await rejects(readFile(join(tempDir, "forbidden.txt")), {
                        code: "ENOENT",
                    });
                } finally {
                    unsubscribe();
                }
            } finally {
                child.dispose();
            }
        } finally {
            parent.dispose();
        }
    } finally {
        process.chdir(originalCwd);
        if (previousAgentDir === undefined)
            delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(tempDir, { recursive: true, force: true });
    }
}, 30_000);
