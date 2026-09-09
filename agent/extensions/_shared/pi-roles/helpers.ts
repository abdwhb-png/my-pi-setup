import { readFileSync } from "node:fs";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { getSettingsValue, type GetSettingsOptions } from "../settings.ts";
import { findLatestActiveRoleState, type ActiveRoleState } from "./protocol.ts";

export function getDefaultRole(options?: GetSettingsOptions): string {
    return getSettingsValue("pi-roles.defaultRole", "pi-agent", options);
}

export function readFrontmatter<
    T extends Record<string, unknown> = Record<string, unknown>,
>(path: string): T | null {
    try {
        const raw = readFileSync(path, "utf-8");
        const { frontmatter } = parseFrontmatter<T>(raw);
        return frontmatter;
    } catch {
        return null;
    }
}

export function getActiveRole(
    entries: ReadonlyArray<{
        type: string;
        customType?: string;
        data?: unknown;
    }>,
): ActiveRoleState | null {
    return findLatestActiveRoleState(entries);
}

export function parseCommaList(raw: string | undefined): string[] {
    if (!raw || !raw.trim()) return [];
    return raw
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
}
