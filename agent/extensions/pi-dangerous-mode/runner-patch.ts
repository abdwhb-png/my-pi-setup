import * as Pi from "@earendil-works/pi-coding-agent";
import type {
    ExtensionContext,
    ToolCallEvent,
    ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { matchesExtension, matchesTool } from "./config.ts";
import {
    getMutableRuntimeState,
    isUnattendedEnabled,
    recomputeEffectiveState,
    type EmitToolCall,
} from "./runtime-state.ts";

export {
    disableForInvalidConfig,
    getStatus,
    isDangerousEnabled,
    setDangerousRuntimeState,
    setSessionOverride,
    startDangerousSession,
} from "./runtime-state.ts";

type ExtensionRunner = InstanceType<typeof Pi.ExtensionRunner>;
type ExtensionRunnerConstructor = typeof Pi.ExtensionRunner;

type ToolCallHandler = (
    event: ToolCallEvent,
    ctx: ExtensionContext,
) => Promise<ToolCallEventResult | void> | ToolCallEventResult | void;

type RuntimeExtension = {
    path: string;
    handlers: ToolCallHandler[];
};

const RUNNER_PATCH_VERSION = 2;

function getRuntimeExtensions(
    runner: ExtensionRunner,
): RuntimeExtension[] | null {
    const rawExtensions: unknown = Object.getOwnPropertyDescriptor(
        runner,
        "extensions",
    )?.value;
    if (!Array.isArray(rawExtensions)) return null;

    const extensions: RuntimeExtension[] = [];
    for (const candidate of rawExtensions) {
        if (typeof candidate !== "object" || candidate === null) return null;

        const path: unknown = Object.getOwnPropertyDescriptor(
            candidate,
            "path",
        )?.value;
        const handlerMap: unknown = Object.getOwnPropertyDescriptor(
            candidate,
            "handlers",
        )?.value;
        if (typeof path !== "string" || !(handlerMap instanceof Map)) {
            return null;
        }

        const rawHandlers = handlerMap.get("tool_call");
        if (rawHandlers !== undefined && !Array.isArray(rawHandlers)) {
            return null;
        }

        const handlers: ToolCallHandler[] = [];
        for (const handler of rawHandlers ?? []) {
            if (typeof handler !== "function") return null;
            handlers.push(handler);
        }
        extensions.push({ path, handlers });
    }
    return extensions;
}

function isEmitToolCall(value: unknown): value is EmitToolCall {
    return typeof value === "function";
}

function isExtensionRunnerConstructor(
    value: unknown,
): value is ExtensionRunnerConstructor {
    if (typeof value !== "function") return false;

    const prototype = (value as { prototype?: unknown }).prototype;
    if (typeof prototype !== "object" || prototype === null) return false;

    return (
        isEmitToolCall(
            Object.getOwnPropertyDescriptor(prototype, "emitToolCall")?.value,
        ) &&
        typeof (prototype as { createContext?: unknown }).createContext ===
            "function"
    );
}

function reportIncompatibility(runner: ExtensionRunner, reason: string): void {
    const state = getMutableRuntimeState();
    state.compatible = false;
    recomputeEffectiveState(state);
    if (state.incompatibilityReported) return;

    state.incompatibilityReported = true;
    runner.emitError({
        extensionPath: "pi-dangerous-mode",
        event: "tool_call",
        error: `Dangerous mode disabled: incompatible ExtensionRunner (${reason}).`,
    });
}

export function installRunnerPatch(
    runnerConstructor: unknown = Pi.ExtensionRunner,
): boolean {
    const state = getMutableRuntimeState();
    if (state.installed && state.runnerPatchVersion === RUNNER_PATCH_VERSION) {
        return state.compatible;
    }

    if (!isExtensionRunnerConstructor(runnerConstructor)) {
        state.compatible = false;
        recomputeEffectiveState(state);
        return false;
    }

    if (state.installed && isEmitToolCall(state.original)) {
        runnerConstructor.prototype.emitToolCall = state.original;
    }

    const original = Object.getOwnPropertyDescriptor(
        runnerConstructor.prototype,
        "emitToolCall",
    )?.value;
    if (!isEmitToolCall(original)) {
        state.compatible = false;
        recomputeEffectiveState(state);
        return false;
    }

    state.compatible = true;
    state.original = original;
    runnerConstructor.prototype.emitToolCall =
        async function emitDangerousToolCall(
            this: ExtensionRunner,
            event: ToolCallEvent,
        ): Promise<ToolCallEventResult | undefined> {
            const current = getMutableRuntimeState();
            const originalEmit = current.original;
            if (!originalEmit) return undefined;

            if (
                isUnattendedEnabled() &&
                event.toolName === "ask_user_question"
            ) {
                return {
                    block: true,
                    reason: "[UNATTENDED_PROMPT_BLOCKED] Human question suppressed. Choose only a safe, reversible path supported by current context and do not call ask_user_question again. If no such path exists, end normally with the concrete blocker.",
                };
            }

            if (
                !current.enabled ||
                matchesTool(event.toolName, current.config.protectedTools)
            ) {
                return originalEmit.call(this, event);
            }

            const extensions = getRuntimeExtensions(this);
            if (!extensions) {
                reportIncompatibility(
                    this,
                    "extension collection shape changed",
                );
                return originalEmit.call(this, event);
            }

            const ctx = this.createContext();
            let result: ToolCallEventResult | undefined;
            for (const extension of extensions) {
                if (
                    !matchesExtension(
                        extension.path,
                        current.config.protectedExtensions,
                    )
                ) {
                    continue;
                }

                for (const handler of extension.handlers) {
                    // oxlint-disable-next-line eslint/no-await-in-loop -- Pi dispatch is sequential and first-block wins.
                    const handlerResult = await handler(event, ctx);
                    if (handlerResult) {
                        result = handlerResult;
                        if (result.block) return result;
                    }
                }
            }
            return result;
        };
    state.installed = true;
    state.runnerPatchVersion = RUNNER_PATCH_VERSION;
    return true;
}
