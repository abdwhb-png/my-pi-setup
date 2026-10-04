import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extensionPath } from "./extension-paths.ts";
import { resolveRuntimePath } from "./home-path.ts";

/** Resolve an explicitly migrated plan without changing a signed manifest's payload. */
export function resolveMigratedPlanPath(
    planPath: string,
    cwd: string,
    agentDir?: string,
): string {
    const original = resolveRuntimePath(planPath, cwd);
    const mapPath = extensionPath(
        { scope: "global", agentDir },
        "artifacts",
        "plan-path-map.json",
    );
    if (!existsSync(mapPath)) return original;
    const mappings: unknown = JSON.parse(readFileSync(mapPath, "utf8"));
    if (!mappings || typeof mappings !== "object" || Array.isArray(mappings))
        throw new Error(`Invalid migrated plan map: ${mapPath}`);
    if (!(original in mappings)) return original;
    const target = (mappings as Record<string, unknown>)[original];
    if (
        !target ||
        typeof target !== "object" ||
        !("path" in target) ||
        typeof target.path !== "string" ||
        !("sha256" in target) ||
        typeof target.sha256 !== "string"
    )
        throw new Error(`Invalid migrated plan mapping: ${original}`);
    const digest = createHash("sha256")
        .update(readFileSync(target.path))
        .digest("hex");
    if (digest !== target.sha256)
        throw new Error(`Migrated plan content changed: ${target.path}`);
    return target.path;
}
