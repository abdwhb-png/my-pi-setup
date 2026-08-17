import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface GetSettingsOptions {
    path?: string;
}

const DEFAULT_AGENT_DIR = getAgentDir();

/**
 * Get a value from settings.json using dot-notation key path.
 *
 * @param keyPath - Dot-notation path (e.g., "pi-roles.defaultRole")
 * @param defaultValue - Value returned if key not found or file unreadable
 * @param options.path - Optional custom settings.json path (defaults to ~/.pi/agent/settings.json)
 *
 * @example
 * ```ts
 * const role = getSettingsValue("pi-roles.defaultRole", "pi-agent");
 * ```
 */
export function getSettingsValue<T>(
    keyPath: string,
    defaultValue: T,
    options?: GetSettingsOptions,
): T {
    const settingsPath =
        options?.path ?? join(DEFAULT_AGENT_DIR, "settings.json");

    if (!existsSync(settingsPath)) {
        return defaultValue;
    }

    try {
        const raw = readFileSync(settingsPath, "utf-8");
        const parsed = JSON.parse(raw) as SettingsObject;
        const value = getNestedValue(parsed, keyPath);
        return (value ?? defaultValue) as T;
    } catch {
        return defaultValue;
    }
}

/** A record of string keys to boolean values. */
export type BooleanMap = Record<string, boolean>;

/**
 * Normalize a raw JSON value into a {@link BooleanMap}.
 *
 * Rejects non-object inputs (null, arrays, primitives) by returning an empty
 * object, then keeps only entries whose value is a boolean. Shared by
 * extensions that map tool/feature names to boolean flags (e.g. slow-mode).
 *
 * @param raw - Raw parsed JSON value (object, array, primitive, null)
 * @returns Filtered {@link BooleanMap}; empty object on any invalid input
 */
export function normalizeBooleanMap(raw: unknown): BooleanMap {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return {};
    }
    const result: BooleanMap = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === "boolean") {
            result[key] = value;
        }
    }
    return result;
}

interface SettingsObject {
    [key: string]: SettingsPrimitive | SettingsObject | SettingsObject[];
}
type SettingsPrimitive = string | number | boolean | null;

function getNestedValue(
    obj: SettingsObject,
    path: string,
): SettingsPrimitive | SettingsObject | SettingsObject[] | undefined {
    const parts = path.split(".");
    let current: SettingsPrimitive | SettingsObject | SettingsObject[] = obj;

    for (const part of parts) {
        if (
            typeof current !== "object" ||
            current === null ||
            Array.isArray(current)
        ) {
            return undefined;
        }
        const next:
            | SettingsPrimitive
            | SettingsObject
            | SettingsObject[]
            | undefined = current[part];
        if (next === undefined) {
            return undefined;
        }
        current = next;
    }

    return current;
}
