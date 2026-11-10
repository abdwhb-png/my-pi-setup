import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stream } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { useIsolatedAgentDir } from "../../_shared/testing/config-fixture.ts";
import { publicExtensionEntrypoint } from "./public-extension-session.ts";

const agentDir = useIsolatedAgentDir();

test("real Pi hooks retain observations on disk across reload and branch changes without model-context entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "catalog-audit-"));
    let session:
        | Awaited<ReturnType<typeof createAgentSession>>["session"]
        | undefined;
    try {
        const modelRuntime = await ModelRuntime.create({
            authPath: join(root, "auth.json"),
            modelsPath: null,
        });
        const model = modelRuntime.getModel("openai", "gpt-4o");
        if (!model) throw new Error("Missing fixture model");
        let manager = SessionManager.create(root, root);
        manager.appendMessage({
            role: "user",
            content: "offline fixture",
            timestamp: 1,
        });
        const roleA = manager.appendCustomEntry("pi-roles:active-role", {
            name: "role-a",
            source: "project",
            path: "fixture",
            appliedAt: 1,
        });
        const open = async () => {
            const settingsManager = SettingsManager.inMemory();
            const loader = new DefaultResourceLoader({
                cwd: root,
                agentDir: agentDir(),
                settingsManager,
                additionalExtensionPaths: [
                    publicExtensionEntrypoint("tool-groups"),
                ],
            });
            await loader.reload();
            return (
                await createAgentSession({
                    cwd: root,
                    agentDir: agentDir(),
                    modelRuntime,
                    model,
                    sessionManager: manager,
                    settingsManager,
                    resourceLoader: loader,
                })
            ).session;
        };
        session = await open();
        const runner = session.extensionRunner;
        if (!runner) throw new Error("Missing runner");
        let transported = false;
        await stream(
            model,
            normalizeContext({
                systemPrompt: "private prompt",
                messages: [
                    { role: "user", content: "private argument", timestamp: 1 },
                ],
                tools: [
                    {
                        name: "read",
                        description: "private description",
                        parameters: Type.Object({}),
                    },
                ],
            }),
            {
                apiKey: "fixture-not-a-secret",
                maxRetries: 0,
                onPayload: (payload) =>
                    runner.emitBeforeProviderRequest(payload),
                fetch: Object.assign(
                    async () => {
                        transported = true;
                        return new Response("offline fixture stop", {
                            status: 400,
                        });
                    },
                    { preconnect() {} },
                ),
            },
        ).result();
        expect(transported).toBe(true);
        const file = manager.getSessionFile();
        if (!file) throw new Error("Missing session file");
        const auditEntries = () =>
            manager
                .getEntries()
                .filter(
                    (e) =>
                        e.type === "custom" &&
                        e.customType === "tool-policy:provider-request",
                );
        expect(auditEntries()).toHaveLength(1);
        expect(auditEntries()[0]).toMatchObject({
            data: {
                roleName: "role-a",
                provider: "openai",
                observation: { tools: [{ name: "read", deferred: false }] },
            },
        });
        const storedAudit = readFileSync(file, "utf8")
            .split("\n")
            .filter((line) =>
                line.includes('"customType":"tool-policy:provider-request"'),
            )
            .join("\n");
        expect(storedAudit).not.toContain("private");
        expect(
            JSON.stringify(manager.buildSessionContext().messages),
        ).not.toContain("tool-policy:provider-request");
        await session.extensionRunner?.emit({
            type: "session_shutdown",
            reason: "quit",
        });
        session.dispose();
        session = undefined;
        manager = SessionManager.open(file);
        expect(auditEntries()).toHaveLength(1);
        manager.appendCustomEntry("pi-roles:active-role", {
            name: "role-b",
            source: "project",
            path: "fixture",
            appliedAt: 2,
        });
        session = await open();
        const observe = () =>
            session!.extensionRunner!.emitBeforeProviderRequest({
                input: [],
                instructions: "fixture",
                tools: [],
                tool_choice: "none",
            });
        await observe();
        expect(auditEntries().at(-1)).toMatchObject({
            data: {
                roleName: "role-b",
                observation: { callableToolNames: [] },
            },
        });
        manager.branch(roleA);
        await observe();
        expect(manager.getBranch().at(-1)).toMatchObject({
            customType: "tool-policy:provider-request",
            data: { roleName: "role-a" },
        });
        expect(auditEntries()).toHaveLength(3);
    } finally {
        await session?.extensionRunner?.emit({
            type: "session_shutdown",
            reason: "quit",
        });
        session?.dispose();
        rmSync(root, { recursive: true, force: true });
    }
}, 20000);
