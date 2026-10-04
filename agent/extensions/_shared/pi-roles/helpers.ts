import { readFileSync } from "node:fs";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { readExtensionConfig } from "../config-loader.ts";
import { getSettingsValue, type GetSettingsOptions } from "../settings.ts";
import { findLatestActiveRoleState, type ActiveRoleState } from "./protocol.ts";

export function getDefaultRole(options?: GetSettingsOptions): string {
    if (options?.path)
        return getSettingsValue("defaultRole", "pi-agent", options);
    const raw = readExtensionConfig("roles", { scope: "global" });
    return raw &&
        typeof raw === "object" &&
        "defaultRole" in raw &&
        typeof raw.defaultRole === "string"
        ? raw.defaultRole
        : "pi-agent";
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
