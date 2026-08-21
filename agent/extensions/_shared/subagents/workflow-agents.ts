import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    registerAgent,
    type RegisterRuntimeAgentInput,
    type RuntimeAgentDefinition,
} from "pi-subagents/agents";
import { getSettingsValue } from "../settings.ts";

/**
 * Gate workflow-specific subagents behind the active workflow lifecycle.
 *
 * pi-subagents exposes a public runtime agent registry (`registerAgent`).
 * Agents registered there are merged into runtime-aware discovery (used by the
 * subagent executor), so they resolve by name during dispatch — but they are
 * NOT statically discovered, so they disappear from the agent selector outside
 * the active workflow. `_shared` is the only layer that imports pi-subagents;
 * workflow extensions import this module instead.
 *
 * The public API does not expose `listRuntimeAgentConfigs`, so this module keeps
 * its own per-pi registry of what it registered to answer
 * `isAgentRuntimeRegistered` (used by brainstorm-forcer's preflight, which must
 * not resolve a runtime-registered agent through the static discovery path).
 */ type RegisterableEntry = {
    name: string;
    definition: RuntimeAgentDefinition;
};

export type WorkflowAgentEntry = RegisterableEntry;

/** Mutable override fields a caller may supply from settings.json agentOverrides.
 * Extends {@link RuntimeAgentDefinition} with the settings.json `turnBudget`
 * key, which maps to the runtime `defaultTurnBudget` field. */
export type WorkflowAgentOverrides = Partial<RuntimeAgentDefinition> & {
    turnBudget?: RuntimeAgentDefinition["defaultTurnBudget"];
};

type RegisterWorkflowAgentsOptions = {
    /**
     * Per-agent override map (e.g. `subagents.agentOverrides` from
     * settings.json). Each entry is merged onto the runtime definition before
     * registration, without mutating the caller's base object. Enables
     * overriding model/fallbacks/thinking/etc. from settings even though the
     * agent is no longer statically discovered. Falls back gracefully when
     * omitted or when an agent has no entry.
     */
    overrides?: Readonly<Record<string, WorkflowAgentOverrides>>;
};

type RegistrationRecord = {
    dispose(): void;
};

interface WorkflowAgentRegistry {
    byPi: WeakMap<ExtensionAPI, Map<string, RegistrationRecord>>;
}

const REGISTRY_KEY = Symbol.for("pi-subagents.workflow-agents.v1");

function registry(): WorkflowAgentRegistry {
    const globalObject = globalThis as Record<PropertyKey, unknown>;
    const existing = globalObject[REGISTRY_KEY];
    if (existing && typeof existing === "object" && "byPi" in existing) {
        const candidate = existing as { byPi: unknown };
        if (candidate.byPi instanceof WeakMap) {
            return candidate as unknown as WorkflowAgentRegistry;
        }
    }
    const created: WorkflowAgentRegistry = { byPi: new WeakMap() };
    globalObject[REGISTRY_KEY] = created;
    return created;
}

function agentsFor(pi: ExtensionAPI): Map<string, RegistrationRecord> {
    let byName = registry().byPi.get(pi);
    if (!byName) {
        byName = new Map();
        registry().byPi.set(pi, byName);
    }
    return byName;
}

export function isAgentRuntimeRegistered(
    pi: ExtensionAPI,
    name: string,
): boolean {
    return agentsFor(pi).has(name);
}

/**
 * Refcounted lifecycle gate: registers the workflow agents when the first run
 * acquires, disposes when the last run releases. Safe for concurrent runs and
 * resume-after-restart (a resumed run re-acquires on start). The returned
 * handle must be paired with the caller's run lifecycle.
 */
export function createWorkflowAgentGate(
    pi: ExtensionAPI,
    entries: readonly RegisterableEntry[],
): { acquire(): void; release(): void } {
    void agentsFor(pi);
    let refCount = 0;
    let handle: { dispose(): void } | null = null;
    return {
        acquire() {
            refCount += 1;
            if (handle) return;
            handle = registerWorkflowAgents(pi, entries);
        },
        release() {
            if (refCount <= 0) return; // no active run
            refCount -= 1;
            if (refCount !== 0) return; // other runs still active
            handle?.dispose();
            handle = null;
        },
    };
}

/**
 * Reads `subagents.agentOverrides` from settings.json (see
 * {@link getSettingsValue}). Used so runtime-registered agents still honor
 * their settings.json overrides (model/fallbacks/…) even though they are no
 * longer statically discovered.
 */
function settingsOverrides():
    | Record<string, WorkflowAgentOverrides>
    | undefined {
    const raw = getSettingsValue<unknown>("subagents.agentOverrides", {});
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        return undefined;
    // Values are the override objects; passthrough as-is.
    return raw as Record<string, WorkflowAgentOverrides>;
}

function resolveOverrides(
    options: RegisterWorkflowAgentsOptions,
): Readonly<Record<string, WorkflowAgentOverrides>> | undefined {
    if (options.overrides) return options.overrides;
    return settingsOverrides();
}

function withOverride(
    base: RuntimeAgentDefinition,
    override: WorkflowAgentOverrides | undefined,
): RuntimeAgentDefinition {
    if (!override || Object.keys(override).length === 0) return base;
    // Map settings.json agentOverride keys onto their RuntimeAgentDefinition
    // counterparts, dropping keys that have no runtime equivalent. The only
    // rename is `turnBudget` (settings) -> `defaultTurnBudget` (runtime); all
    // other supported override keys (model, fallbackModels, thinking, tools,
    // subagentOnlyExtensions, ...) already share names. Base is never mutated.
    const { turnBudget: rawTurnBudget, ...rest } = override as Record<
        string,
        unknown
    >;
    const mapped = { ...rest };
    if (rawTurnBudget !== undefined && rawTurnBudget !== null) {
        mapped.defaultTurnBudget =
            rawTurnBudget as RuntimeAgentDefinition["defaultTurnBudget"];
    }
    return { ...base, ...mapped } as RuntimeAgentDefinition;
}

export function registerWorkflowAgents(
    pi: ExtensionAPI,
    entries: readonly RegisterableEntry[],
    options: RegisterWorkflowAgentsOptions = {},
): { dispose(): void } {
    const byName = agentsFor(pi);
    const owned: Array<{ name: string; dispose(): void }> = [];
    const overrides = resolveOverrides(options);
    for (const entry of entries) {
        if (byName.has(entry.name)) continue; // idempotent: already registered
        const definition = withOverride(
            entry.definition,
            overrides?.[entry.name],
        );
        const input: RegisterRuntimeAgentInput = {
            pi: pi as unknown as RegisterRuntimeAgentInput["pi"],
            name: entry.name,
            definition,
        };
        const registration = registerAgent(input);
        byName.set(entry.name, registration);
        owned.push({ name: entry.name, dispose: registration.dispose });
    }
    let disposed = false;
    return {
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const entry of owned) {
                const current = byName.get(entry.name);
                if (current) {
                    byName.delete(entry.name);
                    entry.dispose();
                }
            }
        },
    };
}
