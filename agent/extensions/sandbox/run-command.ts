import { randomUUID } from "node:crypto";
import {
    createBashTool,
    type ExtensionAPI,
    type ExtensionContext,
    type AgentToolUpdateCallback,
    type BashToolDetails,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text } from "@earendil-works/pi-tui";
import {
    unknownExecution,
    formatShellExecutionLabel,
    type ExecutionProvenance,
} from "../_shared/execution-provenance/index.ts";
import { resolveForcedSandboxOperations } from "../_shared/shell-runtime/operations.ts";

export const SANDBOX_RUN_MESSAGE = "pi.sandbox-run.v1";

interface SandboxRunDetails {
    command: string;
    output: string;
    execution: ExecutionProvenance;
    fullOutputPath?: string;
}

function summary(details: SandboxRunDetails): string {
    const { command, output, execution, fullOutputPath } = details;
    return [
        formatShellExecutionLabel(execution, "sandbox"),
        `$ ${command}`,
        output,
        ...(fullOutputPath ? [`Full output: ${fullOutputPath}`] : []),
    ]
        .filter(Boolean)
        .join("\n");
}

export function createSandboxCommandRunner(pi: ExtensionAPI) {
    let active:
        | { controller: AbortController; settled: Promise<void> }
        | undefined;

    pi.registerMessageRenderer<SandboxRunDetails>(
        SANDBOX_RUN_MESSAGE,
        (message) =>
            message.details
                ? new Text(summary(message.details), 0, 0)
                : undefined,
    );

    return {
        async cancel(): Promise<void> {
            active?.controller.abort();
            await active?.settled;
        },
        async run(command: string, ctx: ExtensionContext): Promise<void> {
            if (!command.trim()) {
                ctx.ui.notify("Usage: /sandbox run <command>", "error");
                return;
            }
            if (active) {
                ctx.ui.notify(
                    "A /sandbox run command is already running. Cancel it before starting another.",
                    "error",
                );
                return;
            }
            const controller = new AbortController();
            let settle!: () => void;
            const operation = {
                controller,
                settled: new Promise<void>((resolve) => {
                    settle = resolve;
                }),
            };
            active = operation;
            const details: SandboxRunDetails = {
                command,
                output: "",
                execution: {
                    ...unknownExecution(),
                    mode: "sandbox",
                    outcome: "pending",
                },
            };
            const operations = resolveForcedSandboxOperations({
                onExecution: (execution) => {
                    details.execution = execution;
                },
            });
            const tool = createBashTool(ctx.cwd, {
                operations,
                exposeSessionEnvironment: false,
            });
            const capture: AgentToolUpdateCallback<
                BashToolDetails | undefined
            > = (result) => {
                details.output = result.content
                    .flatMap((item) =>
                        item.type === "text" ? [item.text] : [],
                    )
                    .join("\n");
                if (
                    result.details &&
                    typeof result.details === "object" &&
                    "fullOutputPath" in result.details &&
                    typeof result.details.fullOutputPath === "string"
                ) {
                    details.fullOutputPath = result.details.fullOutputPath;
                }
            };
            const execute = async (refresh: () => void): Promise<void> => {
                try {
                    const result = await tool.execute(
                        randomUUID(),
                        { command },
                        controller.signal,
                        (update) => {
                            capture(update);
                            refresh();
                        },
                    );
                    capture(result);
                } catch (error) {
                    const problem =
                        error instanceof Error ? error.message : String(error);
                    if (!details.output || !problem.includes(details.output)) {
                        details.output = [details.output, problem]
                            .filter(Boolean)
                            .join("\n");
                    } else {
                        details.output = problem;
                    }
                    if (
                        details.execution.outcome === "pending" ||
                        details.execution.outcome === "unknown"
                    ) {
                        details.execution = {
                            ...details.execution,
                            outcome: controller.signal.aborted
                                ? "aborted"
                                : "blocked",
                        };
                    }
                }
            };
            let running: Promise<void> | undefined;
            try {
                if (ctx.mode === "tui") {
                    await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
                        const view = new Text(
                            `${summary(details)}\nEsc to cancel`,
                            0,
                            0,
                        );
                        const refresh = () => {
                            view.setText(`${summary(details)}\nEsc to cancel`);
                            tui.requestRender();
                        };
                        running = execute(refresh).finally(() => done());
                        return {
                            render: (width) => view.render(width),
                            invalidate: () => view.invalidate(),
                            handleInput: (input) => {
                                if (matchesKey(input, Key.escape))
                                    controller.abort();
                            },
                            dispose: () => controller.abort(),
                        };
                    });
                    await running;
                } else {
                    await execute(() => undefined);
                }
                pi.sendMessage(
                    {
                        customType: SANDBOX_RUN_MESSAGE,
                        display: true,
                        content: `${summary(details)}\nExecution provenance: ${JSON.stringify(details.execution)}`,
                        details,
                    },
                    { triggerTurn: false },
                );
            } finally {
                controller.abort();
                try {
                    await running;
                } finally {
                    if (active === operation) active = undefined;
                    settle();
                }
            }
        },
    };
}
