import type {
    ExtensionRunner,
    ToolCallEvent,
    ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
    DEFAULT_AUTOPILOT,
    type DangerousModeConfig,
    type YoloConfig,
} from "./config.ts";

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

export type AutopilotBudgetStopReason =
    | "turn_budget"
    | "retry_budget"
    | "time_budget";

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

export interface AutopilotBudgetRemaining {
    turns: number;
    retries: number;
    milliseconds: number;
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
    lastTurnHadError: boolean;
    startedAt?: number;
    stopReason?: string;
    config: DangerousModeConfig;
}

const STATE_KEY = Symbol.for("pi-dangerous-mode.state");
type RuntimeStateGlobal = typeof globalThis & {
    [STATE_KEY]?: DangerousRuntimeState;
};

function cloneAutopilotConfig(
    config: DangerousModeConfig["autopilot"] = DEFAULT_AUTOPILOT,
): DangerousModeConfig["autopilot"] {
    return {
        ...config,
        guardedTools: [...config.guardedTools],
        guardedCommands: [...config.guardedCommands],
    };
}

function cloneConfig(
    config: YoloConfig | DangerousModeConfig,
): DangerousModeConfig {
    return {
        protectedTools: [...config.protectedTools],
        protectedExtensions: [...config.protectedExtensions],
        autopilot: cloneAutopilotConfig(
            "autopilot" in config ? config.autopilot : DEFAULT_AUTOPILOT,
        ),
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
        override: undefined,
        autopilotFlag: false,
        autopilotOverride: undefined,
        autopilotEffective: false,
        autopilotPhase: "inactive",
        turnsUsed: 0,
        retriesUsed: 0,
        lastTurnHadError: false,
        config: cloneConfig({
            protectedTools: [],
            protectedExtensions: [],
        }),
    };
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
    state.lastTurnHadError ??= false;
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

function isTerminalPhase(phase: AutopilotPhase): boolean {
    return (
        phase === "completed" ||
        phase === "blocked" ||
        phase === "budget_exhausted"
    );
}

function resetAutopilotRun(state: DangerousRuntimeState, now: number): void {
    state.autopilotPhase = "inactive";
    state.turnsUsed = 0;
    state.retriesUsed = 0;
    state.lastTurnHadError = false;
    state.startedAt = now;
    state.stopReason = undefined;
}

export function recomputeEffectiveState(
    state: DangerousRuntimeState = getMutableRuntimeState(),
): void {
    const directDangerous = state.override ?? state.dangerousFlag;
    const autopilotRequested = state.autopilotOverride ?? state.autopilotFlag;
    state.autopilotEffective =
        state.configValid &&
        state.compatible &&
        state.uiBrokerCompatible &&
        autopilotRequested &&
        !isTerminalPhase(state.autopilotPhase);
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

export function startRuntimeSession(input: {
    isReload: boolean;
    dangerousFlag: boolean;
    autopilotFlag: boolean;
    config: DangerousModeConfig;
    now: number;
}): void {
    const state = getMutableRuntimeState();
    if (!input.isReload) {
        state.override = undefined;
        state.autopilotOverride = undefined;
        resetAutopilotRun(state, input.now);
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
        (!state.compatible || !state.uiBrokerCompatible || !state.configValid)
    ) {
        return false;
    }

    if (enabled && !state.autopilotEffective) resetAutopilotRun(state, now);
    state.autopilotOverride = enabled;
    recomputeEffectiveState(state);
    return true;
}

export function isDangerousEnabled(): boolean {
    return getMutableRuntimeState().enabled;
}

export function isAutopilotEnabled(): boolean {
    return getMutableRuntimeState().autopilotEffective;
}

export function setUiBrokerCompatibility(compatible: boolean): void {
    const state = getMutableRuntimeState();
    state.uiBrokerCompatible = compatible;
    recomputeEffectiveState(state);
}

export function budgetStopReason(
    now: number,
): AutopilotBudgetStopReason | undefined {
    const state = getMutableRuntimeState();
    const budgets = state.config.autopilot;
    if (state.turnsUsed >= budgets.maxTurns) return "turn_budget";
    if (state.retriesUsed >= budgets.maxRetries) return "retry_budget";
    if (
        state.startedAt !== undefined &&
        now - state.startedAt >= budgets.maxDurationMs
    ) {
        return "time_budget";
    }
    return undefined;
}

export function getAutopilotBudgetRemaining(
    now: number,
): AutopilotBudgetRemaining {
    const state = getMutableRuntimeState();
    const budgets = state.config.autopilot;
    return {
        turns: Math.max(0, budgets.maxTurns - state.turnsUsed),
        retries: Math.max(0, budgets.maxRetries - state.retriesUsed),
        milliseconds: Math.max(
            0,
            budgets.maxDurationMs -
                (state.startedAt === undefined ? 0 : now - state.startedAt),
        ),
    };
}

export function recordAutopilotTurn(input: {
    hadError: boolean;
    now: number;
}): void {
    const state = getMutableRuntimeState();
    if (!state.autopilotEffective || state.autopilotPhase !== "running") {
        return;
    }

    state.turnsUsed += 1;
    state.lastTurnHadError = input.hadError;
    if (input.hadError) state.retriesUsed += 1;

    const stopReason = budgetStopReason(input.now);
    if (!stopReason) return;

    state.autopilotPhase = "budget_exhausted";
    state.stopReason = stopReason;
    recomputeEffectiveState(state);
}

export function completeAutopilot(input: {
    outcome: "completed" | "blocked";
    reason: string;
}): void {
    const state = getMutableRuntimeState();
    if (state.autopilotPhase !== "running") return;

    state.autopilotPhase = input.outcome;
    state.stopReason = input.reason;
    recomputeEffectiveState(state);
}

export function didLastAutopilotTurnFail(): boolean {
    return getMutableRuntimeState().lastTurnHadError;
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
        config: cloneConfig(input.config),
        now: Date.now(),
    });
}

export function disableForInvalidConfig(): void {
    const state = getMutableRuntimeState();
    state.configValid = false;
    state.config = cloneConfig({
        protectedTools: [],
        protectedExtensions: [],
    });
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
        config: {
            protectedTools: [...state.config.protectedTools],
            protectedExtensions: [...state.config.protectedExtensions],
        },
    };
}
