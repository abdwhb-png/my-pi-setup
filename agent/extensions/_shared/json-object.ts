import { readFileSync } from "node:fs";

export function asJsonObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Expected a JSON object");
    return value as Record<string, unknown>;
}

export function readJsonObject(path: string): Record<string, unknown> {
    return asJsonObject(JSON.parse(readFileSync(path, "utf8")));
}
