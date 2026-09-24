import { expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";

const PROVIDER = "fallback-probe";
const FAILED_MODEL = `${PROVIDER}/unavailable`;
const BACKUP_MODEL = `${PROVIDER}/backup`;
const ERROR = "simulated provider outage";

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Needs the installed Pi package and starts an actual local child process; never contacts a provider.
test.skipIf(process.env.PI_SUBAGENTS_PROVIDER_FAILURE_TEST !== "1")(
    "real child provider failure gives parent one request-only fallback hint",
    async () => {
        const root = mkdtempSync(join(realpathSync(tmpdir()), "pi-provider-failure-"));
        const cwd = join(root, "project");
        const agentDir = join(root, "agent");
        const extensionsDir = join(agentDir, "extensions");
        const sessionDir = join(root, "sessions");
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        const previousPeerRoot = process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
        let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
        try {
            mkdirSync(cwd, { recursive: true });
            mkdirSync(extensionsDir, { recursive: true });
            mkdirSync(sessionDir, { recursive: true });
            process.env.PI_CODING_AGENT_DIR = agentDir;
            process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = dirname(
                dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
            );

            const providerPath = join(extensionsDir, "failing-provider.mjs");
            writeFileSync(providerPath, [
                `import { fauxProvider } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/faux"))};`,
                "export default function register(pi) {",
                `  const faux = fauxProvider({ api: "openai-responses", provider: "${PROVIDER}", models: [{ id: "unavailable", reasoning: false }] });`,
                `  faux.setResponses([async () => { throw new Error("${ERROR}"); }]);`,
                "  pi.registerProvider(faux.provider);",
                "}",
            ].join("\n"));
            writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
                subagents: {
                    agentOverrides: {
                        scout: {
                            model: FAILED_MODEL,
                            tools: ["read"],
                            subagentOnlyExtensions: [providerPath],
                        },
                    },
                },
            }));
            const addonConfig = join(root, "addon-config.json");
            writeFileSync(addonConfig, JSON.stringify({
                fallbackAdvice: { enabled: true, fallbackModels: { scout: [BACKUP_MODEL] } },
            }));
            const addonPath = join(extensionsDir, "fallback-addon.mjs");
            const addonEntry = join(import.meta.dir, "..", "..", "pi-subagents-addons", "index.ts");
            writeFileSync(addonPath, [
                `import register from ${JSON.stringify(addonEntry)};`,
                `export default (pi) => register(pi, ${JSON.stringify(addonConfig)});`,
            ].join("\n"));
            const subagentsEntry = join(
                dirname(fileURLToPath(import.meta.resolve("pi-subagents"))),
                "src/extension/index.js",
            );
            const modelRuntime = await ModelRuntime.create({
                authPath: join(agentDir, "auth.json"), modelsPath: null,
            });
            const model = modelRuntime.getModel("openai", "gpt-4o");
            if (!model) throw new Error("Missing built-in parent model");
            const sessionManager = SessionManager.create(cwd, sessionDir);
            sessionManager.appendCustomEntry("provider-failure-fixture", {});
            const parentFile = sessionManager.getSessionFile();
            if (!parentFile) throw new Error("Parent session was not persisted");
            const settingsManager = SettingsManager.inMemory();
            const completions: unknown[] = [];
            const loader = new DefaultResourceLoader({
                cwd,
                agentDir,
                settingsManager,
                additionalExtensionPaths: [subagentsEntry, addonPath],
                extensionFactories: [pi => pi.registerProvider(PROVIDER, {
                    api: "openai-responses",
                    baseUrl: "http://127.0.0.1:1",
                    apiKey: "fixture-only",
                    models: [{
                        id: "unavailable", name: "Expected provider failure", reasoning: false,
                        input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        contextWindow: 16_384, maxTokens: 2_048,
                    }],
                }), pi => pi.events.on("subagent:async-complete", data => completions.push(data))],
            });
            await loader.reload();
            const created = await createAgentSession({
                cwd, agentDir, model, modelRuntime, sessionManager, settingsManager, resourceLoader: loader,
            });
            session = created.session;
            expect(created.extensionsResult.errors).toHaveLength(0);
            const extensionErrors: unknown[] = [];
            await session.bindExtensions({ onError: error => extensionErrors.push(error) });

            const activation = session.agent.state.tools.find(tool => tool.name === "subagents_enable");
            if (!activation) throw new Error("Missing subagents_enable tool");
            await activation.execute("activation", {}, new AbortController().signal);
            const tool = session.agent.state.tools.find(candidate => candidate.name === "subagent");
            if (!tool) throw new Error("Missing activated subagent tool");
            const input = { agent: "scout", task: "Return a short status without tools.", async: true, context: "fresh", mission: false };
            const receipt = await tool.execute("provider-failure", input, new AbortController().signal);
            expect(receipt.content.some(part => part.type === "text" && part.text.includes("Async"))).toBe(true);
            const deadline = Date.now() + 30_000;
            while (completions.length === 0 && Date.now() < deadline) await setTimeout(50);
            const details: unknown = completions[0];
            if (!record(details) || typeof details.runId !== "string" || !Array.isArray(details.results)) {
                throw new Error(`Native async completion missing run evidence: ${JSON.stringify(details)}`);
            }
            expect(details.mode).toBe("single");
            expect(details.sessionId).toBe(parentFile);
            const child: unknown = details.results[0];
            if (!record(child) || typeof child.sessionFile !== "string") {
                throw new Error(`Native child transcript missing: ${JSON.stringify(details)}`);
            }
            expect(child).toMatchObject({
                agent: "scout", requestedModel: FAILED_MODEL, success: false, outputState: "absent",
            });
            expect(child.model).toBe(`${FAILED_MODEL}:${child.thinking}`);
            expect(child.error).toContain(ERROR);
            const childRunId = basename(dirname(dirname(child.sessionFile)));
            expect(childRunId).not.toBe(details.runId);
            expect(child.sessionFile).toBe(join(
                dirname(parentFile), basename(parentFile, ".jsonl"), childRunId, "run-0", "session.jsonl",
            ));
            const transcript = readFileSync(child.sessionFile, "utf8").trimEnd().split("\n");
            expect(transcript.some(line => {
                const entry: unknown = JSON.parse(line);
                return record(entry) && entry.type === "message" && record(entry.message)
                    && entry.message.role === "assistant" && entry.message.provider === PROVIDER
                    && entry.message.model === "unavailable" && entry.message.stopReason === "error"
                    && entry.message.errorMessage === ERROR && Array.isArray(entry.message.content)
                    && entry.message.content.length === 0;
            })).toBe(true);

            const request = { instructions: "parent system prompt", input: [] };
            const first: unknown = await session.extensionRunner!.emitBeforeProviderRequest(request);
            if (!record(first) || typeof first.instructions !== "string") {
                throw new Error("Parent provider request was not available");
            }
            expect(first.instructions).toContain("<pi-subagent-fallback-advice>");
            expect(first.instructions).toContain(BACKUP_MODEL);
            expect(first.instructions).toContain(FAILED_MODEL);
            expect(await session.extensionRunner!.emitBeforeProviderRequest(request)).toEqual(request);
            expect(readFileSync(parentFile, "utf8")).not.toContain("<pi-subagent-fallback-advice>");
            expect(JSON.stringify(sessionManager.getBranch())).not.toContain("<pi-subagent-fallback-advice>");
            expect(extensionErrors).toHaveLength(0);
        } finally {
            try {
                session?.dispose();
            } finally {
                if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
                else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
                if (previousPeerRoot === undefined) delete process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
                else process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = previousPeerRoot;
                rmSync(root, { recursive: true, force: true });
            }
        }
    },
    45_000,
);
