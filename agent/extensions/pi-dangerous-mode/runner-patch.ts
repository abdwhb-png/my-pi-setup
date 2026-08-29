import * as Pi from "@earendil-works/pi-coding-agent";
import type {
    ExtensionContext,
    ToolCallEvent,
    ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { matchesExtension, matchesTool } from "./config.ts";
import { evaluateAutopilotGuard } from "./guard-policy.ts";
import {
    completeAutopilot,
    getMutableRuntimeState,
    isAutopilotEnabled,
    recomputeEffectiveState,
    type EmitToolCall,
} from "./runtime-state.ts";
import type {
    AutopilotTelemetryEvent,
    createTelemetryRecorder,
} from "./telemetry.ts";

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

export interface RunnerPatchDeps {
    telemetry?: ReturnType<typeof createTelemetryRecorder>;
    onPromptBlocked?: () => void;
}

interface RunnerPatchDependencyState {
    telemetry: (event: AutopilotTelemetryEvent) => void;
    onPromptBlocked: () => void;
}

const DEPENDENCY_STATE_KEY = Symbol.for("pi-dangerous-mode.runner-patch-deps");
type RunnerPatchGlobal = typeof globalThis & {
    [DEPENDENCY_STATE_KEY]?: RunnerPatchDependencyState;
};

function getRunnerPatchDeps(): RunnerPatchDependencyState {
    const globals = globalThis as RunnerPatchGlobal;
    globals[DEPENDENCY_STATE_KEY] ??= {
        telemetry: () => undefined,
        onPromptBlocked: () => undefined,
    };
    return globals[DEPENDENCY_STATE_KEY];
}

function updateRunnerPatchDeps(deps: RunnerPatchDeps): void {
    const current = getRunnerPatchDeps();
    current.telemetry = deps.telemetry ?? (() => undefined);
    current.onPromptBlocked = deps.onPromptBlocked ?? (() => undefined);
}

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
        const rawExtension: unknown = candidate;
        if (typeof rawExtension !== "object" || rawExtension === null)
            return null;

        const path: unknown = Object.getOwnPropertyDescriptor(
            rawExtension,
            "path",
        )?.value;
        const handlerMap: unknown = Object.getOwnPropertyDescriptor(
            rawExtension,
            "handlers",
        )?.value;
        if (typeof path !== "string" || !(handlerMap instanceof Map))
            return null;

        const rawHandlers = handlerMap.get("tool_call");
        if (rawHandlers !== undefined && !Array.isArray(rawHandlers))
            return null;

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
    deps: RunnerPatchDeps = {},
): boolean {
    updateRunnerPatchDeps(deps);
    const state = getMutableRuntimeState();
    if (state.installed) return state.compatible;

    if (!isExtensionRunnerConstructor(runnerConstructor)) {
        state.compatible = false;
        recomputeEffectiveState(state);
        return false;
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
    runnerConstructor.prototype.emitToolCall = async function emitYoloToolCall(
        this: ExtensionRunner,
        event: ToolCallEvent,
    ): Promise<ToolCallEventResult | undefined> {
        const current = getMutableRuntimeState();
        const originalEmit = current.original;
        if (!originalEmit) {
            return undefined;
        }
        if (isAutopilotEnabled() && event.toolName === "ask_user_question") {
            const patchDeps = getRunnerPatchDeps();
            patchDeps.onPromptBlocked();
            patchDeps.telemetry({
                event: "prompt_blocked",
                kind: "ask_user_question",
                agentActive: true,
            });
            return {
                block: true,
                reason: "[AUTOPILOT_PROMPT_BLOCKED] Human question suppressed. Choose the safest path from current context without calling ask_user_question again. If no safe path exists, finish with autopilot_complete outcome=blocked.",
            };
        }

        const guard = isAutopilotEnabled()
            ? evaluateAutopilotGuard(event, current.config.autopilot)
            : undefined;
        if (guard) {
            completeAutopilot({
                outcome: "blocked",
                reason: `Autopilot guard: ${guard.category}`,
            });
            getRunnerPatchDeps().telemetry({
                event: "guard_blocked",
                category: guard.category,
                toolName: guard.toolName,
            });
            return {
                block: true,
                reason: `[AUTOPILOT_GUARD_BLOCKED] Autopilot guard blocked ${guard.category === "irreversible_delete" ? "irreversible deletion" : guard.category} via ${guard.toolName}. Finish with autopilot_complete outcome=blocked or choose a safe reversible path.`,
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
            reportIncompatibility(this, "extension collection shape changed");
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
    return true;
}
