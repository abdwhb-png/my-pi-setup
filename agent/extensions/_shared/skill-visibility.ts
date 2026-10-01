import { randomUUID } from "node:crypto";
import {
    mkdirSync,
    renameSync,
    writeFileSync,
    existsSync,
    unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadExtensionConfig } from "./config-loader.ts";
import { resolveRuntimePath, toPortableHomePath } from "./home-path.ts";

export type ToggleState = "enabled" | "disabled";
export type EditScope = "global" | "project";
export interface SkillGateConfig {
    skills: Record<string, ToggleState>;
    projects: Record<string, { skills: Record<string, ToggleState> }>;
}

// oxlint-disable-next-line typescript/no-restricted-types -- Validate untrusted JSON before assigning a configuration type.
function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
// oxlint-disable-next-line typescript/no-restricted-types -- JSON values are untyped until validated here.
function toggles(value: unknown): Record<string, ToggleState> {
    if (value === undefined) return {};
    if (!record(value)) throw new Error("Skill toggles must be an object");
    return Object.fromEntries(
        Object.entries(value).map(([name, state]) => {
            if (state !== "enabled" && state !== "disabled")
                throw new Error(`Invalid visibility for skill ${name}`);
            return [name, state];
        }),
    );
}
// oxlint-disable-next-line typescript/no-restricted-types -- loadExtensionConfig passes parsed JSON to its normalizer.
function normalizeConfig(raw: unknown): SkillGateConfig {
    if (!record(raw))
        throw new Error("Skill visibility configuration must be an object");
    if (raw.projects !== undefined && !record(raw.projects))
        throw new Error("Skill projects must be an object");
    const projects = Object.fromEntries(
        Object.entries(raw.projects ?? {}).map(([path, entry]) => {
            if (!record(entry))
                throw new Error(`Invalid skill project ${path}`);
            return [path, { skills: toggles(entry.skills) }];
        }),
    );
    return { skills: toggles(raw.skills), projects };
}

export function loadConfig(agentDir = getAgentDir()): SkillGateConfig {
    return loadExtensionConfig(homedir(), {
        agentDir,
        defaults: { skills: {}, projects: {} },
        normalize: normalizeConfig,
        sources: [
            { legacyFilename: "config/skill-gate.json", projectLocal: false },
        ],
        strict: true,
    });
}

/** Replace the file before updating the caller's state, so failed saves keep both intact. */
export function saveConfig(
    config: SkillGateConfig,
    agentDir = getAgentDir(),
): void {
    const path = join(agentDir, "config/skill-gate.json");
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, JSON.stringify(config, null, 2), {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
        });
        renameSync(temporary, path);
    } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
    }
}

function projectKeys(path: string): string[] {
    const absolute = resolveRuntimePath(path, homedir());
    return [...new Set([toPortableHomePath(absolute), absolute, path])];
}
export function loadEffectiveState(
    name: string,
    config: SkillGateConfig,
    projectPath?: string,
): { state: ToggleState; source: "global" | "project" | "default" } {
    if (projectPath) {
        for (const key of projectKeys(projectPath)) {
            const state = config.projects[key]?.skills[name];
            if (state === "enabled" || state === "disabled")
                return { state, source: "project" };
        }
    }
    const state = config.skills[name];
    return state === "enabled" || state === "disabled"
        ? { state, source: "global" }
        : { state: "enabled", source: "default" };
}

export function persistBulkToggle(
    names: string[],
    value: ToggleState,
    config: SkillGateConfig,
    scope: EditScope,
    projectPath?: string,
): number {
    if (scope === "project" && !projectPath)
        throw new Error("Project skill choices require a project path");
    const next = structuredClone(config);
    const keys = projectPath ? projectKeys(projectPath) : [];
    const key = keys[0];
    const projectSkills: Record<string, ToggleState> = Object.fromEntries(
        keys
            .toReversed()
            .flatMap((path) =>
                Object.entries(next.projects[path]?.skills ?? {}),
            ),
    );
    const target = scope === "global" ? next.skills : projectSkills;
    let changed = 0;
    for (const name of new Set(names)) {
        const inherited =
            scope === "global"
                ? "enabled"
                : loadEffectiveState(name, next).state;
        const desired = value === inherited ? undefined : value;
        if (target[name] === desired) continue;
        if (desired === undefined) delete target[name];
        else target[name] = desired;
        changed++;
    }
    if (!changed) return 0;
    if (scope === "project" && key) {
        for (const path of keys) delete next.projects[path];
        if (Object.keys(projectSkills).length)
            next.projects[key] = { skills: projectSkills };
    }
    saveConfig(next);
    Object.assign(config, next);
    return changed;
}

export function resetScope(
    config: SkillGateConfig,
    scope: EditScope,
    projectPath?: string,
): number {
    if (scope === "project" && !projectPath)
        throw new Error("Project skill choices require a project path");
    const next = structuredClone(config);
    let count = 0;
    if (scope === "global") {
        count = Object.keys(next.skills).length;
        next.skills = {};
    } else
        for (const key of projectKeys(projectPath!)) {
            count += Object.keys(next.projects[key]?.skills ?? {}).length;
            delete next.projects[key];
        }
    if (count) {
        saveConfig(next);
        Object.assign(config, next);
    }
    return count;
}
