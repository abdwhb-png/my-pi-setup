import { afterEach, expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    calls,
    createTestSession,
    says,
    when,
    type TestSession,
} from "@abdwhb-png/pi-test-harness";
import { publicExtensionEntrypoints } from "./public-extension-session.ts";

const sessions: TestSession[] = [];
const dirs: string[] = [];
const originalEnv = {
    PATH: process.env.PATH,
    PI_ROLE: process.env.PI_ROLE,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};
afterEach(async () => {
    for (const session of sessions.splice(0)) {
        await session.session.extensionRunner?.emit({
            type: "session_shutdown",
            reason: "quit",
        });
        session.dispose();
    }
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    for (const dir of dirs.splice(0))
        rmSync(dir, { recursive: true, force: true });
});
async function fixture(
    role = "plan",
    cli = "console.log(JSON.stringify({decision:'annotated',feedback:'Review notes'})); process.exit(1);",
    target = "implement",
) {
    const cwd = mkdtempSync(join(tmpdir(), "plans-cli-integration-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, ".pi/roles"), { recursive: true });
    mkdirSync(join(cwd, "pi-plans"));
    mkdirSync(join(cwd, "bin"));
    writeFileSync(
        join(cwd, "bin/plannotator"),
        `#!${process.execPath}\n${cli}`,
        { mode: 0o700 },
    );
    writeFileSync(join(cwd, "pi-plans/test.md"), "# Plan\nInitial");
    for (const name of ["plan", "implement", "other"])
        writeFileSync(
            join(cwd, ".pi/roles", `${name}.md`),
            `---\nname: ${name}\ndescription: Fixture\ntools: read, write_plan, edit_plan, submit_plan\n${name === "plan" ? "handoffGuard: plan-submission\n" : ""}---\nFixture ${name}`,
        );
    writeFileSync(
        join(cwd, "settings.json"),
        JSON.stringify({
            plans: { planFileDir: "pi-plans" },
            "pi-roles": {
                defaultRole: "other",
                planApprovedRole: target,
                roleScope: "project",
                showWidget: false,
            },
        }),
    );
    process.env.PI_CODING_AGENT_DIR = cwd;
    process.env.PI_ROLE = role;
    process.env.PATH = `${join(cwd, "bin")}:${originalEnv.PATH}`;
    const session = await createTestSession({
        cwd,
        extensions: publicExtensionEntrypoints(
            "plan-workflow",
            "pi-roles",
            "tool-groups",
        ),
    });
    sessions.push(session);
    return { session, cwd };
}
function entries(session: TestSession, type: string) {
    return session.session.sessionManager
        .getEntries()
        .filter((e) => e.type === "custom" && e.customType === type);
}
async function waitFor(session: TestSession, type: string) {
    for (let i = 0; i < 200; i++) {
        if (entries(session, type).length) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Missing ${type}`);
}
test("submit_plan approval terminates planning and switches once to the explicit role, not defaultRole", async () => {
    const { session } = await fixture(
        "plan",
        "console.log(JSON.stringify({decision:'approved'}));",
    );
    await session.run(
        when("Approve", [
            calls("write_plan", {
                path: "test.md",
                content: "# Approved plan",
            }),
            calls("submit_plan", { filePath: "pi-plans/test.md" }),
        ]),
    );
    await waitFor(session, "pi-roles:switch-processed");
    expect(entries(session, "plans:approved")).toHaveLength(1);
    expect(entries(session, "pi-roles:switch-request")).toMatchObject([
        { data: { targetRole: "implement", reason: "plans:approved" } },
    ]);
    expect(entries(session, "pi-roles:active-role").at(-1)).toMatchObject({
        data: { name: "implement" },
    });
    expect(session.session.getActiveToolNames()).not.toContain("submit_plan");
    expect(session.session.getAllTools().map((tool) => tool.name)).not.toContain("plan_submit");
    await session.session.extensionRunner!.emit({
        type: "agent_end",
        messages: [],
    });
    expect(entries(session, "pi-roles:switch-request")).toHaveLength(1);
});
test("missing implementation target leaves the planning role and records terminal failure", async () => {
    const { session } = await fixture(
        "plan",
        "console.log(JSON.stringify({decision:'approved'}));",
        "missing-role",
    );
    await session.run(
        when("Approve", [
            calls("write_plan", { path: "test.md", content: "# Plan" }),
            calls("submit_plan", { filePath: "pi-plans/test.md" }),
        ]),
    );
    await waitFor(session, "pi-roles:switch-failed");
    expect(entries(session, "pi-roles:active-role").at(-1)).toMatchObject({
        data: { name: "plan" },
    });
    expect(entries(session, "pi-roles:switch-processed")).toHaveLength(0);
    await session.session.extensionRunner!.emit({
        type: "agent_end",
        messages: [],
    });
    expect(entries(session, "pi-roles:switch-request")).toHaveLength(1);
    expect(JSON.stringify(session.events.uiCallsFor("notify"))).toContain(
        "missing-role",
    );
});

test("a second pending plan prevents approval from bypassing the revision guard", async () => {
    const { session } = await fixture(
        "plan",
        "console.log(JSON.stringify({decision:'approved'}));",
    );
    await session.run(
        when("Approve one of two", [
            calls("write_plan", { path: "test.md", content: "# First" }),
            calls("write_plan", {
                path: "pending.md",
                content: "# Still a draft",
            }),
            calls("submit_plan", { filePath: "pi-plans/test.md" }),
        ]),
    );
    await waitFor(session, "pi-roles:switch-failed");
    expect(entries(session, "pi-roles:active-role").at(-1)).toMatchObject({
        data: { name: "plan" },
    });
    expect(entries(session, "pi-roles:switch-processed")).toHaveLength(0);
});

test("a target deleted during review is re-resolved before handoff", async () => {
    const { session } = await fixture(
        "plan",
        "require('node:fs').unlinkSync('.pi/roles/implement.md'); console.log(JSON.stringify({decision:'approved'}));",
    );
    await session.run(
        when("Approve", [
            calls("write_plan", { path: "test.md", content: "# Plan" }),
            calls("submit_plan", { filePath: "pi-plans/test.md" }),
        ]),
    );
    await waitFor(session, "pi-roles:switch-failed");
    expect(entries(session, "pi-roles:active-role").at(-1)).toMatchObject({
        data: { name: "plan" },
    });
});
test("guarded role exposes submit_plan; annotation does not approve or switch", async () => {
    const { session } = await fixture();
    expect(session.session.getActiveToolNames()).toContain("submit_plan");
    await session.run(
        when("Review", [
            calls("write_plan", {
                path: "test.md",
                content: "# Plan\nRevision",
            }),
            calls("submit_plan", { filePath: "pi-plans/test.md" }),
            says("Awaiting revision"),
        ]),
    );
    expect(session.events.toolResultsFor("submit_plan")[0]).toMatchObject({
        isError: false,
        details: { approved: false, decision: "annotated" },
    });
    expect(entries(session, "plans:approved")).toHaveLength(0);
    expect(entries(session, "pi-roles:switch-request")).toHaveLength(0);
});
test("unguarded role hides submit_plan and blocks forced calls", async () => {
    const { session } = await fixture("other");
    expect(session.session.getActiveToolNames()).not.toContain("submit_plan");
    const blocked = await session.session.extensionRunner!.emitToolCall({
        type: "tool_call",
        toolName: "submit_plan",
        toolCallId: "forced",
        input: { filePath: "pi-plans/test.md" },
    });
    expect(blocked?.block).toBe(true);
});
test.each(["", "Existing draft"])(
    "manual file review preserves draft %s without sending",
    async (initial) => {
        const { session, cwd } = await fixture(
            "other",
            "console.log(JSON.stringify({decision:'annotated',feedback:'Review notes'}));",
        );
        const runner = session.session.extensionRunner!;
        let draft: string = initial;
        runner.setUIContext(
            {
                ...runner.getUIContext(),
                getEditorText: () => draft,
                setEditorText: (value) => {
                    draft = value;
                },
            },
            "tui",
        );
        const before = session.session.messages.length;
        expect(runner.getCommand("review-file")).toBeDefined();
        await session.session.prompt(
            `/review-file ${join(cwd, "pi-plans/test.md")}`,
        );
        expect(draft).toBe(initial || "Review notes");
        expect(session.session.messages).toHaveLength(before);
        expect(entries(session, "pi-roles:switch-request")).toHaveLength(0);
    },
);
test("code review uses native message without granting approval", async () => {
    const { session } = await fixture(
        "other",
        "console.log(JSON.stringify({decision:'approved',message:'Code review notes'}));",
    );
    const runner = session.session.extensionRunner!;
    let draft = "";
    runner.setUIContext(
        {
            ...runner.getUIContext(),
            getEditorText: () => draft,
            setEditorText: (value) => {
                draft = value;
            },
        },
        "tui",
    );
    await session.session.prompt("/review-code");
    expect(draft).toBe("Code review notes");
    expect(entries(session, "plans:approved")).toHaveLength(0);
});
test("changed file cannot be approved", async () => {
    const { session } = await fixture(
        "plan",
        "require('node:fs').appendFileSync(process.argv[3], '\\nChanged'); console.log('{\"decision\":\"approved\"}');",
    );
    await session.run(
        when("Review", [
            calls("submit_plan", { filePath: "pi-plans/test.md" }),
            says("Needs fresh review"),
        ]),
    );
    expect(session.events.toolResultsFor("submit_plan")[0]).toMatchObject({
        isError: true,
    });
    expect(session.events.toolResultsFor("submit_plan")[0].text).toContain(
        "changed during review",
    );
    expect(entries(session, "plans:approved")).toHaveLength(0);
});
test("a symlink escaping the plan directory cannot be submitted", async () => {
    const { session, cwd } = await fixture();
    writeFileSync(join(cwd, "outside.md"), "# Outside");
    symlinkSync(join(cwd, "outside.md"), join(cwd, "pi-plans/escape.md"));
    await session.run(
        when("Review", [
            calls("submit_plan", { filePath: "pi-plans/escape.md" }),
            says("Rejected"),
        ]),
    );
    expect(session.events.toolResultsFor("submit_plan")[0]).toMatchObject({
        isError: true,
    });
    expect(session.events.toolResultsFor("submit_plan")[0].text).toContain(
        "symlink",
    );
    expect(entries(session, "plans:approved")).toHaveLength(0);
});
test("shutdown cancels the open review; concurrent commands cannot replace it or deliver stale feedback", async () => {
    const { session, cwd } = await fixture(
        "other",
        "require('node:fs').writeFileSync('started', '1'); setTimeout(() => console.log('{\"decision\":\"annotated\",\"feedback\":\"Stale\"}'), 3000);",
    );
    const runner = session.session.extensionRunner!;
    let draft = "";
    runner.setUIContext(
        {
            ...runner.getUIContext(),
            getEditorText: () => draft,
            setEditorText: (value) => {
                draft = value;
            },
        },
        "tui",
    );
    const command = runner.getCommand("review-file")!;
    const first = command.handler(
        "pi-plans/test.md",
        runner.createCommandContext(),
    );
    for (let i = 0; !existsSync(join(cwd, "started")) && i < 100; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(join(cwd, "started"))).toBe(true);
    await command.handler("pi-plans/test.md", runner.createCommandContext());
    expect(JSON.stringify(session.events.uiCallsFor("notify"))).toContain(
        "already open",
    );
    const notifications = session.events.uiCallsFor("notify").length;
    await runner.emit({ type: "session_shutdown", reason: "resume" });
    await first;
    expect(draft).toBe("");
    expect(session.events.uiCallsFor("notify")).toHaveLength(notifications);
});
