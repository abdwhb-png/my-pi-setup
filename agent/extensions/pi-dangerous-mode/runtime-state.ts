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

export type AutopilotPhase =
    | "inactive"
    | "running"
    | "completed"
    | "blocked"
    | "budget_exhausted";

export interface AutopilotBudgets {
    maxTurns: number;
    maxRetries: number;
    maxDurationMs: number;
}

export interface RuntimeStatus {
    compatible: { runner: boolean; uiBroker: boolean };
    configValid: boolean;
    dangerous: {
        flag: boolean;
        override: boolean | undefined;
        inducedByAutopilot: boolean;
        effective: boolean;
    };
    autopilot: {
        flag: boolean;
        override: boolean | undefined;
        effective: boolean;
        phase: AutopilotPhase;
        turnsUsed: number;
        retriesUsed: number;
        startedAt?: number;
        stopReason?: string;
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
    override: boolean | undefined;
    autopilotFlag: boolean;
    autopilotOverride: boolean | undefined;
    autopilotEffective: boolean;
    autopilotPhase: AutopilotPhase;
    turnsUsed: number;
    retriesUsed: number;
    startedAt?: number;
    stopReason?: string;
    config: YoloConfig;
}

const STATE_KEY = Symbol.for("pi-dangerous-mode.state");

function defaultState(): DangerousRuntimeState {
    return {
        installed: false,
        compatible: true,
        uiBrokerCompatible: true,
        configValid: true,
        incompatibilityReported: false,
        enabled: false,
        dangerousFlag: false,
        override: undefined,
        autopilotFlag: false,
        autopilotOverride: undefined,
        autopilotEffective: false,
        autopilotPhase: "inactive",
        turnsUsed: 0,
        retriesUsed: 0,
        config: { protectedTools: [], protectedExtensions: [] },
    };
}

function isState(value: unknown): value is DangerousRuntimeState {
    return typeof value === "object" && value !== null && "installed" in value;
}

function upgradeState(state: DangerousRuntimeState): DangerousRuntimeState {
    state.uiBrokerCompatible ??= true;
    state.dangerousFlag ??= state.enabled;
    state.autopilotFlag ??= false;
    state.autopilotOverride ??= undefined;
    state.autopilotEffective ??= false;
    state.autopilotPhase ??= "inactive";
    state.turnsUsed ??= 0;
    state.retriesUsed ??= 0;
    return state;
}

export function getMutableRuntimeState(): DangerousRuntimeState {
    const globals = globalThis as Record<symbol, unknown>;
    const existing = globals[STATE_KEY];
    if (isState(existing)) return upgradeState(existing);

    const state = defaultState();
    globals[STATE_KEY] = state;
    return state;
}

export function recomputeEffectiveState(
    state: DangerousRuntimeState = getMutableRuntimeState(),
): void {
    const directDangerous = state.override ?? state.dangerousFlag;
    const autopilotRequested =
        state.autopilotOverride ?? state.autopilotFlag;
    state.autopilotEffective =
        state.configValid &&
        state.compatible &&
        state.uiBrokerCompatible &&
        autopilotRequested;
    state.enabled =
        state.configValid &&
        state.compatible &&
        (directDangerous || state.autopilotEffective);

    if (state.autopilotEffective) {
        if (state.autopilotPhase === "inactive") {
            state.autopilotPhase = "running";
        }
    } else if (state.autopilotPhase === "running") {
        state.autopilotPhase = "inactive";
    }
}

function cloneConfig(config: YoloConfig): YoloConfig {
    return {
        protectedTools: [...config.protectedTools],
        protectedExtensions: [...config.protectedExtensions],
    };
}

export function startRuntimeSession(input: {
    isReload: boolean;
    dangerousFlag: boolean;
    autopilotFlag: boolean;
    config: YoloConfig;
    now: number;
}): void {
    const state = getMutableRuntimeState();
    if (!input.isReload) {
        state.override = undefined;
        state.autopilotOverride = undefined;
        state.turnsUsed = 0;
        state.retriesUsed = 0;
        state.startedAt = undefined;
        state.stopReason = undefined;
        state.autopilotPhase = "inactive";
    }
    state.dangerousFlag = input.dangerousFlag;
    state.autopilotFlag = input.autopilotFlag;
    state.config = cloneConfig(input.config);
    state.configValid = true;
    recomputeEffectiveState(state);
    if (state.autopilotEffective && state.startedAt === undefined) {
        state.startedAt = input.now;
    }
}

export function setDangerousOverride(enabled: boolean): boolean {
    const state = getMutableRuntimeState();
    if (enabled && (!state.compatible || !state.configValid)) return false;

    state.override = enabled;
    recomputeEffectiveState(state);
    return true;
}

export function setAutopilotOverride(enabled: boolean, now: number): boolean {
    const state = getMutableRuntimeState();
    if (
        enabled &&
        (!state.compatible ||
            !state.uiBrokerCompatible ||
            !state.configValid)
    ) {
        return false;
    }

    state.autopilotOverride = enabled;
    recomputeEffectiveState(state);
    if (state.autopilotEffective && state.startedAt === undefined) {
        state.startedAt = now;
    }
    return true;
}

export function isDangerousEnabled(): boolean {
    return getMutableRuntimeState().enabled;
}

export function isAutopilotEnabled(): boolean {
    return getMutableRuntimeState().autopilotEffective;
}

export function getRuntimeStatus(): RuntimeStatus {
    const state = getMutableRuntimeState();
    const autopilot: RuntimeStatus["autopilot"] = {
        flag: state.autopilotFlag,
        override: state.autopilotOverride,
        effective: state.autopilotEffective,
        phase: state.autopilotPhase,
        turnsUsed: state.turnsUsed,
        retriesUsed: state.retriesUsed,
    };
    if (state.startedAt !== undefined) autopilot.startedAt = state.startedAt;
    if (state.stopReason !== undefined) autopilot.stopReason = state.stopReason;

    return {
        compatible: {
            runner: state.compatible,
            uiBroker: state.uiBrokerCompatible,
        },
        configValid: state.configValid,
        dangerous: {
            flag: state.dangerousFlag,
            override: state.override,
            inducedByAutopilot: state.autopilotEffective,
            effective: state.enabled,
        },
        autopilot,
    };
}

export function setDangerousRuntimeState(input: {
    enabled: boolean;
    config: YoloConfig;
}): void {
    const state = getMutableRuntimeState();
    state.configValid = true;
    state.dangerousFlag = input.enabled;
    state.override = undefined;
    state.autopilotFlag = false;
    state.autopilotOverride = undefined;
    state.autopilotPhase = "inactive";
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
        autopilotFlag: false,
        config: input.config,
        now: Date.now(),
    });
}

export function disableForInvalidConfig(): void {
    const state = getMutableRuntimeState();
    state.configValid = false;
    state.config = {
        protectedTools: [],
        protectedExtensions: [],
    };
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
