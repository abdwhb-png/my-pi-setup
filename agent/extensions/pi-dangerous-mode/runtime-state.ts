import type {
    ExtensionRunner,
    ToolCallEvent,
    ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type { YoloConfig } from "./config.ts";

export type EmitToolCall = (
    this: ExtensionRunner,
    event: ToolCallEvent,
) => Promise<ToolCallEventResult | undefined>;

export interface RuntimeStatus {
    compatible: { runner: boolean; uiBroker: boolean };
    configValid: boolean;
    dangerous: {
        flag: boolean;
        override: boolean | undefined;
        effective: boolean;
    };
    unattended: {
        override: boolean | undefined;
        effective: boolean;
    };
}

export interface DangerousRuntimeState {
    installed: boolean;
    compatible: boolean;
    uiBrokerCompatible: boolean;
    configValid: boolean;
    incompatibilityReported: boolean;
    original?: EmitToolCall;
    enabled: boolean;
    dangerousFlag: boolean;
    dangerousOverride: boolean | undefined;
    unattendedOverride: boolean | undefined;
    unattendedEffective: boolean;
    config: YoloConfig;
}

const STATE_KEY = Symbol.for("pi-dangerous-mode.state");
type RuntimeStateGlobal = typeof globalThis & {
    [STATE_KEY]?: DangerousRuntimeState;
};

function cloneConfig(config: YoloConfig): YoloConfig {
    return {
        protectedTools: [...config.protectedTools],
        protectedExtensions: [...config.protectedExtensions],
    };
}

function defaultState(): DangerousRuntimeState {
    return {
        installed: false,
        compatible: true,
        uiBrokerCompatible: true,
        configValid: true,
        incompatibilityReported: false,
        enabled: false,
        dangerousFlag: false,
        dangerousOverride: undefined,
        unattendedOverride: undefined,
        unattendedEffective: false,
        config: { protectedTools: [], protectedExtensions: [] },
    };
}

function upgradeState(state: DangerousRuntimeState): DangerousRuntimeState {
    const legacy = state as DangerousRuntimeState & {
        override?: boolean | undefined;
    };
    state.dangerousOverride ??= legacy.override;
    state.unattendedOverride ??= undefined;
    state.unattendedEffective ??= false;
    state.config = cloneConfig(state.config);
    return state;
}

export function getMutableRuntimeState(): DangerousRuntimeState {
    const globals = globalThis as RuntimeStateGlobal;
    const existing = globals[STATE_KEY];
    if (existing) return upgradeState(existing);

    const state = defaultState();
    globals[STATE_KEY] = state;
    return state;
}

export function recomputeEffectiveState(
    state: DangerousRuntimeState = getMutableRuntimeState(),
): void {
    state.enabled =
        state.configValid &&
        state.compatible &&
        (state.dangerousOverride ?? state.dangerousFlag);
    state.unattendedEffective =
        state.configValid &&
        state.compatible &&
        state.uiBrokerCompatible &&
        state.unattendedOverride === true;
}

export function startRuntimeSession(input: {
    isReload: boolean;
    dangerousFlag: boolean;
    config: YoloConfig;
}): void {
    const state = getMutableRuntimeState();
    if (!input.isReload) {
        state.dangerousOverride = undefined;
        state.unattendedOverride = undefined;
    }
    state.dangerousFlag = input.dangerousFlag;
    state.config = cloneConfig(input.config);
    state.configValid = true;
    recomputeEffectiveState(state);
}

export function setDangerousOverride(enabled: boolean): boolean {
    const state = getMutableRuntimeState();
    if (enabled && (!state.compatible || !state.configValid)) return false;

    state.dangerousOverride = enabled;
    recomputeEffectiveState(state);
    return true;
}

export function setUnattendedOverride(enabled: boolean): boolean {
    const state = getMutableRuntimeState();
    if (
        enabled &&
        (!state.compatible || !state.uiBrokerCompatible || !state.configValid)
    ) {
        return false;
    }

    state.unattendedOverride = enabled;
    recomputeEffectiveState(state);
    return true;
}

export function isDangerousEnabled(): boolean {
    return getMutableRuntimeState().enabled;
}

export function isUnattendedEnabled(): boolean {
    return getMutableRuntimeState().unattendedEffective;
}

export function setUiBrokerCompatibility(compatible: boolean): void {
    const state = getMutableRuntimeState();
    state.uiBrokerCompatible = compatible;
    recomputeEffectiveState(state);
}

export function getRuntimeStatus(): RuntimeStatus {
    const state = getMutableRuntimeState();
    return {
        compatible: {
            runner: state.compatible,
            uiBroker: state.uiBrokerCompatible,
        },
        configValid: state.configValid,
        dangerous: {
            flag: state.dangerousFlag,
            override: state.dangerousOverride,
            effective: state.enabled,
        },
        unattended: {
            override: state.unattendedOverride,
            effective: state.unattendedEffective,
        },
    };
}

export function setDangerousRuntimeState(input: {
    enabled: boolean;
    config: YoloConfig;
}): void {
    const state = getMutableRuntimeState();
    state.configValid = true;
    state.dangerousFlag = input.enabled;
    state.dangerousOverride = undefined;
    state.unattendedOverride = undefined;
    state.config = cloneConfig(input.config);
    recomputeEffectiveState(state);
}

export function startDangerousSession(input: {
    isReload: boolean;
    flagEnabled: boolean;
    config: YoloConfig;
}): void {
    startRuntimeSession({
        isReload: input.isReload,
        dangerousFlag: input.flagEnabled,
        config: input.config,
    });
}

export function disableForInvalidConfig(): void {
    const state = getMutableRuntimeState();
    state.configValid = false;
    state.config = { protectedTools: [], protectedExtensions: [] };
    recomputeEffectiveState(state);
}

export function setSessionOverride(enabled: boolean): boolean {
    return setDangerousOverride(enabled);
}

export function getStatus(): {
    enabled: boolean;
    compatible: boolean;
    config: YoloConfig;
} {
    const state = getMutableRuntimeState();
    return {
        enabled: state.enabled,
        compatible: state.compatible,
        config: cloneConfig(state.config),
    };
}
