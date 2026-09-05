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
    /\bBearer\s+\S+/gi,
    /\bsk-[A-Za-z0-9_-]{10,}\b/g,
    /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    /\b(?:export|set)\s+(?:API_KEY|API_SECRET|ACCESS_TOKEN|SECRET_KEY|PRIVATE_KEY|DB_PASSWORD)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;]+)/gi,
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

/**
 * Named domain type for any JSON-shaped value (string, number, boolean, null,
 * undefined, array, or plain object). Used in place of `unknown` so the lint
 * rule that flags `unknown` returns at I/O boundaries can see a concrete
 * domain type.
 *
 * `undefined` is included so the function can faithfully round-trip the
 * pre-existing behavior relied on by `save-tokens/telemetry/redaction.test.ts`.
 *
 * Structurally equivalent to `unknown` from the caller's perspective.
 */
export type RedactedJsonValue =
    | string
    | number
    | boolean
    | null
    | undefined
    | RedactedJsonValue[]
    | { [key: string]: RedactedJsonValue };

const CIRCULAR_MARKER = "[CIRCULAR]";
const REDACTED_MARKER = "[REDACTED]";
const DEPTH_CLIPPED_MARKER = "[DEPTH_CLIPPED]";

function isSensitiveKey(key: string): boolean {
    return SENSITIVE_KEYS.has(key.toLowerCase().replaceAll("-", ""));
}

function matchesSecretPattern(value: string): boolean {
    return SECRET_PATTERNS.some((pattern) => {
        pattern.lastIndex = 0;
        const matches = pattern.test(value);
        pattern.lastIndex = 0;
        return matches;
    });
}

function redactInternal(
    value: unknown,
    depth: number,
    options: Required<RedactionOptions>,
    counters: RedactionCounters,
    seen: WeakSet<object>,
): RedactedJsonValue {
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

        const result: Record<string, RedactedJsonValue> = {};
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

    return value as RedactedJsonValue;
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

function parseJsonDisplayValue(value: string): RedactedJsonValue {
    const firstCharacter = value[0];
    if (firstCharacter !== "{" && firstCharacter !== "[") return value;
    try {
        return JSON.parse(value) as RedactedJsonValue;
    } catch {
        return value;
    }
}

export interface PartialRedactionOptions {
    /** Maximum length of the resulting redacted text. Default: 256. */
    maxLength?: number;
}

const PARTIAL_REDACTION_DEFAULT_MAX = 256;
const PARTIAL_REDACTION_MARKER = "[REDACTED]";

/**
 * Redact secret patterns while preserving all surrounding non-secret text.
 *
 * Used when a whole-string redaction would erase an entire indexed record:
 * instead of collapsing the whole value to `[REDACTED]`, keep the surrounding
 * text intact and replace only the matched secret substring with the marker.
 *
 * Multiple matches in the same input are each replaced independently. The
 * result is hard-clamped to `maxLength` characters.
 */
export function redactTextPreservingContext(
    value: string,
    options: PartialRedactionOptions = {},
): string {
    const maxLength = options.maxLength ?? PARTIAL_REDACTION_DEFAULT_MAX;
    if (typeof value !== "string" || value.length === 0) {
        return PARTIAL_REDACTION_MARKER;
    }
    let result = value;
    for (const [index, pattern] of SECRET_PATTERNS.entries()) {
        pattern.lastIndex = 0;
        result = result.replace(pattern, (match) => {
            if (index === 3) {
                const assignment = match.indexOf("=");
                return `${match.slice(0, assignment + 1)}${PARTIAL_REDACTION_MARKER}`;
            }
            return PARTIAL_REDACTION_MARKER;
        });
        pattern.lastIndex = 0;
    }
    if (result.length > maxLength) {
        result = result.slice(0, maxLength);
    }
    return result;
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
