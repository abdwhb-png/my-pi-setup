/**
 * Pure, deterministic value redactor for telemetry data.
 *
 * Recursively walks an unknown value and:
 * - Masks values under sensitive key names (case-insensitive)
 * - Recognises bearer tokens, sk-* keys, JWT patterns, sensitive env assignments
 * - Bounds recursion depth, string length, and array length
 * - Detects circular references
 *
 * No I/O, no side effects, no dependencies.
 */

// ---------------------------------------------------------------------------
// Sensitive key set (case-insensitive)
// ---------------------------------------------------------------------------

/**
 * Normalised sensitive key set — all entries stored lowercase with hyphens
 * stripped so lookups via `key.toLowerCase().replace(/-/g, '')` match
 * regardless of casing or kebab-case variations.
 * Key "setcookie" matches "set-cookie", "setCookie", "SET-COOKIE" etc.
 */
const SENSITIVE_KEYS = new Set(
    [
        'authorization',
        'apikey',
        'api_key',
        'token',
        'access_token',
        'refresh_token',
        'password',
        'cookie',
        'set-cookie',
        'secret',
        'privatekey',
    ].map((k) => k.toLowerCase().replace(/-/g, '')),
);

// ---------------------------------------------------------------------------
// Secret pattern matchers (applied to string values)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
    // Bearer token — generic (word boundary before Bearer)
    /\bBearer\s+\S+/i,
    // OpenAI-style sk-... keys
    /\bsk-[A-Za-z0-9_-]{10,}\b/,
    // JWT — three base64url segments separated by dots
    /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
    // Sensitive env assignments (export/set ... = ...)
    /\b(?:export|set)\s+(?:API_KEY|API_SECRET|ACCESS_TOKEN|SECRET_KEY|PRIVATE_KEY|DB_PASSWORD)\s*=/i,
];

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RedactionOptions {
    maxDepth?: number;
    maxStringLength?: number;
    maxArrayItems?: number;
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

export interface RedactionCounters {
    maskedKeys: number;
    patternRedactions: number;
    truncatedStrings: number;
    truncatedArrays: number;
    depthClipped: number;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface RedactionResult {
    value: unknown;
    counters: RedactionCounters;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSensitiveKey(key: string): boolean {
    return SENSITIVE_KEYS.has(key.toLowerCase().replace(/-/g, ''));
}

function matchesSecretPattern(value: string): boolean {
    return SECRET_PATTERNS.some((p) => p.test(value));
}

// ---------------------------------------------------------------------------
// Internal recursive walk
// ---------------------------------------------------------------------------

const CIRCULAR_MARKER = '[CIRCULAR]';
const REDACTED_MARKER = '[REDACTED]';
const DEPTH_CLIPPED_MARKER = '[DEPTH_CLIPPED]';

function redactInternal(
    value: unknown,
    depth: number,
    opts: Required<RedactionOptions>,
    counters: RedactionCounters,
    seen: WeakSet<object>,
): unknown {
    // --- Primitive / null / undefined ---
    if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
        return value;
    }

    // --- String ---
    if (typeof value === 'string') {
        // First check secret patterns
        if (matchesSecretPattern(value)) {
            counters.patternRedactions++;
            return REDACTED_MARKER;
        }
        // Then truncate if needed
        if (value.length > opts.maxStringLength) {
            counters.truncatedStrings++;
            return value.slice(0, opts.maxStringLength) + '...';
        }
        return value;
    }

    // --- Object (including arrays) ---
    if (typeof value === 'object') {
        // Circular reference detection
        if (seen.has(value)) {
            return CIRCULAR_MARKER;
        }
        seen.add(value);

        // Depth check
        if (depth >= opts.maxDepth) {
            counters.depthClipped++;
            return DEPTH_CLIPPED_MARKER;
        }

        // Array handling
        if (Array.isArray(value)) {
            if (value.length > opts.maxArrayItems) {
                counters.truncatedArrays++;
                const truncated = value
                    .slice(0, opts.maxArrayItems)
                    .map((item) =>
                        redactInternal(
                            item,
                            depth + 1,
                            opts,
                            counters,
                            seen,
                        ),
                    );
                truncated.push(`[TRUNCATED: ${value.length} items]`);
                return truncated;
            }
            return value.map((item) =>
                redactInternal(item, depth + 1, opts, counters, seen),
            );
        }

        // Plain object
        const result: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value)) {
            if (isSensitiveKey(key)) {
                counters.maskedKeys++;
                result[key] = REDACTED_MARKER;
            } else {
                result[key] = redactInternal(
                    val,
                    depth + 1,
                    opts,
                    counters,
                    seen,
                );
            }
        }
        return result;
    }

    // Fallback — functions, symbols, etc.
    return value;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS: Required<RedactionOptions> = {
    maxDepth: 20,
    maxStringLength: 10_000,
    maxArrayItems: 100,
};

export function redactValue(
    value: unknown,
    opts?: RedactionOptions,
): RedactionResult {
    const options: Required<RedactionOptions> = {
        maxDepth: opts?.maxDepth ?? DEFAULT_OPTIONS.maxDepth,
        maxStringLength:
            opts?.maxStringLength ?? DEFAULT_OPTIONS.maxStringLength,
        maxArrayItems: opts?.maxArrayItems ?? DEFAULT_OPTIONS.maxArrayItems,
    };

    const counters: RedactionCounters = {
        maskedKeys: 0,
        patternRedactions: 0,
        truncatedStrings: 0,
        truncatedArrays: 0,
        depthClipped: 0,
    };

    const seen = new WeakSet<object>();

    return {
        value: redactInternal(value, 0, options, counters, seen),
        counters,
    };
}
