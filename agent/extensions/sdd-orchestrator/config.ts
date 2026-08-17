import { loadExtensionConfig } from "../_shared/config-loader.ts";

const AGENT_KEYS = [
    "assessor",
    "quickWorker",
    "worker",
    "qaTester",
    "browserTester",
    "combinedReviewer",
    "specReviewer",
    "qualityReviewer",
] as const;
type AgentKey = (typeof AGENT_KEYS)[number];
type ValidationAgentKey = "qaTester" | "browserTester";
type CoreAgentKey = Exclude<AgentKey, ValidationAgentKey>;
const TIMEOUT_KEYS = ["assessor", "worker", "reviewer"] as const;
type TimeoutKey = (typeof TIMEOUT_KEYS)[number];

export interface SddConfig {
    agents: Record<CoreAgentKey, string> &
        Partial<Record<ValidationAgentKey, string>>;
    models: Partial<Record<AgentKey, string>>;
    timeoutsMs: Record<TimeoutKey, number>;
    maxConcurrentWriters: number;
    structuredOutputRetries: number;
}

interface ConfigLayer {
    agents: Partial<SddConfig["agents"]>;
    models: SddConfig["models"];
    timeoutsMs: Partial<SddConfig["timeoutsMs"]>;
    maxConcurrentWriters: number;
    structuredOutputRetries: number;
}

const DEFAULT_CONFIG: SddConfig = {
    agents: {
        assessor: "orchestration-assessor",
        quickWorker: "quick-worker",
        worker: "sdd-worker",
        qaTester: "sdd-qa-tester",
        browserTester: "browser-tester",
        combinedReviewer: "sdd-combined-reviewer",
        specReviewer: "sdd-spec-reviewer",
        qualityReviewer: "sdd-quality-reviewer",
    },
    models: {},
    timeoutsMs: {
        assessor: 600_000,
        worker: 2_700_000,
        reviewer: 900_000,
    },
    maxConcurrentWriters: 2,
    structuredOutputRetries: 1,
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerInRange(
    value: unknown,
    minimum: number,
    maximum: number,
): value is number {
    return (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= minimum &&
        value <= maximum
    );
}

function normalizeConfig(raw: unknown): Partial<ConfigLayer> {
    if (!isRecord(raw)) return {};
    const normalized: Partial<ConfigLayer> = {};

    if (isRecord(raw.agents)) {
        const agents: ConfigLayer["agents"] = {};
        for (const key of AGENT_KEYS) {
            const value = raw.agents[key];
            if (typeof value === "string" && value.trim()) {
                agents[key] = value.trim();
            }
        }
        if (Object.keys(agents).length) normalized.agents = agents;
    }
    if (isRecord(raw.models)) {
        const models: ConfigLayer["models"] = {};
        for (const key of AGENT_KEYS) {
            const value = raw.models[key];
            if (typeof value === "string" && value.trim()) {
                models[key] = value.trim();
            }
        }
        if (Object.keys(models).length) normalized.models = models;
    }
    if (isRecord(raw.timeoutsMs)) {
        const timeoutsMs: ConfigLayer["timeoutsMs"] = {};
        for (const key of TIMEOUT_KEYS) {
            const value = raw.timeoutsMs[key];
            if (isIntegerInRange(value, 1, Number.MAX_SAFE_INTEGER)) {
                timeoutsMs[key] = value;
            }
        }
        if (Object.keys(timeoutsMs).length) normalized.timeoutsMs = timeoutsMs;
    }
    if (isIntegerInRange(raw.maxConcurrentWriters, 1, 4)) {
        normalized.maxConcurrentWriters = raw.maxConcurrentWriters;
    }
    if (isIntegerInRange(raw.structuredOutputRetries, 0, 1)) {
        normalized.structuredOutputRetries = raw.structuredOutputRetries;
    }
    return normalized;
}

function mergeConfig(
    base: ConfigLayer,
    overlay: Partial<ConfigLayer>,
): ConfigLayer {
    return {
        agents: { ...base.agents, ...overlay.agents },
        models: { ...base.models, ...overlay.models },
        timeoutsMs: { ...base.timeoutsMs, ...overlay.timeoutsMs },
        maxConcurrentWriters:
            overlay.maxConcurrentWriters ?? base.maxConcurrentWriters,
        structuredOutputRetries:
            overlay.structuredOutputRetries ?? base.structuredOutputRetries,
    };
}

export function loadSddConfig(cwd: string, agentDir?: string): SddConfig {
    const config = loadExtensionConfig<ConfigLayer>(cwd, {
        defaults: DEFAULT_CONFIG,
        normalize: normalizeConfig,
        merge: mergeConfig,
        sources: [{ settingsKey: "sddOrchestrator" }],
        agentDir,
    });
    return {
        ...config,
        agents: { ...DEFAULT_CONFIG.agents, ...config.agents },
        models: { ...config.models },
        timeoutsMs: { ...DEFAULT_CONFIG.timeoutsMs, ...config.timeoutsMs },
    };
}
