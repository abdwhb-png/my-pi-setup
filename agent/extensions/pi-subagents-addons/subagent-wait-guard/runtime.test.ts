import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
    calls,
    createTestSession,
    says,
    when,
    type TestSession,
} from "@abdwhb-png/pi-test-harness";
import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
    SUBAGENT_RPC_REQUEST_EVENT,
    SUBAGENT_RPC_REPLY_EVENT_PREFIX,
    type SubagentRpcToolResult,
} from "../../_shared/subagents/rpc-client.ts";
import {
    buildFollowUp,
    buildParentReminder,
    SUBAGENT_PROGRESS_MARKER,
} from "./guard.ts";

type Run = { id: string; state: string; session?: string };
let session: TestSession | undefined;
let runs: Run[] = [];
let statusFailure: string | undefined;
let incomplete = false;
let statusRequests = 0;

afterEach(async () => {
    await session?.session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
    });
    session?.dispose();
    session = undefined;
    runs = [];
    statusFailure = undefined;
    incomplete = false;
    statusRequests = 0;
});

async function start(
    mode: ExtensionContext["mode"] = "tui",
    options: {
        completeOnWait?: boolean;
        failTool?: boolean;
        missingOwner?: boolean;
    } = {},
) {
    session = await createTestSession({
        extensions: [join(import.meta.dir, "index.ts")],
        extensionFactories: [
            (pi: ExtensionAPI) => {
                let currentSession: string;
                pi.on("session_start", (_event, ctx) => {
                    currentSession = ctx.sessionManager.getSessionId();
                });
                pi.events.on(SUBAGENT_RPC_REQUEST_EVENT, (value: unknown) => {
                    const request = value as {
                        requestId: string;
                        method: string;
                    };
                    expect(request.method).toBe("status");
                    statusRequests++;
                    if (options.missingOwner) return;
                    const owned = runs.filter(
                        (run) => !run.session || run.session === currentSession,
                    );
                    const data: SubagentRpcToolResult = {
                        text: "status",
                        asyncSnapshot: {
                            kind: "pi-subagents.async-status-snapshot",
                            version: 1,
                            runs: owned.map((run) => ({
                                id: run.id,
                                kind: "subagent",
                                label: "worker",
                                state: run.state,
                            })),
                            omitted: {
                                runs: incomplete ? 1 : 0,
                                children: 0,
                                byteLimitExceeded: false,
                            },
                        },
                    };
                    pi.events.emit(
                        `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${request.requestId}`,
                        {
                            version: 1,
                            requestId: request.requestId,
                            method: request.method,
                            success: !statusFailure,
                            ...(statusFailure
                                ? {
                                      error: {
                                          code: "unavailable",
                                          message: statusFailure,
                                      },
                                  }
                                : { data }),
                        },
                    );
                });
                for (const name of ["subagent", "bg_wait"])
                    pi.registerTool({
                        name,
                        label: name,
                        description:
                            "Controlled external package tool boundary",
                        parameters: Type.Object({}),
                        async execute() {
                            if (options.failTool)
                                throw new Error("External tool failed");
                            if (name === "bg_wait" && options.completeOnWait)
                                runs = runs.map((run) => ({
                                    ...run,
                                    state: "complete",
                                }));
                            return {
                                content: [{ type: "text", text: "status" }],
                                details: {},
                            };
                        },
                    });
            },
        ],
    });
    await session.session.bindExtensions({ mode });
    return session;
}
function reminders() {
    return session!.events.messages.filter(
        (message) =>
            message.role === "custom" &&
            message.customType === "subagent-wait-guard-reminder",
    );
}
function assistantText() {
    return session!.events.messages
        .filter((message) => message.role === "assistant")
        .flatMap((message) => message.content)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

test("TUI preserves prose and records one hidden reminder from the current-session status RPC", async () => {
    runs = [{ id: "child-a", state: "running" }];
    const s = await start();
    await s.run(
        when("Inspect", [says("Still working.")]),
        when("Update", [says("Still working again.")]),
    );
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0]).toMatchObject({
        display: false,
        content: buildParentReminder(["child-a"], "interactive"),
    });
    expect(assistantText()).toContain("Still working again.");
    expect(assistantText()).not.toContain("Answer deferred");
    expect(statusRequests).toBeGreaterThan(0);
});

test.each(["print", "json", "rpc"] as const)(
    "%s mode automatically requests one wait turn and incorporates terminal reports",
    async (mode) => {
        runs = [{ id: "child-a", state: "running" }];
        const s = await start(mode, { completeOnWait: true });
        // One user prompt: the later actions require the guard's actual continuation.
        await s.run(
            when("Inspect", [
                says("Premature conclusion."),
                calls("bg_wait"),
                says("Final report incorporated."),
            ]),
        );
        expect(assistantText()).not.toContain("Premature conclusion.");
        expect(assistantText()).toContain("Final report incorporated.");
        expect(reminders()).toHaveLength(1);
        expect(reminders()[0]).toMatchObject({
            display: false,
            content: buildFollowUp(["child-a"]),
        });
        expect(s.events.toolResultsFor("bg_wait")[0]?.mocked).toBe(false);
    },
);

test("unchanged headless work gets one continuation even if it remains active", async () => {
    runs = [{ id: "child-a", state: "running" }];
    const s = await start("print");
    await s.run(
        when("Inspect", [says("Premature."), says("Still premature.")]),
    );
    expect(reminders()).toHaveLength(1);
    expect(assistantText()).not.toContain("Still premature.");
});

test.each(["tui", "print"] as const)(
    "%s paused work gets attention without an automatic wait turn",
    async (mode) => {
        runs = [
            { id: "child-a", state: "paused" },
            { id: "child-b", state: "running" },
        ];
        const s = await start(mode);
        await s.run(when("Inspect", [says("Needs help.")]));
        expect(reminders()).toHaveLength(1);
        expect(reminders()[0]).toMatchObject({
            content: buildParentReminder(["child-a", "child-b"], "attention"),
            display: false,
        });
        expect(s.events.toolCallsFor("bg_wait")).toHaveLength(0);
    },
);

test("completed and other-session work do not withhold the current answer", async () => {
    runs = [
        { id: "done", state: "complete" },
        { id: "foreign", state: "running", session: "another-session" },
    ];
    const s = await start("print");
    await s.run(when("Inspect", [says("Final answer.")]));
    expect(assistantText()).toBe("Final answer.");
    expect(reminders()).toHaveLength(0);
});

test("settlement clears deduplication and new membership permits another TUI reminder", async () => {
    runs = [{ id: "child-a", state: "running" }];
    const s = await start();
    await s.run(when("Inspect", [says("Working.")]));
    runs = [];
    await s.run(when("Completed", [says("Finished.")]));
    runs = [{ id: "child-a", state: "running" }];
    await s.run(when("Restart", [says("Working again.")]));
    runs = [{ id: "child-b", state: "running" }];
    await s.run(when("New child", [says("New work.")]));
    expect(reminders()).toHaveLength(3);
});

test.each(["subagent", "bg_wait"])(
    "a successful %s result permits one marked progress update",
    async (tool) => {
        runs = [{ id: "child-a", state: "running" }];
        const s = await start("print");
        await s.run(
            when("Inspect", [
                calls(tool),
                says(`${SUBAGENT_PROGRESS_MARKER} Child still running.`),
            ]),
        );
        expect(assistantText()).toContain("Child still running.");
        expect(assistantText()).not.toContain(SUBAGENT_PROGRESS_MARKER);
        expect(reminders()).toHaveLength(0);
        await s.run(
            when("Update", [
                says(`${SUBAGENT_PROGRESS_MARKER} Unsupported progress.`),
                says("Premature again."),
            ]),
        );
        expect(assistantText()).not.toContain("Unsupported progress.");
        expect(reminders()).toHaveLength(1);
    },
);

test("a failed delegation result does not authorize headless progress", async () => {
    runs = [{ id: "child-a", state: "running" }];
    const s = await start("print", { failTool: true });
    await s.run(
        when("Inspect", [
            calls("subagent"),
            says(`${SUBAGENT_PROGRESS_MARKER} Unverified progress.`),
            says("Premature."),
        ]),
    );
    expect(assistantText()).not.toContain("Unverified progress.");
    expect(reminders()).toHaveLength(1);
});

test.each(["status error", "truncated status"])(
    "%s is visible and never treated as empty work",
    async (failure) => {
        if (failure === "status error")
            statusFailure = "Status owner unavailable";
        else incomplete = true;
        const s = await start("print");
        await s.run(when("Inspect", [says("Unchecked final answer.")]));
        expect(assistantText()).toContain("Cannot verify delegated work");
        expect(assistantText()).not.toContain("Unchecked final answer.");
        const errors = s.events.messages.filter(
            (message) =>
                message.role === "custom" &&
                message.customType === "subagent-wait-guard-status-error",
        );
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ display: true });
        expect(reminders()).toHaveLength(0);
        expect(statusRequests).toBe(1);
        statusFailure = undefined;
        incomplete = false;
        await s.run(when("Recovered", [says("Verified final answer.")]));
        expect(assistantText()).toContain("Verified final answer.");
    },
);

test("an absent status owner produces one bounded timeout diagnostic", async () => {
    const s = await start("print", { missingOwner: true });
    await s.run(when("Inspect", [says("Unchecked answer.")]));
    expect(statusRequests).toBe(1);
    expect(assistantText()).toContain("status timed out");
    expect(assistantText()).not.toContain("Unchecked answer.");
});
