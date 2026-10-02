import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    calls,
    createTestSession,
    says,
    when,
} from "@abdwhb-png/pi-test-harness";
import {
    createEditTool,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import {
    ROLE_TOOL_POLICY_EVENT,
    writeRoleSwitchRequest,
} from "../../_shared/pi-roles/index.ts";
import { publicExtensionEntrypoint } from "./public-extension-session.ts";

function writeRole(cwd: string, name: string, tools?: string): void {
    const roles = join(cwd, ".pi", "roles");
    mkdirSync(roles, { recursive: true });
    writeFileSync(
        join(roles, `${name}.md`),
        [
            "---",
            `name: ${name}`,
            `description: ${name} fixture`,
            ...(tools ? [`tools: ${tools}`] : []),
            "---",
            `# ${name}`,
        ].join("\n"),
    );
}

test.each([
    "herdr-role-owner",
    "owner-herdr-role",
    "role-owner-herdr",
] as const)("debug -> unrestricted pi-agent preserves edit: %s", async (order) => {
    const cwd = mkdtempSync(join(tmpdir(), "role-policy-runtime-"));
    const previousEnv = process.env.HERDR_ENV;
    const previousPane = process.env.HERDR_PANE_ID;
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "fixture";
    writeRole(cwd, "debug", "read");
    writeRole(cwd, "pi-agent");
    writeFileSync(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify({
            "pi-roles": {
                defaultRole: "pi-agent",
                roleScope: "project",
                showWidget: false,
            },
        }),
    );
    const transitionFixture = (pi: ExtensionAPI) => {
        pi.registerTool({
            ...createEditTool(cwd),
            execute: async () => ({
                content: [{ type: "text" as const, text: "edit executed" }],
                details: {},
            }),
        });
        pi.on("before_agent_start", (event) => {
            const roleName = event.prompt === "debug" ? "debug" : "pi-agent";
            pi.events.emit(ROLE_TOOL_POLICY_EVENT, {
                version: 1,
                roleName,
                mode: roleName === "debug" ? "set" : "all",
                toolNames:
                    roleName === "debug" ? ["read"] : [],
            });
        });
    };
    const paths = {
        herdr: publicExtensionEntrypoint("pi-herdr"),
        role: publicExtensionEntrypoint("pi-roles"),
        owner: publicExtensionEntrypoint("tool-groups"),
    };
    const orders = {
        "herdr-role-owner": [paths.herdr, paths.role, paths.owner],
        "owner-herdr-role": [paths.owner, paths.herdr, paths.role],
        "role-owner-herdr": [paths.role, paths.owner, paths.herdr],
    };
    const session = await createTestSession({
        cwd,
        systemPrompt: "Custom SYSTEM.md",
        propagateErrors: false,
        extensions: orders[order],
        extensionFactories: [transitionFixture],
    });
    try {
        await session.run(when("debug", [says("diagnosed")]));
        expect(session.session.getActiveToolNames()).not.toContain("edit");

        await session.run(
            when("apply", [
                calls("edit", {
                    path: "fixture",
                    oldText: "a",
                    newText: "b",
                }),
                says("done"),
            ]),
        );
        expect(
            session.events.toolResultsFor("edit").map((result) => ({
                error: result.isError,
                text: result.text,
            })),
        ).toEqual([{ error: false, text: "edit executed" }]);
    } finally {
        await session.session.extensionRunner?.emit({
            type: "session_shutdown",
            reason: "quit",
        });
        session.dispose();
        rmSync(cwd, { recursive: true, force: true });
        if (previousEnv === undefined) delete process.env.HERDR_ENV;
        else process.env.HERDR_ENV = previousEnv;
        if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
        else process.env.HERDR_PANE_ID = previousPane;
    }
});

test.each(["default", "custom"] as const)(
    "the first commiter -> quick-planner prompt can save a plan with a %s system prompt",
    async (promptMode) => {
        const environmentKeys = [
            "PI_CODING_AGENT_DIR",
            "PI_ROLE",
            "PI_TOOL_GROUPS_REQUESTED_TOOLS",
            "PI_SUBAGENT_EXTENSION_BINDINGS",
        ];
        const previousEnvironment = environmentKeys.map(
            (name) => [name, process.env[name]] as const,
        );
        const requestedKey = Symbol.for("pi.tool-policy.cli-requested.v1");
        const previousRequested = Object.getOwnPropertyDescriptor(globalThis, requestedKey);
        const cwd = mkdtempSync(join(tmpdir(), "role-plan-loadout-"));
        let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
        try {
            process.env.PI_CODING_AGENT_DIR = cwd;
            process.env.PI_ROLE = "commiter";
            delete process.env.PI_TOOL_GROUPS_REQUESTED_TOOLS;
            delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
            Reflect.deleteProperty(globalThis, requestedKey);
            writeRole(cwd, "commiter", "read, write");
            writeRole(cwd, "quick-planner", "read, session_plan, fixture_loader");
            writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
                "pi-roles": {
                    defaultRole: "commiter",
                    roleScope: "project",
                    showWidget: false,
                },
            }));
            const precedingExtension = join(cwd, "activation.ts");
            // Reproduce an external hook editing the snapshot, not the live role policy.
            writeFileSync(precedingExtension, `
import { Type } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@sinclair/typebox")))};
export default function (pi) {
    pi.registerTool({
        name: "fixture_loader", label: "Fixture loader", description: "Diagnostic loader",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "enabled" }], details: {} }),
    });
    pi.on("before_agent_start", (event) => {
        event.systemPromptOptions.selectedTools.push("fixture_loader");
    });
}
`);
            let extensionApi: ExtensionAPI | undefined;
            session = await createTestSession({
                cwd,
                ...(promptMode === "custom" ? { systemPrompt: "Custom SYSTEM.md fixture" } : {}),
                propagateErrors: false,
                extensions: [
                    precedingExtension,
                    publicExtensionEntrypoint("pi-roles"),
                    publicExtensionEntrypoint("plan-workflow"),
                    publicExtensionEntrypoint("tool-groups"),
                ],
                extensionFactories: [(pi: ExtensionAPI) => { extensionApi = pi; }],
            });
            const agent = session.session.agent;
            const originalPrepareRequest = agent.prepareRequest;
            const requestTools: string[][] = [];
            agent.prepareRequest = async (request, signal) => {
                const update = await originalPrepareRequest?.call(agent, request, signal);
                requestTools.push((update?.context ?? request.context).tools?.map(tool => tool.name) ?? []);
                return update || undefined;
            };
            expect(session.session.getActiveToolNames()).toEqual(["read", "write"]);
            expect(extensionApi).toBeDefined();
            writeRoleSwitchRequest(extensionApi!, {
                targetRole: "quick-planner",
                reason: "prompt:plan-quickly",
            });
            const content = "# Diagnostic plan\nSave the plan before implementation.";
            await session.run(when("Plan this change", [
                calls("session_plan", { action: "save", topic: "diagnostic", content }),
                calls("session_plan", { action: "read", topic: "diagnostic" }),
                says("Plan saved"),
            ]));
            const results = session.events.toolResultsFor("session_plan");
            expect(results.map(result => ({ error: result.isError, text: result.isError ? result.text : undefined })))
                .toEqual([{ error: false, text: undefined }, { error: false, text: undefined }]);
            expect(results[0].details).toMatchObject({ action: "save", topic: "diagnostic", version: 1, exists: true });
            expect(results[1].text).toContain(content);
            expect(requestTools.length).toBeGreaterThan(0);
            for (const names of requestTools) expect(names).toEqual(["read", "session_plan", "fixture_loader"]);
        } finally {
            try {
                await session?.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
            } finally {
                session?.dispose();
                for (const [name, value] of previousEnvironment) {
                    if (value === undefined) delete process.env[name];
                    else process.env[name] = value;
                }
                if (previousRequested) Object.defineProperty(globalThis, requestedKey, previousRequested);
                else Reflect.deleteProperty(globalThis, requestedKey);
                rmSync(cwd, { recursive: true, force: true });
            }
        }
    },
    20000,
);
