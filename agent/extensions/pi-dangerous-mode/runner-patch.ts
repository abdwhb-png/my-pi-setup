import * as Pi from "@earendil-works/pi-coding-agent";
import type {
    ExtensionContext,
    ToolCallEvent,
    ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { matchesExtension, matchesTool, type YoloConfig } from "./config.ts";

type ExtensionRunner = InstanceType<typeof Pi.ExtensionRunner>;
type ExtensionRunnerConstructor = typeof Pi.ExtensionRunner;

type EmitToolCall = (
    this: ExtensionRunner,
    event: ToolCallEvent,
) => Promise<ToolCallEventResult | undefined>;

type ToolCallHandler = (
    event: ToolCallEvent,
    ctx: ExtensionContext,
) => Promise<ToolCallEventResult | void> | ToolCallEventResult | void;

type RuntimeExtension = {
    path: string;
    handlers: ToolCallHandler[];
};

type DangerousRuntimeState = {
    installed: boolean;
    compatible: boolean;
    configValid: boolean;
    incompatibilityReported: boolean;
    original?: EmitToolCall;
    enabled: boolean;
    override: boolean | undefined;
    config: YoloConfig;
};

const STATE_KEY = Symbol.for("pi-dangerous-mode.state");

function defaultState(): DangerousRuntimeState {
    return {
        installed: false,
        compatible: true,
        configValid: true,
        incompatibilityReported: false,
        enabled: false,
        override: undefined,
        config: { protectedTools: [], protectedExtensions: [] },
    };
}

function getState(): DangerousRuntimeState {
    const globals = globalThis as Record<symbol, unknown>;
    const existing = globals[STATE_KEY];
    if (isState(existing)) return existing;

    const state = defaultState();
    globals[STATE_KEY] = state;
    return state;
}

function isState(value: unknown): value is DangerousRuntimeState {
    return typeof value === "object" && value !== null && "installed" in value;
}

function getRuntimeExtensions(
    runner: ExtensionRunner,
): RuntimeExtension[] | null {
    const rawExtensions = Reflect.get(runner, "extensions");
    if (!Array.isArray(rawExtensions)) return null;

    const extensions: RuntimeExtension[] = [];
    for (const rawExtension of rawExtensions) {
        if (typeof rawExtension !== "object" || rawExtension === null)
            return null;

        const path = Reflect.get(rawExtension, "path");
        const handlerMap = Reflect.get(rawExtension, "handlers");
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

    const prototype = Reflect.get(value, "prototype");
    if (typeof prototype !== "object" || prototype === null) return false;

    return (
        isEmitToolCall(
            Object.getOwnPropertyDescriptor(prototype, "emitToolCall")?.value,
        ) && typeof Reflect.get(prototype, "createContext") === "function"
    );
}

function reportIncompatibility(runner: ExtensionRunner, reason: string): void {
    const state = getState();
    state.enabled = false;
    state.compatible = false;
    if (state.incompatibilityReported) return;

    state.incompatibilityReported = true;
    runner.emitError({
        extensionPath: "pi-dangerous-mode",
        event: "tool_call",
        error: `Dangerous mode disabled: incompatible ExtensionRunner (${reason}).`,
    });
}

export function setDangerousRuntimeState(input: {
    enabled: boolean;
    config: YoloConfig;
}): void {
    const state = getState();
    state.configValid = true;
    state.enabled = input.enabled && state.compatible;
    state.config = {
        protectedTools: [...input.config.protectedTools],
        protectedExtensions: [...input.config.protectedExtensions],
    };
}

export function isDangerousEnabled(): boolean {
    return getState().enabled;
}

export function startDangerousSession(input: {
    isReload: boolean;
    flagEnabled: boolean;
    config: YoloConfig;
}): void {
    const state = getState();
    if (!input.isReload) state.override = undefined;
    state.config = {
        protectedTools: [...input.config.protectedTools],
        protectedExtensions: [...input.config.protectedExtensions],
    };
    state.configValid = true;
    state.enabled = state.compatible && (state.override ?? input.flagEnabled);
}

export function disableForInvalidConfig(): void {
    const state = getState();
    state.configValid = false;
    state.enabled = false;
    state.config = {
        protectedTools: [],
        protectedExtensions: [],
    };
}

export function setSessionOverride(enabled: boolean): boolean {
    const state = getState();
    if (enabled && (!state.compatible || !state.configValid)) return false;

    state.override = enabled;
    state.enabled = state.compatible && state.configValid && enabled;
    return true;
}

export function getStatus(): {
    enabled: boolean;
    compatible: boolean;
    config: YoloConfig;
} {
    const state = getState();
    return {
        enabled: state.enabled,
        compatible: state.compatible,
        config: {
            protectedTools: [...state.config.protectedTools],
            protectedExtensions: [...state.config.protectedExtensions],
        },
    };
}

export function installRunnerPatch(
    runnerConstructor: unknown = Pi.ExtensionRunner,
): boolean {
    const state = getState();
    if (state.installed) return state.compatible;

    if (!isExtensionRunnerConstructor(runnerConstructor)) {
        state.compatible = false;
        state.enabled = false;
        return false;
    }

    const original = Object.getOwnPropertyDescriptor(
        runnerConstructor.prototype,
        "emitToolCall",
    )?.value;
    if (!isEmitToolCall(original)) {
        state.compatible = false;
        state.enabled = false;
        return false;
    }

    state.compatible = true;
    state.original = original;
    runnerConstructor.prototype.emitToolCall = async function emitYoloToolCall(
        this: ExtensionRunner,
        event: ToolCallEvent,
    ): Promise<ToolCallEventResult | undefined> {
        const current = getState();
        const originalEmit = current.original;
        if (!originalEmit) {
            return undefined;
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
