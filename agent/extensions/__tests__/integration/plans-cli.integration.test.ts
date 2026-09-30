import { afterEach, expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
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
    autoExecute?: boolean,
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
            plans: { planFileDir: "pi-plans", ...(autoExecute === undefined ? {} : { autoExecute }) },
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
        mockUI: { confirm: true },
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

async function waitUntil(predicate: () => boolean, description: string) {
    for (let i = 0; i < 150; i++) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${description}`);
}

const WAITING_REVIEW_CLI = `
    const fs = require('node:fs');
    process.on('SIGTERM', () => { fs.writeFileSync('terminated', '1'); process.exit(0); });
    fs.writeFileSync('started', String(process.pid));
    setInterval(() => {}, 1000);
`;

async function startSubmission(session: TestSession, cwd: string, tracked = true, filePath = "pi-plans/test.md") {
    const completion = session.run(when("Review", [
        ...(tracked ? [calls("write_plan", { path: "test.md", content: "# Plan" })] : []),
        calls("submit_plan", { filePath }),
        says("Planning paused"),
    ])).catch((error: Error) => error);
    await waitUntil(() => existsSync(join(cwd, "started")), "review process");
    return { completion };
}

test("autocomplete supplies usable absolute paths for a configured external plan directory", async () => {
    const { session, cwd } = await fixture("plan", WAITING_REVIEW_CLI);
    const planDir = mkdtempSync(join(tmpdir(), "plans-external-"));
    dirs.push(planDir);
    const filePath = join(planDir, "external.md");
    writeFileSync(filePath, "# External plan");
    const settings = JSON.parse(readFileSync(join(cwd, "settings.json"), "utf8"));
    settings.plans.planFileDir = planDir;
    writeFileSync(join(cwd, "settings.json"), JSON.stringify(settings));
    const { completion } = await startSubmission(session, cwd, false, filePath);
    try {
        const command = session.session.extensionRunner!.getCommand("abandon-plan")!;
        expect(await command.getArgumentCompletions!(planDir)).toMatchObject([{ value: filePath }]);
        await session.session.prompt(`/abandon-plan ${filePath}`);
        expect(await completion).toBeUndefined();
        expect(session.events.toolResultsFor("submit_plan")[0]).toMatchObject({ details: { decision: "abandoned" }, isError: false });
        expect(readFileSync(filePath, "utf8")).toBe("# External plan");
    } finally {
        if (session.session.isStreaming) await session.session.abort();
        await completion;
    }
}, 60000);

test("bare abandonment targets an untracked submission and explicit resubmission starts a new revision", async () => {
    const { session, cwd } = await fixture("plan", WAITING_REVIEW_CLI, "implement", false);
    const { completion } = await startSubmission(session, cwd, false);
    try {
        const command = session.session.extensionRunner!.getCommand("abandon-plan")!;
        expect(await command.getArgumentCompletions!("pi-plans/te")).toMatchObject([
            { value: "pi-plans/test.md", label: "pi-plans/test.md" },
        ]);
        await session.session.prompt("/abandon-plan");
        expect(await completion).toBeUndefined();
        expect(session.events.toolResultsFor("submit_plan")[0]).toMatchObject({ details: { decision: "abandoned" }, isError: false });
        expect(await command.getArgumentCompletions!("")).toEqual([]);
        await session.session.prompt("/abandon-plan pi-plans/test.md");
        expect(entries(session, "plan-review-guard:abandoned")).toHaveLength(1);
        expect(session.session.messages.filter((message) => message.role === "user" && JSON.stringify(message.content).includes("abandoned"))).toHaveLength(1);
        writeFileSync(join(cwd, "bin/plannotator"), `#!${process.execPath}\nconsole.log(JSON.stringify({decision:'approved'}));`, { mode: 0o700 });
        await session.run(when("Resume review", [
            calls("read", { path: "pi-plans/test.md" }),
            calls("submit_plan", { filePath: "pi-plans/test.md" }),
        ]));
        expect(entries(session, "plan-review-guard:revision")).toMatchObject([
            { data: { path: "pi-plans/test.md", revision: 1 } },
            { data: { path: "pi-plans/test.md", revision: 2 } },
        ]);
        expect(entries(session, "plan-review-guard:submitted").at(-1)).toMatchObject({ data: { revision: 2, approved: true } });
        await session.session.prompt("/role implement");
        expect(entries(session, "pi-roles:active-role").at(-1)).toMatchObject({ data: { name: "implement" } });
    } finally {
        if (session.session.isStreaming) await session.session.abort();
        await completion;
    }
}, 60000);

test("editing an abandoned plan reinstates approval before leaving planning", async () => {
    const { session, cwd } = await fixture("plan", WAITING_REVIEW_CLI);
    const { completion } = await startSubmission(session, cwd);
    try {
        await session.session.prompt("/abandon-plan");
        expect(await completion).toBeUndefined();
        await session.run(when("Revise", [
            calls("read", { path: "pi-plans/test.md" }),
            calls("edit_plan", { path: "test.md", edits: [{ oldText: "# Plan", newText: "# Revised plan" }] }),
            says("Ready for review"),
        ]));
        await session.session.prompt("/role implement");
        expect(entries(session, "pi-roles:active-role").at(-1)).toMatchObject({ data: { name: "plan" } });
        expect(await session.session.extensionRunner!.getCommand("abandon-plan")!.getArgumentCompletions!("")).toMatchObject([{ value: "pi-plans/test.md" }]);
    } finally {
        if (session.session.isStreaming) await session.session.abort();
        await completion;
    }
}, 60000);

test.each(["declined", "revision", "approved", "session"])("confirmation revalidates the plan (%s)", async (change) => {
    const { session, cwd } = await fixture("plan", WAITING_REVIEW_CLI, "implement", false);
    const { completion } = await startSubmission(session, cwd);
    const runner = session.session.extensionRunner!;
    runner.setUIContext({
        ...runner.getUIContext(),
        confirm: async () => {
            if (change === "declined") return false;
            if (change === "session") {
                await runner.emit({ type: "session_shutdown", reason: "resume" });
                return true;
            }
            session.session.sessionManager.appendCustomEntry(
                change === "revision" ? "plan-review-guard:revision" : "plan-review-guard:submitted",
                { path: "pi-plans/test.md", revision: change === "revision" ? 2 : 1, approved: true },
            );
            return true;
        },
    }, "tui");
    try {
        await session.session.prompt("/abandon-plan");
        expect(entries(session, "plan-review-guard:abandoned")).toHaveLength(0);
        expect(session.session.messages.filter((message) => message.role === "user" && JSON.stringify(message.content).includes("abandoned"))).toHaveLength(0);
        if (change !== "session") expect(existsSync(join(cwd, "terminated"))).toBe(false);
    } finally {
        if (session.session.isStreaming) await session.session.abort();
        await completion;
    }
}, 60000);

test("abandoning another draft leaves the active review open and its pending guard intact", async () => {
    const { session, cwd } = await fixture("plan", WAITING_REVIEW_CLI);
    await session.run(when("Another draft", [calls("write_plan", { path: "other.md", content: "# Other" }), says("Draft saved") ]));
    const { completion } = await startSubmission(session, cwd);
    try {
        await session.session.prompt("/abandon-plan pi-plans/other.md");
        expect(existsSync(join(cwd, "terminated"))).toBe(false);
        expect(entries(session, "plan-review-guard:abandoned")).toMatchObject([{ data: { path: "pi-plans/other.md" } }]);
        await session.session.prompt("/role implement");
        expect(entries(session, "pi-roles:active-role").at(-1)).toMatchObject({ data: { name: "plan" } });
        expect(await session.session.extensionRunner!.getCommand("abandon-plan")!.getArgumentCompletions!("")).toMatchObject([{ value: "pi-plans/test.md" }]);
    } finally {
        if (session.session.isStreaming) await session.session.abort();
        await completion;
    }
}, 60000);

test("abandon-plan cancels the pending submission, informs the agent and releases the guard", async () => {
    const { session, cwd } = await fixture("plan", WAITING_REVIEW_CLI);
    const run = session.run(when("Review", [
        calls("write_plan", { path: "test.md", content: "# Keep this plan" }),
        calls("submit_plan", { filePath: "pi-plans/test.md" }),
        says("Planning paused"),
    ])).catch((error: Error) => error);
    try {
        await waitUntil(() => existsSync(join(cwd, "started")), "review process");
        await session.session.prompt("/abandon-plan pi-plans/test.md");
        expect(entries(session, "plan-review-guard:abandoned")).toHaveLength(1);
        await waitUntil(() => session.events.toolResultsFor("submit_plan").length === 1, "abandoned tool result");
        const result = await run;
        if (result instanceof Error) throw result;
        expect(session.events.toolResultsFor("submit_plan")[0]).toMatchObject({
            isError: false,
            details: { decision: "abandoned", approved: false },
        });
        expect(existsSync(join(cwd, "terminated"))).toBe(true);
        expect(readFileSync(join(cwd, "pi-plans/test.md"), "utf8")).toBe("# Keep this plan");
        expect(entries(session, "plan-review-guard:abandoned")).toHaveLength(1);
        expect(entries(session, "plans:approved")).toHaveLength(0);
        expect(entries(session, "pi-roles:switch-request")).toHaveLength(0);
        const notices = session.session.messages.filter((message) => message.role === "user" &&
            JSON.stringify(message.content).includes("abandoned"));
        expect(notices).toHaveLength(1);
        expect(JSON.stringify(notices)).toContain("pi-plans/test.md");
        expect(entries(session, "pi-roles:active-role").at(-1)).toMatchObject({ data: { name: "plan" } });
        await session.session.prompt("/role implement");
        expect(entries(session, "pi-roles:active-role").at(-1)).toMatchObject({ data: { name: "implement" } });
    } finally {
        if (session.session.isStreaming) await session.session.abort();
        await run;
    }
}, 60000);

test("a manual role switch during cancellation preserves the normal abandoned result", async () => {
    const { session, cwd } = await fixture("plan", WAITING_REVIEW_CLI.replace("process.exit(0)", "setTimeout(() => process.exit(0), 1500)"));
    const { completion } = await startSubmission(session, cwd);
    try {
        await session.session.prompt("/abandon-plan");
        await session.session.prompt("/role implement");
        expect(await completion).toBeUndefined();
        expect(session.events.toolResultsFor("submit_plan")[0]).toMatchObject({ isError: false, details: { decision: "abandoned", approved: false } });
        expect(entries(session, "pi-roles:active-role").at(-1)).toMatchObject({ data: { name: "implement" } });
        expect(entries(session, "plans:approved")).toHaveLength(0);
    } finally {
        if (session.session.isStreaming) await session.session.abort();
        await completion;
    }
}, 60000);
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

test("idle abandonment does not consume a paused approval's role switch", async () => {
    const { session } = await fixture("plan", "console.log(JSON.stringify({decision:'approved'}));", "implement", false);
    await session.run(when("Approve one plan", [
        calls("write_plan", { path: "test.md", content: "# Approved" }),
        calls("write_plan", { path: "other.md", content: "# Pending" }),
        calls("submit_plan", { filePath: "pi-plans/test.md" }),
    ]));
    await session.session.prompt("/abandon-plan pi-plans/other.md");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(entries(session, "pi-roles:active-role").at(-1)).toMatchObject({ data: { name: "plan" } });
    expect(entries(session, "pi-roles:switch-processed")).toHaveLength(0);
    expect(session.session.messages.filter((message) =>
        (message.role === "custom" || message.role === "user") && JSON.stringify(message.content).includes("abandoned"),
    )).toHaveLength(1);
    await session.run(when("Implement now", [says("Implementing") ]));
    expect(entries(session, "pi-roles:active-role").at(-1)).toMatchObject({ data: { name: "implement" } });
}, 60000);

test("autoExecute false pauses approval until the next user message, including reconciliation", async () => {
    const { session } = await fixture("plan", "console.log(JSON.stringify({decision:'approved'}));", "implement", false);
    await session.run(when("Approve", [
        calls("write_plan", { path: "test.md", content: "# Plan" }),
        calls("submit_plan", { filePath: "pi-plans/test.md" }),
    ]));
    expect(entries(session, "plans:approved")).toMatchObject([{ data: { autoExecute: false } }]);
    await session.session.extensionRunner!.emit({ type: "agent_end", messages: [] });
    await session.session.extensionRunner!.emit({ type: "session_start", reason: "resume" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(entries(session, "pi-roles:active-role").at(-1)).toMatchObject({ data: { name: "plan" } });
    expect(session.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(entries(session, "pi-roles:switch-request")).toHaveLength(1);
    expect(entries(session, "pi-roles:switch-processed")).toHaveLength(0);
    await session.run(when("Implement now", [says("Implementing") ]));
    expect(entries(session, "pi-roles:active-role").at(-1)).toMatchObject({ data: { name: "implement" } });
    expect(entries(session, "pi-roles:switch-processed")).toHaveLength(1);
}, 30000);
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
