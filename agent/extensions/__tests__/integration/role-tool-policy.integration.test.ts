import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

import { ROLE_TOOL_POLICY_EVENT } from "../../_shared/pi-roles/index.ts";
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
    writeRole(cwd, "debug", "read, switch_role");
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
                    roleName === "debug" ? ["read", "switch_role"] : [],
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
