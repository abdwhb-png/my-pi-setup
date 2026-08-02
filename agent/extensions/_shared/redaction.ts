import { stripVTControlCharacters } from "node:util";

import { truncateToWidth } from "@earendil-works/pi-tui";

const SENSITIVE_KEYS = new Set(
    [
        "authorization",
        "apikey",
        "api_key",
        "token",
        "access_token",
        "refresh_token",
        "password",
        "cookie",
        "set-cookie",
        "secret",
        "privatekey",
    ].map((key) => key.toLowerCase().replaceAll("-", "")),
);

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
    /\bBearer\s+\S+/i,
    /\bsk-[A-Za-z0-9_-]{10,}\b/,
    /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
    /\b(?:export|set)\s+(?:API_KEY|API_SECRET|ACCESS_TOKEN|SECRET_KEY|PRIVATE_KEY|DB_PASSWORD)\s*=/i,
];

export interface RedactionOptions {
    maxDepth?: number;
    maxStringLength?: number;
    maxArrayItems?: number;
}

export interface RedactionCounters {
    maskedKeys: number;
    patternRedactions: number;
    truncatedStrings: number;
    truncatedArrays: number;
    depthClipped: number;
}

export interface RedactionResult {
    value: unknown;
    counters: RedactionCounters;
}

const CIRCULAR_MARKER = "[CIRCULAR]";
const REDACTED_MARKER = "[REDACTED]";
const DEPTH_CLIPPED_MARKER = "[DEPTH_CLIPPED]";

function isSensitiveKey(key: string): boolean {
    return SENSITIVE_KEYS.has(key.toLowerCase().replaceAll("-", ""));
}

function matchesSecretPattern(value: string): boolean {
    return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

function redactInternal(
    value: unknown,
    depth: number,
    options: Required<RedactionOptions>,
    counters: RedactionCounters,
    seen: WeakSet<object>,
): unknown {
    if (
        value === null ||
        value === undefined ||
        typeof value === "boolean" ||
        typeof value === "number"
    ) {
        return value;
    }

    if (typeof value === "string") {
        if (matchesSecretPattern(value)) {
            counters.patternRedactions += 1;
            return REDACTED_MARKER;
        }
        if (value.length > options.maxStringLength) {
            counters.truncatedStrings += 1;
            return `${value.slice(0, options.maxStringLength)}...`;
        }
        return value;
    }

    if (typeof value === "object") {
        if (seen.has(value)) return CIRCULAR_MARKER;
        seen.add(value);

        if (depth >= options.maxDepth) {
            counters.depthClipped += 1;
            return DEPTH_CLIPPED_MARKER;
        }

        if (Array.isArray(value)) {
            const items = value
                .slice(0, options.maxArrayItems)
                .map((item) =>
                    redactInternal(item, depth + 1, options, counters, seen),
                );
            if (value.length > options.maxArrayItems) {
                counters.truncatedArrays += 1;
                items.push(`[TRUNCATED: ${value.length} items]`);
            }
            return items;
        }

        const result: Record<string, unknown> = {};
        for (const [key, nestedValue] of Object.entries(value)) {
            if (isSensitiveKey(key)) {
                counters.maskedKeys += 1;
                result[key] = REDACTED_MARKER;
            } else {
                result[key] = redactInternal(
                    nestedValue,
                    depth + 1,
                    options,
                    counters,
                    seen,
                );
            }
        }
        return result;
    }

    return value;
}

const DEFAULT_OPTIONS: Required<RedactionOptions> = {
    maxDepth: 20,
    maxStringLength: 10_000,
    maxArrayItems: 100,
};

export function redactValue(
    value: unknown,
    options?: RedactionOptions,
): RedactionResult {
    const resolvedOptions: Required<RedactionOptions> = {
        maxDepth: options?.maxDepth ?? DEFAULT_OPTIONS.maxDepth,
        maxStringLength:
            options?.maxStringLength ?? DEFAULT_OPTIONS.maxStringLength,
        maxArrayItems: options?.maxArrayItems ?? DEFAULT_OPTIONS.maxArrayItems,
    };
    const counters: RedactionCounters = {
        maskedKeys: 0,
        patternRedactions: 0,
        truncatedStrings: 0,
        truncatedArrays: 0,
        depthClipped: 0,
    };

    return {
        value: redactInternal(
            value,
            0,
            resolvedOptions,
            counters,
            new WeakSet<object>(),
        ),
        counters,
    };
}

function normalizeDisplayControls(value: string): string {
    let normalized = "";
    for (const character of stripVTControlCharacters(value)) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (character === "\n" || character === "\r" || character === "\t") {
            normalized += " ";
        } else if (codePoint >= 32 && codePoint !== 127) {
            normalized += character;
        }
    }
    return normalized.replaceAll(/\s+/g, " ").trim();
}

function parseJsonDisplayValue(value: string): unknown {
    const firstCharacter = value[0];
    if (firstCharacter !== "{" && firstCharacter !== "[") return value;
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return value;
    }
}

export function sanitizeDisplayText(value: unknown, maxWidth = 240): string {
    const normalized =
        typeof value === "string"
            ? normalizeDisplayControls(value)
            : (JSON.stringify(value) ?? String(value));
    const parsed = parseJsonDisplayValue(normalized);
    const redacted = redactValue(parsed).value;
    const serialized =
        typeof redacted === "string"
            ? redacted
            : (JSON.stringify(redacted) ?? String(redacted));
    return truncateToWidth(normalizeDisplayControls(serialized), maxWidth);
}
