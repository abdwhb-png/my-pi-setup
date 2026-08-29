import {
    ExtensionRunner,
    InteractiveMode,
    type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

export type ExtensionUiPromptKind =
    | "select"
    | "confirm"
    | "input"
    | "editor"
    | "custom";

export type ExtensionUiPromptGuard = (kind: ExtensionUiPromptKind) => void;
export type ExtensionUiPromptObserver = (
    kind: ExtensionUiPromptKind,
) => void | Promise<void>;

export interface ExtensionUiBrokerConstructors {
    runner?: unknown;
    interactiveMode?: unknown;
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

interface ExtensionUiBrokerState {
    guards: Map<string, ExtensionUiPromptGuard>;
    observers: Map<string, ExtensionUiPromptObserver>;
    runnerOriginals: WeakMap<object, SetUIContext>;
    interactiveOriginals: WeakMap<object, CreateUIContext>;
    wrappedContexts: WeakMap<ExtensionUIContext, ExtensionUIContext>;
    proxyContexts: WeakSet<object>;
}

interface LegacyUiBrokerDeps {
    isEnabled(): boolean;
    isAgentActive(): boolean;
    onBlocked(): void;
}

interface LegacyUiBrokerState {
    deps?: LegacyUiBrokerDeps;
    runnerOriginals?: WeakMap<object, SetUIContext>;
    interactiveOriginals?: WeakMap<object, CreateUIContext>;
}

const STATE_KEY = Symbol.for("pi.extension-ui-context-broker");
const LEGACY_STATE_KEY = Symbol.for("pi-dangerous-mode.ui-broker");
type ExtensionUiBrokerGlobal = typeof globalThis & {
    [STATE_KEY]?: ExtensionUiBrokerState;
};

function createState(): ExtensionUiBrokerState {
    return {
        guards: new Map(),
        observers: new Map(),
        runnerOriginals: new WeakMap(),
        interactiveOriginals: new WeakMap(),
        wrappedContexts: new WeakMap(),
        proxyContexts: new WeakSet(),
    };
}

function getState(): ExtensionUiBrokerState {
    const globals = globalThis as ExtensionUiBrokerGlobal;
    globals[STATE_KEY] ??= createState();
    return globals[STATE_KEY];
}

function getLegacyState(): LegacyUiBrokerState | undefined {
    const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
    const candidate = globals[LEGACY_STATE_KEY];
    return typeof candidate === "object" && candidate !== null
        ? (candidate as LegacyUiBrokerState)
        : undefined;
}

function disableLegacyBroker(): void {
    const legacyState = getLegacyState();
    if (!legacyState) return;
    legacyState.deps = {
        isEnabled: () => false,
        isAgentActive: () => false,
        onBlocked: () => undefined,
    };
}

function prototypeFrom(value: unknown): object | undefined {
    if (typeof value !== "function") return undefined;
    const prototype: unknown = Object.getOwnPropertyDescriptor(
        value,
        "prototype",
    )?.value;
    return typeof prototype === "object" && prototype !== null
        ? prototype
        : undefined;
}

function promptKind(property: PropertyKey): ExtensionUiPromptKind | undefined {
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

function runGuards(kind: ExtensionUiPromptKind): void {
    for (const guard of getState().guards.values()) {
        guard(kind);
    }
}

function runObservers(kind: ExtensionUiPromptKind): void {
    for (const observer of getState().observers.values()) {
        try {
            void Promise.resolve(observer(kind)).catch(() => undefined);
        } catch {
            // Attention observers are best-effort and must never break Pi UI.
        }
    }
}

function wrapUiContext(uiContext: ExtensionUIContext): ExtensionUIContext {
    const state = getState();
    if (state.proxyContexts.has(uiContext)) return uiContext;

    const existing = state.wrappedContexts.get(uiContext);
    if (existing) return existing;

    const proxy = new Proxy(uiContext, {
        get(target, property) {
            const value: unknown = Reflect.get(target, property, target);
            if (typeof value !== "function") return value;

            const kind = promptKind(property);
            if (kind) {
                return async (...args: unknown[]): Promise<unknown> => {
                    runGuards(kind);
                    runObservers(kind);
                    const result: unknown = value.apply(target, args);
                    return result;
                };
            }
            // Pi's UI interface contains overloaded and generic methods, so
            // binding through a Proxy loses their concrete return type here.
            // oxlint-disable-next-line typescript/no-unsafe-return
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
    const legacyOriginal = getLegacyState()?.runnerOriginals?.get(prototype);
    const original: unknown = isSetUIContext(legacyOriginal)
        ? legacyOriginal
        : descriptor?.value;
    if (!isSetUIContext(original) || !descriptor) return false;

    state.runnerOriginals.set(prototype, original);
    Object.defineProperty(prototype, "setUIContext", {
        ...descriptor,
        value: function setBrokeredUIContext(
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
    const legacyOriginal =
        getLegacyState()?.interactiveOriginals?.get(prototype);
    const original: unknown = isCreateUIContext(legacyOriginal)
        ? legacyOriginal
        : descriptor?.value;
    if (!isCreateUIContext(original) || !descriptor) return false;

    state.interactiveOriginals.set(prototype, original);
    Object.defineProperty(prototype, "createExtensionUIContext", {
        ...descriptor,
        value: function createBrokeredUIContext(this: InteractiveModeLike) {
            const currentOriginal =
                getState().interactiveOriginals.get(prototype);
            if (!currentOriginal) {
                throw new Error(
                    "Extension UI broker lost InteractiveMode original.",
                );
            }
            return wrapUiContext(currentOriginal.call(this));
        },
    });
    return true;
}

export function registerExtensionUiPromptGuard(
    ownerId: string,
    guard: ExtensionUiPromptGuard,
): () => void {
    const state = getState();
    state.guards.set(ownerId, guard);

    return () => {
        if (state.guards.get(ownerId) === guard) {
            state.guards.delete(ownerId);
        }
    };
}

export function registerExtensionUiPromptObserver(
    ownerId: string,
    observer: ExtensionUiPromptObserver,
): () => void {
    const state = getState();
    state.observers.set(ownerId, observer);

    return () => {
        if (state.observers.get(ownerId) === observer) {
            state.observers.delete(ownerId);
        }
    };
}

export function installExtensionUiBroker(
    constructors: ExtensionUiBrokerConstructors = {},
): boolean {
    disableLegacyBroker();
    const runnerCompatible = patchRunner(
        constructors.runner ?? ExtensionRunner,
    );
    const interactiveCompatible = patchInteractiveMode(
        constructors.interactiveMode ?? InteractiveMode,
    );
    return runnerCompatible && interactiveCompatible;
}
