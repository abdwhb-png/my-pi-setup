import { createHash } from "node:crypto";

export const ANALYSIS_LIMITS = Object.freeze({
    wallTimeMs: 60_000,
    cpuSeconds: 30,
    memoryBytes: 1024 ** 3,
    inputBytes: 64 * 1024 ** 2,
    outputBytes: 32 * 1024 ** 2,
});

export const ANALYSIS_MAX_CONCURRENCY = 2;

export function analysisHostResponseBudget(outputBytes: number): number {
    // JSON may encode one logical byte as a six-byte `\\u00xx` escape.
    return outputBytes * 6 + 64 * 1024;
}

export type AnalysisLanguage = "javascript" | "typescript" | "python";
export type AnalysisWorker = "quickjs" | "python";

export interface AnalysisLimitOverrides {
    wallTimeMs?: number;
    cpuSeconds?: number;
    memoryBytes?: number;
    outputBytes?: number;
}

export type AnalysisBindingValue =
    | string
    | number
    | boolean
    | null
    | readonly AnalysisBindingValue[]
    | { readonly [key: string]: AnalysisBindingValue };

export interface AnalysisRequest {
    id: string;
    language: AnalysisLanguage;
    program: string;
    bindings?: Record<string, AnalysisBindingValue>;
    limits?: AnalysisLimitOverrides;
}

export interface NormalizedAnalysisLimits {
    wallTimeMs: number;
    cpuSeconds: number;
    memoryBytes: number;
    inputBytes: number;
    outputBytes: number;
}

export interface NormalizedAnalysisRequest extends Omit<
    AnalysisRequest,
    "bindings" | "limits"
> {
    worker: AnalysisWorker;
    bindings: Record<string, AnalysisBindingValue>;
    limits: NormalizedAnalysisLimits;
}

export interface AnalysisResult {
    output: string;
    stderr: string;
    runtime: AnalysisWorker;
    durationMs: number;
    truncated: boolean;
}

export type AnalysisHostResponse =
    | { ok: true; result: AnalysisResult }
    | { ok: false; error: string };

export function parseAnalysisHostResponse(
    value: unknown,
): AnalysisHostResponse {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Invalid analysis host response");
    }
    const response = value as Record<string, unknown>;
    if (response.ok === false && typeof response.error === "string") {
        return { ok: false, error: response.error };
    }
    if (
        response.ok !== true ||
        typeof response.result !== "object" ||
        response.result === null ||
        Array.isArray(response.result)
    ) {
        throw new Error("Invalid analysis host response");
    }
    const result = response.result as Record<string, unknown>;
    if (
        typeof result.output !== "string" ||
        typeof result.stderr !== "string" ||
        (result.runtime !== "quickjs" && result.runtime !== "python") ||
        typeof result.durationMs !== "number" ||
        typeof result.truncated !== "boolean"
    ) {
        throw new Error("Invalid analysis host response");
    }
    return {
        ok: true,
        result: {
            output: result.output,
            stderr: result.stderr,
            runtime: result.runtime,
            durationMs: result.durationMs,
            truncated: result.truncated,
        },
    };
}

function clampLimit(
    name: keyof AnalysisLimitOverrides,
    value: number | undefined,
    ceiling: number,
): number {
    if (value === undefined) return ceiling;
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
        throw new Error(`Analysis ${name} must be a positive integer`);
    }
    return Math.min(value, ceiling);
}

function workerForLanguage(language: AnalysisLanguage): AnalysisWorker {
    if (language === "javascript" || language === "typescript") {
        return "quickjs";
    }
    if (language === "python") return "python";
    throw new Error(`Unsupported analysis language: ${String(language)}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const prototype = Reflect.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function normalizeBindingValue(
    value: unknown,
    depth = 0,
): AnalysisBindingValue {
    if (depth > 64) {
        throw new Error("Analysis binding nesting exceeds 64 levels");
    }
    if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean"
    ) {
        return value;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new Error("Analysis binding numbers must be finite");
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => normalizeBindingValue(item, depth + 1));
    }
    if (isPlainRecord(value)) {
        const normalized: Record<string, AnalysisBindingValue> = Object.create(
            null,
        ) as Record<string, AnalysisBindingValue>;
        for (const [name, item] of Object.entries(value)) {
            normalized[name] = normalizeBindingValue(item, depth + 1);
        }
        return normalized;
    }
    throw new Error("Analysis bindings must contain JSON-compatible values");
}

const JAVASCRIPT_BINDING_KEYWORDS = new Set([
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "function",
    "if",
    "implements",
    "import",
    "in",
    "instanceof",
    "interface",
    "let",
    "new",
    "null",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "static",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
]);
const PYTHON_BINDING_KEYWORDS = new Set([
    "False",
    "None",
    "True",
    "and",
    "as",
    "assert",
    "async",
    "await",
    "break",
    "class",
    "continue",
    "def",
    "del",
    "elif",
    "else",
    "except",
    "finally",
    "for",
    "from",
    "global",
    "if",
    "import",
    "in",
    "is",
    "lambda",
    "nonlocal",
    "not",
    "or",
    "pass",
    "raise",
    "return",
    "try",
    "while",
    "with",
    "yield",
    "match",
    "case",
]);
const JAVASCRIPT_INTERNAL_BINDINGS = new Set([
    "env",
    "globalThis",
    "__freezeBinding",
]);
const PYTHON_INTERNAL_BINDINGS = new Set(["_freeze_binding"]);

function normalizeBindings(
    bindings: Record<string, AnalysisBindingValue> | undefined,
    language: AnalysisLanguage,
): Record<string, AnalysisBindingValue> {
    const normalized: Record<string, AnalysisBindingValue> = Object.create(
        null,
    ) as Record<string, AnalysisBindingValue>;
    for (const [name, value] of Object.entries(bindings ?? {})) {
        const reserved =
            language === "python"
                ? PYTHON_BINDING_KEYWORDS
                : JAVASCRIPT_BINDING_KEYWORDS;
        const internal =
            language === "python"
                ? PYTHON_INTERNAL_BINDINGS.has(name) ||
                  name.startsWith("__analysis_")
                : JAVASCRIPT_INTERNAL_BINDINGS.has(name);
        if (
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
            reserved.has(name) ||
            internal
        ) {
            throw new Error(`Invalid analysis binding name: ${name}`);
        }
        normalized[name] = normalizeBindingValue(value);
    }
    return normalized;
}

function inputBytes(
    program: string,
    bindings: Readonly<Record<string, AnalysisBindingValue>>,
): number {
    let total = Buffer.byteLength(program, "utf8");
    for (const [name, value] of Object.entries(bindings)) {
        total += Buffer.byteLength(name, "utf8");
        total += Buffer.byteLength(JSON.stringify(value), "utf8");
    }
    return total;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAnalysisRequest(
    value: unknown,
): NormalizedAnalysisRequest {
    if (!isRecord(value))
        throw new Error("Analysis request object is required");
    const bindings: Record<string, AnalysisBindingValue> = {};
    if (value.bindings !== undefined) {
        if (!isRecord(value.bindings)) {
            throw new Error("Analysis bindings must be an object");
        }
        for (const [name, binding] of Object.entries(value.bindings)) {
            bindings[name] = normalizeBindingValue(binding);
        }
    }
    const limits: AnalysisLimitOverrides = {};
    if (value.limits !== undefined) {
        if (!isRecord(value.limits)) {
            throw new Error("Analysis limits must be an object");
        }
        for (const name of [
            "wallTimeMs",
            "cpuSeconds",
            "memoryBytes",
            "outputBytes",
        ] as const) {
            const limit = value.limits[name];
            if (limit !== undefined) {
                if (typeof limit !== "number") {
                    throw new Error(`Analysis ${name} must be a number`);
                }
                limits[name] = limit;
            }
        }
    }
    let language: AnalysisLanguage;
    if (
        value.language === "javascript" ||
        value.language === "typescript" ||
        value.language === "python"
    ) {
        language = value.language;
    } else {
        throw new Error(
            `Unsupported analysis language: ${String(value.language)}`,
        );
    }
    return normalizeAnalysisRequest({
        id: typeof value.id === "string" ? value.id : "",
        language,
        program: typeof value.program === "string" ? value.program : "",
        bindings,
        limits,
    });
}

/**
 * Deterministic, collision-resistant mapping from an arbitrary Pi toolCallId
 * (e.g. `call_<hex>|fc_<hex>`) to an analysis-safe id that satisfies
 * `^[A-Za-z0-9._-]{1,128}$`. Valid ids pass through unchanged; all others
 * are mapped to `think-<sha256-hex>` (6 + 64 = 70 chars, <=128). Centralized
 * so every analysis.run path shares the same stable mapping without
 * weakening `normalizeAnalysisRequest` validation.
 */
export function toSafeAnalysisId(rawId: string): string {
    if (/^[A-Za-z0-9._-]{1,128}$/.test(rawId)) return rawId;
    const hex = createHash("sha256").update(rawId).digest("hex");
    return `think-${hex}`;
}

export function normalizeAnalysisRequest(
    request: AnalysisRequest,
): NormalizedAnalysisRequest {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(request.id)) {
        throw new Error("Invalid analysis request id");
    }
    if (typeof request.program !== "string" || request.program.length === 0) {
        throw new Error("Analysis program must be a non-empty string");
    }
    const bindings = normalizeBindings(request.bindings, request.language);
    const bytes = inputBytes(request.program, bindings);
    if (bytes > ANALYSIS_LIMITS.inputBytes) {
        throw new Error(
            `Analysis input exceeds ${ANALYSIS_LIMITS.inputBytes} UTF-8 bytes`,
        );
    }

    return {
        id: request.id,
        language: request.language,
        worker: workerForLanguage(request.language),
        program: request.program,
        bindings,
        limits: {
            wallTimeMs: clampLimit(
                "wallTimeMs",
                request.limits?.wallTimeMs,
                ANALYSIS_LIMITS.wallTimeMs,
            ),
            cpuSeconds: clampLimit(
                "cpuSeconds",
                request.limits?.cpuSeconds,
                ANALYSIS_LIMITS.cpuSeconds,
            ),
            memoryBytes: clampLimit(
                "memoryBytes",
                request.limits?.memoryBytes,
                ANALYSIS_LIMITS.memoryBytes,
            ),
            inputBytes: ANALYSIS_LIMITS.inputBytes,
            outputBytes: clampLimit(
                "outputBytes",
                request.limits?.outputBytes,
                ANALYSIS_LIMITS.outputBytes,
            ),
        },
    };
}
