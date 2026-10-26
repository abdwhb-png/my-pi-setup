export const SANDBOX_ERROR_CODES = [
    "unsupported-platform",
    "backend-unavailable",
    "provenance-mismatch",
    "strict-unavailable",
    "unsupported-capability",
    "invalid-policy",
    "spawn-failed",
    "setup-failed",
    "protocol-error",
    "timeout",
    "aborted",
    "cleanup-failed",
] as const;

export type SandboxErrorCode = (typeof SANDBOX_ERROR_CODES)[number];

const PUBLIC_ERROR_MESSAGES: Readonly<Record<SandboxErrorCode, string>> = {
    "unsupported-platform": "Sandbox execution is unsupported on this platform",
    "backend-unavailable": "Sandbox backend is unavailable",
    "provenance-mismatch": "Sandbox backend provenance does not match",
    "strict-unavailable": "Strict sandbox enforcement is unavailable",
    "unsupported-capability":
        "Sandbox configuration requests an unsupported capability",
    "invalid-policy": "Sandbox policy is invalid",
    "spawn-failed": "Sandbox process could not be started",
    "setup-failed": "Sandbox setup failed",
    "protocol-error": "Sandbox status protocol failed",
    timeout: "Sandbox execution timed out",
    aborted: "Sandbox execution was aborted",
    "cleanup-failed": "Sandbox cleanup failed",
};

const SANDBOX_EXECUTION_ERROR_BRAND: unique symbol = Symbol.for(
    "pi.sandbox-runtime.SandboxExecutionError.v2",
);
const VALID_SANDBOX_ERROR_CODES: ReadonlySet<string> = new Set(
    SANDBOX_ERROR_CODES,
);
type OpaqueFailure = ErrorOptions["cause"];

const ANALYSIS_ERROR_CLASSES = [
    "SyntaxError",
    "ReferenceError",
    "TypeError",
    "RangeError",
    "EvalError",
    "URIError",
    "InternalError",
    "Error",
] as const;
export type AnalysisErrorClass = (typeof ANALYSIS_ERROR_CLASSES)[number];
const ANALYSIS_ERROR_BRAND = Symbol.for(
    "pi.sandbox-runtime.AnalysisExecutionError.v1",
);

export function parseAnalysisErrorClass(
    value: OpaqueFailure,
): AnalysisErrorClass | undefined {
    return ANALYSIS_ERROR_CLASSES.find((name) => name === value);
}

/** Only the closed engine error class may cross the model-facing boundary. */
export class AnalysisExecutionError extends Error {
    readonly errorClass: AnalysisErrorClass;

    constructor(errorClass: AnalysisErrorClass, diagnostic: string) {
        super(diagnostic);
        this.name = "AnalysisExecutionError";
        this.errorClass = errorClass;
        Object.defineProperty(this, ANALYSIS_ERROR_BRAND, { value: true });
    }
}

export function analysisErrorClassFromError(
    error: OpaqueFailure,
): AnalysisErrorClass | undefined {
    if (
        typeof error !== "object" ||
        error === null ||
        Reflect.get(error, ANALYSIS_ERROR_BRAND) !== true
    )
        return undefined;
    return parseAnalysisErrorClass(Reflect.get(error, "errorClass"));
}

export function sandboxErrorMessage(code: SandboxErrorCode): string {
    return PUBLIC_ERROR_MESSAGES[code];
}

export class SandboxExecutionError extends Error {
    readonly code: SandboxErrorCode;
    #cleanupError: OpaqueFailure;

    constructor(
        code: SandboxErrorCode,
        options: {
            cause?: OpaqueFailure;
            cleanupError?: OpaqueFailure;
            diagnostic?: string;
        } = {},
    ) {
        super(
            options.diagnostic
                ? `${sandboxErrorMessage(code)}: ${options.diagnostic}`
                : sandboxErrorMessage(code),
            { cause: options.cause },
        );
        Object.defineProperty(this, "name", {
            configurable: true,
            enumerable: false,
            value: "SandboxExecutionError",
            writable: true,
        });
        this.code = code;
        this.#cleanupError = options.cleanupError;
        Object.defineProperty(this, SANDBOX_EXECUTION_ERROR_BRAND, {
            configurable: false,
            enumerable: false,
            value: true,
            writable: false,
        });
    }

    getCause(): OpaqueFailure {
        return this.cause;
    }

    getCleanupError(): OpaqueFailure {
        return this.#cleanupError;
    }

    attachCleanupError(error: OpaqueFailure): void {
        if (this.getCleanupError() === undefined) {
            this.#cleanupError = error;
        }
    }
}

export function isSandboxExecutionError(
    error: OpaqueFailure,
): error is SandboxExecutionError {
    if (typeof error !== "object" || error === null) return false;
    if (Reflect.get(error, SANDBOX_EXECUTION_ERROR_BRAND) !== true)
        return false;
    const code = "code" in error ? error.code : undefined;
    return typeof code === "string" && VALID_SANDBOX_ERROR_CODES.has(code);
}
