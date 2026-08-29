import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    calls,
    createTestSession,
    says,
    type TestSession,
    when,
} from "@abdwhb-png/pi-test-harness";
import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AUTOPILOT_COMPLETE_TOOL } from "./autopilot-loop.ts";
import dangerousModeExtension from "./index.ts";
import { getRuntimeStatus } from "./runtime-state.ts";
import { AUTOPILOT_TELEMETRY_ENTRY } from "./telemetry.ts";

const AUTOPILOT_CONTINUE_MESSAGE = "pi:autopilot:continue";
type PromptKind = "select" | "confirm" | "input" | "editor";

async function openPrompt(
    kind: PromptKind,
    ctx: ExtensionContext,
): Promise<unknown> {
    if (kind === "select") {
        return ctx.ui.select("Choose deployment", ["staging", "production"]);
    }
    if (kind === "confirm") {
        return ctx.ui.confirm("Deploy", "Continue deployment?");
    }
    if (kind === "input") {
        return ctx.ui.input("Release name", "v1.0.0");
    }
    return ctx.ui.editor("Release notes", "Initial notes");
}

function registerPromptFixtures(pi: ExtensionAPI): void {
    for (const kind of ["select", "confirm", "input", "editor"] as const) {
        pi.registerTool({
            name: `prompt_${kind}`,
            label: `Prompt ${kind}`,
            description: `Open ${kind} human UI.`,
            parameters: Type.Object({}),
            async execute(_id, _params, _signal, _onUpdate, ctx) {
                const answer = await openPrompt(kind, ctx);
                return {
                    content: [{ type: "text", text: String(answer) }],
                    details: {},
                };
            },
        });
    }
}

function askFixture(onExecute: () => void): (pi: ExtensionAPI) => void {
    return (pi) => {
        pi.registerTool({
            name: "ask_user_question",
            label: "Ask user",
            description: "Ask a human question.",
            parameters: Type.Object({}),
            async execute() {
                onExecute();
                return {
                    content: [{ type: "text", text: "Human answered." }],
                    details: {},
                };
            },
        });
    };
}

function registerBlockedErrorFixture(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "fixture_error",
        label: "Fixture error",
        description: "Tool blocked by fixture hook.",
        parameters: Type.Object({}),
        async execute() {
            return {
                content: [{ type: "text", text: "unexpected execution" }],
                details: {},
            };
        },
    });
    pi.on("tool_call", (event) =>
        event.toolName === "fixture_error"
            ? { block: true, reason: "fixture blocked" }
            : undefined,
    );
}

function guardedFixture(onExecute: (toolName: string) => void) {
    return (pi: ExtensionAPI): void => {
        pi.registerTool({
            name: "deploy_service",
            label: "Deploy service",
            description: "Deploy a service.",
            parameters: Type.Object({}),
            async execute() {
                onExecute("deploy_service");
                return {
                    content: [{ type: "text", text: "deployed" }],
                    details: {},
                };
            },
        });
        pi.registerTool({
            name: "safe_bash",
            label: "Safe bash",
            description: "Execute guarded shell input.",
            parameters: Type.Object({ command: Type.String() }),
            async execute(_id, params) {
                onExecute("safe_bash");
                return {
                    content: [{ type: "text", text: params.command }],
                    details: {},
                };
            },
        });
    };
}

async function runCommand(
    session: TestSession,
    name: "autopilot" | "dangerous-mode",
    args: string,
): Promise<void> {
    const command = session.session.extensionRunner.getCommand(name);
    if (!command) throw new Error(`Missing /${name} command`);
    await command.handler(
        args,
        session.session.extensionRunner.createCommandContext(),
    );
}

function customEntries(session: TestSession, customType: string): unknown[] {
    return session.session.sessionManager
        .getEntries()
        .flatMap((entry) =>
            entry.type === "custom" && entry.customType === customType
                ? [entry.data]
                : [],
        );
}

describe("pi-dangerous-mode real Pi runtime", () => {
    let session: TestSession | undefined;
    const tempDirectories: string[] = [];

    async function createConfiguredSession(
        config: Record<string, unknown>,
        extensionFactories: Array<(pi: ExtensionAPI) => void> = [],
    ): Promise<TestSession> {
        const cwd = mkdtempSync(join(tmpdir(), "pi-autopilot-runtime-"));
        tempDirectories.push(cwd);
        const projectConfigDirectory = join(cwd, ".pi");
        mkdirSync(projectConfigDirectory);
        writeFileSync(
            join(projectConfigDirectory, "pi-dangerous-mode.json"),
            JSON.stringify(config),
        );
        return createTestSession({
            cwd,
            extensionFactories: [
                ...extensionFactories,
                dangerousModeExtension,
            ],
            propagateErrors: false,
        });
    }

    afterEach(() => {
        session?.dispose();
        session = undefined;
        for (const directory of tempDirectories.splice(0)) {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("keeps completion tool hidden until explicit Autopilot activation", async () => {
        session = await createTestSession({
            extensionFactories: [dangerousModeExtension],
        });
        const baseline = session.session.agent.state.tools.map(
            (tool) => tool.name,
        );

        expect(baseline).not.toContain("autopilot_complete");
        await runCommand(session, "autopilot", "on");
        expect(session.session.agent.state.tools.map((tool) => tool.name)).toContain(
            "autopilot_complete",
        );

        await runCommand(session, "autopilot", "off");
        const afterDisable = session.session.agent.state.tools.map(
            (tool) => tool.name,
        );
        expect(afterDisable).not.toContain("autopilot_complete");
        expect(afterDisable).toEqual(baseline);
    });

    for (const kind of ["select", "confirm", "input", "editor"] as const) {
        it(`blocks unknown-extension ${kind} UI before rendering`, async () => {
            session = await createTestSession({
                extensionFactories: [
                    registerPromptFixtures,
                    dangerousModeExtension,
                ],
                propagateErrors: false,
            });
            await runCommand(session, "autopilot", "on");

            await session.run(
                when(`Open ${kind}`, [
                    calls(`prompt_${kind}`),
                    says("Used a non-interactive path."),
                ]),
            );

            const [result] = session.events.toolResultsFor(`prompt_${kind}`);
            expect(result).toMatchObject({ mocked: false });
            expect(result?.text).toContain("AUTOPILOT_PROMPT_BLOCKED");
            expect(session.events.uiCallsFor(kind)).toHaveLength(0);
        });
    }

    it("blocks ask_user_question before fixture execution under Autopilot", async () => {
        let executions = 0;
        session = await createTestSession({
            extensionFactories: [
                askFixture(() => {
                    executions += 1;
                }),
                dangerousModeExtension,
            ],
            propagateErrors: false,
        });
        await runCommand(session, "autopilot", "on");

        await session.run(
            when("Ask a human", [
                calls("ask_user_question"),
                says("Used current context instead."),
            ]),
        );

        const [call] = session.events.toolCallsFor("ask_user_question");
        const [result] = session.events.toolResultsFor("ask_user_question");
        expect(call).toMatchObject({ blocked: true });
        expect(call?.blockReason).toContain("non-interactive");
        expect(result).toMatchObject({ isError: true });
        expect(executions).toBe(0);
    });

    it("does not suppress ask_user_question in Dangerous-only mode", async () => {
        let executions = 0;
        session = await createTestSession({
            extensionFactories: [
                askFixture(() => {
                    executions += 1;
                }),
                dangerousModeExtension,
            ],
        });
        await runCommand(session, "dangerous-mode", "on");

        await session.run(
            when("Ask a human", [
                calls("ask_user_question"),
                says("Question completed."),
            ]),
        );

        const [call] = session.events.toolCallsFor("ask_user_question");
        const [result] = session.events.toolResultsFor("ask_user_question");
        expect(call).toMatchObject({ blocked: false });
        expect(result).toMatchObject({ isError: false });
        expect(executions).toBe(1);
    });

    it("queues one continuation and stops after explicit completion", async () => {
        session = await createTestSession({
            extensionFactories: [dangerousModeExtension],
        });
        await runCommand(session, "autopilot", "on");

        await session.run(
            when("Complete the task", [
                says("Work and executable validation are complete."),
                calls(AUTOPILOT_COMPLETE_TOOL, {
                    outcome: "completed",
                    summary: "Task and validation complete.",
                    remainingRisks: [],
                }),
                says("Final answer."),
            ]),
        );

        expect(getRuntimeStatus().autopilot.phase).toBe("completed");
        expect(
            session.session.sessionManager
                .getEntries()
                .filter(
                    (entry) =>
                        entry.type === "custom_message" &&
                        entry.customType === AUTOPILOT_CONTINUE_MESSAGE,
                ),
        ).toHaveLength(1);

        const telemetry = customEntries(
            session,
            AUTOPILOT_TELEMETRY_ENTRY,
        );
        expect(telemetry).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ event: "turn_recorded" }),
                expect.objectContaining({ event: "continuation_queued" }),
                expect.objectContaining({
                    event: "completed",
                    outcome: "completed",
                }),
            ]),
        );
        expect(JSON.stringify(telemetry)).not.toMatch(
            /"(?:title|message|prompt|options|answer|input|command|content|details)"\s*:/,
        );
    });

    it("uses one retry continuation after one blocked error turn", async () => {
        session = await createConfiguredSession(
            { protectedExtensions: ["*inline:1*"] },
            [registerBlockedErrorFixture],
        );
        await runCommand(session, "autopilot", "on");

        await session.run(
            when("Recover from one tool error", [
                calls("fixture_error"),
                says("Recovered safely."),
                calls(AUTOPILOT_COMPLETE_TOOL, {
                    outcome: "completed",
                    summary: "Recovery complete.",
                }),
                says("Final answer."),
            ]),
        );

        expect(getRuntimeStatus().autopilot).toMatchObject({
            phase: "completed",
            retriesUsed: 1,
        });
        expect(customEntries(session, AUTOPILOT_TELEMETRY_ENTRY)).toContainEqual(
            expect.objectContaining({
                event: "continuation_queued",
                reason: "retry",
            }),
        );
    });

    it("stops after consuming two configured error continuations", async () => {
        session = await createConfiguredSession(
            {
                protectedExtensions: ["*inline:1*"],
                autopilot: { maxRetries: 2, maxTurns: 8 },
            },
            [registerBlockedErrorFixture],
        );
        await runCommand(session, "autopilot", "on");

        await session.run(
            when("Hit retry budget", [
                calls("fixture_error"),
                says("First recovery attempt."),
                calls("fixture_error"),
                says("Second recovery attempt."),
            ]),
        );

        expect(getRuntimeStatus().autopilot).toMatchObject({
            phase: "budget_exhausted",
            retriesUsed: 2,
            stopReason: "retry_budget",
        });
        expect(
            customEntries(session, AUTOPILOT_TELEMETRY_ENTRY).filter(
                (entry) =>
                    typeof entry === "object" &&
                    entry !== null &&
                    "event" in entry &&
                    entry.event === "continuation_queued",
            ),
        ).toHaveLength(1);
    });

    it("stops without continuation at turn budget", async () => {
        session = await createConfiguredSession({
            autopilot: { maxTurns: 1 },
        });
        await runCommand(session, "autopilot", "on");

        await session.run(when("Use final turn", [says("Turn finished.")]));

        expect(getRuntimeStatus().autopilot).toMatchObject({
            phase: "budget_exhausted",
            turnsUsed: 1,
            stopReason: "turn_budget",
        });
        expect(
            customEntries(session, AUTOPILOT_TELEMETRY_ENTRY),
        ).not.toContainEqual(
            expect.objectContaining({ event: "continuation_queued" }),
        );
    });

    it("stops without continuation at elapsed-time budget", async () => {
        session = await createConfiguredSession({
            autopilot: { maxDurationMs: 1 },
        });
        await runCommand(session, "autopilot", "on");
        await Bun.sleep(10);

        await session.run(when("Use expired budget", [says("Turn finished.")]));

        expect(getRuntimeStatus().autopilot).toMatchObject({
            phase: "budget_exhausted",
            stopReason: "time_budget",
        });
    });

    for (const guardedCall of [
        { toolName: "deploy_service", input: {}, category: "deploy" },
        {
            toolName: "safe_bash",
            input: { command: "rm -rf /" },
            category: "irreversible_delete",
        },
    ] as const) {
        it(`blocks guarded ${guardedCall.toolName} before execution`, async () => {
            const executions: string[] = [];
            session = await createTestSession({
                extensionFactories: [
                    guardedFixture((toolName) => executions.push(toolName)),
                    dangerousModeExtension,
                ],
                propagateErrors: false,
            });
            await runCommand(session, "autopilot", "on");

            await session.run(
                when(`Call ${guardedCall.toolName}`, [
                    calls(guardedCall.toolName, guardedCall.input),
                    says("Stopped safely."),
                ]),
            );

            const [call] = session.events.toolCallsFor(guardedCall.toolName);
            const [result] = session.events.toolResultsFor(
                guardedCall.toolName,
            );
            expect(call).toMatchObject({ blocked: true });
            expect(result).toMatchObject({ isError: true });
            expect(executions).toHaveLength(0);
            expect(getRuntimeStatus().autopilot.phase).toBe("blocked");
            expect(customEntries(session, AUTOPILOT_TELEMETRY_ENTRY)).toContainEqual(
                expect.objectContaining({
                    event: "guard_blocked",
                    category: guardedCall.category,
                    toolName: guardedCall.toolName,
                }),
            );
            expect(
                session.session.sessionManager
                    .getEntries()
                    .filter(
                        (entry) =>
                            entry.type === "custom_message" &&
                            entry.customType === AUTOPILOT_CONTINUE_MESSAGE,
                    ),
            ).toHaveLength(0);
        });
    }
});
