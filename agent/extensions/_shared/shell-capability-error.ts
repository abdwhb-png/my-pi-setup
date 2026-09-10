export const CAPABILITY_ERROR_CODES = [
    "invalid-authority",
    "authorization-required",
    "migration-required",
    "machine-mismatch",
    "integration-unavailable",
    "unsupported-command",
] as const;

export type CapabilityErrorCode = (typeof CAPABILITY_ERROR_CODES)[number];

const PUBLIC_MESSAGES: Readonly<Record<CapabilityErrorCode, string>> = {
    "invalid-authority": "Capability authority is invalid",
    "authorization-required": "Capability authorization is required",
    "migration-required": "Capability migration is required",
    "machine-mismatch": "Capability authority belongs to another machine",
    "integration-unavailable": "Host integration is unavailable",
    "unsupported-command": "Host integration rejected the command",
};
const CAPABILITY_ERROR_BRAND: unique symbol = Symbol.for(
    "pi.shell-capabilities.CapabilityError.v1",
);
const VALID_CAPABILITY_ERROR_CODES: ReadonlySet<string> = new Set(
    CAPABILITY_ERROR_CODES,
);
const MAX_DIAGNOSTIC_LENGTH = 1024;
type OpaqueFailure = ErrorOptions["cause"];

function boundedDiagnostic(value: string): string {
    return value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_DIAGNOSTIC_LENGTH);
}

export function capabilityErrorMessage(
    code: CapabilityErrorCode,
    diagnostic?: string,
): string {
    const prefix = `${code}: ${PUBLIC_MESSAGES[code]}`;
    const detail = diagnostic ? boundedDiagnostic(diagnostic) : "";
    return detail ? `${prefix}. ${detail}` : prefix;
}

/**
 * Typed shell-capability refusal shared across separately loaded Pi extensions.
 * The diagnostic is accepted only from trusted policy and adapter code, then
 * normalized to one bounded line before it can reach the model.
 */
export class CapabilityError extends Error {
    readonly code!: CapabilityErrorCode;
    readonly diagnostic?: string;

    constructor(code: CapabilityErrorCode, diagnostic?: string) {
        const bounded = diagnostic ? boundedDiagnostic(diagnostic) : undefined;
        super(capabilityErrorMessage(code, bounded));
        this.name = "CapabilityError";
        Object.defineProperty(this, "code", {
            configurable: false,
            enumerable: false,
            value: code,
            writable: false,
        });
        if (bounded !== undefined) {
            Object.defineProperty(this, "diagnostic", {
                configurable: false,
                enumerable: false,
                value: bounded,
                writable: false,
            });
        }
        Object.defineProperty(this, CAPABILITY_ERROR_BRAND, {
            configurable: false,
            enumerable: false,
            value: true,
            writable: false,
        });
    }

    getCode(): CapabilityErrorCode {
        return this.code;
    }

    getDiagnostic(): string | undefined {
        return this.diagnostic;
    }
}

export function isCapabilityError(
    error: OpaqueFailure,
): error is CapabilityError {
    if (typeof error !== "object" || error === null) return false;
    if (Reflect.get(error, CAPABILITY_ERROR_BRAND) !== true) return false;
    const code = "code" in error ? error.code : undefined;
    const diagnostic = "diagnostic" in error ? error.diagnostic : undefined;
    return (
        typeof code === "string" &&
        VALID_CAPABILITY_ERROR_CODES.has(code) &&
        (diagnostic === undefined || typeof diagnostic === "string")
    );
}
