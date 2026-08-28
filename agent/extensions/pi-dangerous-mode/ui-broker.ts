import {
    ExtensionRunner,
    InteractiveMode,
    type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { setUiBrokerCompatibility } from "./runtime-state.ts";
import type { AutopilotTelemetryEvent } from "./telemetry.ts";

export type AutopilotPromptKind =
    | "select"
    | "confirm"
    | "input"
    | "editor"
    | "custom";

const BLOCKED_MESSAGE =
    "Human UI suppressed by Autopilot. Choose a safe non-interactive path and do not repeat the same prompt.";

export class AutopilotPromptBlockedError extends Error {
    readonly code = "AUTOPILOT_PROMPT_BLOCKED";

    constructor(
        readonly kind: AutopilotPromptKind,
        summary: string,
    ) {
        super(summary);
        this.name = "AutopilotPromptBlockedError";
    }
}

export interface UiBrokerDeps {
    isEnabled(): boolean;
    isAgentActive(): boolean;
    onBlocked(
        event: AutopilotTelemetryEvent & { event: "prompt_blocked" },
    ): void;
}

type ExtensionMode = "tui" | "rpc" | "json" | "print";
type RunnerInstance = InstanceType<typeof ExtensionRunner>;
interface InteractiveModeLike {
    createExtensionUIContext(): ExtensionUIContext;
}

type SetUIContext = (
    this: RunnerInstance,
    uiContext?: ExtensionUIContext,
    mode?: ExtensionMode,
) => void;
type CreateUIContext = (this: InteractiveModeLike) => ExtensionUIContext;

interface UiBrokerState {
    deps: UiBrokerDeps;
    runnerOriginals: WeakMap<object, SetUIContext>;
    interactiveOriginals: WeakMap<object, CreateUIContext>;
    wrappedContexts: WeakMap<ExtensionUIContext, ExtensionUIContext>;
    proxyContexts: WeakSet<object>;
}

const STATE_KEY = Symbol.for("pi-dangerous-mode.ui-broker");
type UiBrokerGlobal = typeof globalThis & {
    [STATE_KEY]?: UiBrokerState;
};

const DISABLED_DEPS: UiBrokerDeps = {
    isEnabled: () => false,
    isAgentActive: () => false,
    onBlocked: () => undefined,
};

function createState(): UiBrokerState {
    return {
        deps: DISABLED_DEPS,
        runnerOriginals: new WeakMap(),
        interactiveOriginals: new WeakMap(),
        wrappedContexts: new WeakMap(),
        proxyContexts: new WeakSet(),
    };
}

function getState(): UiBrokerState {
    const globals = globalThis as UiBrokerGlobal;
    globals[STATE_KEY] ??= createState();
    return globals[STATE_KEY];
}

function prototypeFrom(value: unknown): object | undefined {
    if (typeof value !== "function") return undefined;
    const prototype = Object.getOwnPropertyDescriptor(value, "prototype")
        ?.value;
    return typeof prototype === "object" && prototype !== null
        ? prototype
        : undefined;
}

function promptKind(property: PropertyKey): AutopilotPromptKind | undefined {
    if (
        property === "select" ||
        property === "confirm" ||
        property === "input" ||
        property === "editor" ||
        property === "custom"
    ) {
        return property;
    }
    return undefined;
}

function assertPromptAllowed(kind: AutopilotPromptKind): void {
    const deps = getState().deps;
    const agentActive = deps.isAgentActive();
    if (!deps.isEnabled()) return;
    if (kind === "custom" && !agentActive) return;

    deps.onBlocked({ event: "prompt_blocked", kind, agentActive });
    throw new AutopilotPromptBlockedError(kind, BLOCKED_MESSAGE);
}

function wrapUiContext(uiContext: ExtensionUIContext): ExtensionUIContext {
    const state = getState();
    if (state.proxyContexts.has(uiContext)) return uiContext;

    const existing = state.wrappedContexts.get(uiContext);
    if (existing) return existing;

    const proxy = new Proxy(uiContext, {
        get(target, property) {
            const value = Reflect.get(target, property, target);
            if (typeof value !== "function") return value;

            const kind = promptKind(property);
            if (kind) {
                return async (...args: never[]) => {
                    assertPromptAllowed(kind);
                    return value.apply(target, args);
                };
            }
            return value.bind(target);
        },
    });
    state.wrappedContexts.set(uiContext, proxy);
    state.proxyContexts.add(proxy);
    return proxy;
}

function isSetUIContext(value: unknown): value is SetUIContext {
    return typeof value === "function";
}

function isCreateUIContext(value: unknown): value is CreateUIContext {
    return typeof value === "function";
}

function patchRunner(runnerConstructor: unknown): boolean {
    const prototype = prototypeFrom(runnerConstructor);
    if (!prototype) return false;

    const state = getState();
    if (state.runnerOriginals.has(prototype)) return true;

    const descriptor = Object.getOwnPropertyDescriptor(
        prototype,
        "setUIContext",
    );
    const original: unknown = descriptor?.value;
    if (!isSetUIContext(original) || !descriptor) return false;

    state.runnerOriginals.set(prototype, original);
    Object.defineProperty(prototype, "setUIContext", {
        ...descriptor,
        value: function setAutopilotUIContext(
            this: RunnerInstance,
            uiContext?: ExtensionUIContext,
            mode?: ExtensionMode,
        ): void {
            const currentOriginal = getState().runnerOriginals.get(prototype);
            if (!currentOriginal) return;
            currentOriginal.call(
                this,
                uiContext ? wrapUiContext(uiContext) : undefined,
                mode,
            );
        },
    });
    return true;
}

function patchInteractiveMode(interactiveConstructor: unknown): boolean {
    const prototype = prototypeFrom(interactiveConstructor);
    if (!prototype) return false;

    const state = getState();
    if (state.interactiveOriginals.has(prototype)) return true;

    const descriptor = Object.getOwnPropertyDescriptor(
        prototype,
        "createExtensionUIContext",
    );
    const original: unknown = descriptor?.value;
    if (!isCreateUIContext(original) || !descriptor) return false;

    state.interactiveOriginals.set(prototype, original);
    Object.defineProperty(prototype, "createExtensionUIContext", {
        ...descriptor,
        value: function createAutopilotUIContext(
            this: InteractiveModeLike,
        ) {
            const currentOriginal =
                getState().interactiveOriginals.get(prototype);
            if (!currentOriginal) {
                throw new Error(
                    "Autopilot UI broker lost InteractiveMode original.",
                );
            }
            return wrapUiContext(currentOriginal.call(this));
        },
    });
    return true;
}

export function installUiBrokerPatches(
    deps: UiBrokerDeps,
    constructors: {
        runner?: unknown;
        interactiveMode?: unknown;
    } = {},
): boolean {
    const state = getState();
    state.deps = deps;

    const runnerCompatible = patchRunner(
        constructors.runner ?? ExtensionRunner,
    );
    const interactiveCompatible = patchInteractiveMode(
        constructors.interactiveMode ?? InteractiveMode,
    );
    const compatible = runnerCompatible && interactiveCompatible;
    setUiBrokerCompatibility(compatible);
    return compatible;
}
