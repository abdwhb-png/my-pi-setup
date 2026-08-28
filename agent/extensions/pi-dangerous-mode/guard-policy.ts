import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { inspectDangerous } from "../_shared/bash/guard.ts";
import {
    DEFAULT_AUTOPILOT,
    matchesTool,
    type AutopilotConfig,
} from "./config.ts";

export type GuardCategory =
    | "irreversible_delete"
    | "publish"
    | "deploy"
    | "purchase"
    | "external_effect";

export interface GuardBlock {
    category: GuardCategory;
    toolName: string;
    reason: string;
}

function block(toolName: string, category: GuardCategory): GuardBlock {
    return {
        category,
        toolName,
        reason: `Autopilot blocked protected action: ${category}.`,
    };
}

function commandFrom(input: ToolCallEvent["input"]): string | undefined {
    if (typeof input !== "object" || input === null) return undefined;
    const command = Reflect.get(input, "command");
    return typeof command === "string" ? command : undefined;
}

function builtInCategory(pattern: string): GuardCategory {
    if (/delete|destroy/i.test(pattern)) return "irreversible_delete";
    if (/purchase|payment/i.test(pattern)) return "purchase";
    if (/publish|push|pr create|release create/i.test(pattern)) {
        return "publish";
    }
    if (/deploy|kubectl|helm|terraform/i.test(pattern)) return "deploy";
    return "external_effect";
}

function categoryForPattern(
    pattern: string,
    defaults: readonly string[],
): GuardCategory {
    return defaults.includes(pattern)
        ? builtInCategory(pattern)
        : "external_effect";
}

export function evaluateAutopilotGuard(
    event: Pick<ToolCallEvent, "toolName" | "input">,
    config: AutopilotConfig,
): GuardBlock | undefined {
    const command = commandFrom(event.input);
    if (command !== undefined) {
        const danger = inspectDangerous(command);
        if (danger) {
            const category =
                danger.groupId === "rm" || danger.groupId === "file-delete-api"
                    ? "irreversible_delete"
                    : "external_effect";
            return block(event.toolName, category);
        }

        const commandPattern = config.guardedCommands.find((pattern) =>
            matchesTool(command, [pattern]),
        );
        if (commandPattern) {
            return block(
                event.toolName,
                categoryForPattern(
                    commandPattern,
                    DEFAULT_AUTOPILOT.guardedCommands,
                ),
            );
        }
    }

    const toolPattern = config.guardedTools.find((pattern) =>
        matchesTool(event.toolName, [pattern]),
    );
    if (!toolPattern) return undefined;

    return block(
        event.toolName,
        categoryForPattern(toolPattern, DEFAULT_AUTOPILOT.guardedTools),
    );
}
