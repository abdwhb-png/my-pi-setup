/* oxlint-disable typescript/no-restricted-types -- failure normalization intentionally accepts fully type-erased inputs and preserves the raw cause for telemetry; widening to a concrete interface would defeat the purpose. */
import { isSandboxUnavailableError } from "../sandbox-runtime/index.ts";
/**
 * Safe-execution failure normalization.
 *
 * `createBashToolDefinition` (the default backend inside the shared safe
 * execution service) throws plain `Error`s whose `.message` concatenates
 * truncated raw stdout with a status suffix (`Command exited with code N`,
 * `Command timed out after N seconds`, `Command aborted`). Surfacing that
 * message verbatim to the LLM would leak raw command output through
 * `details.blockedReason`, `details.items[].error`, the analyzer `INPUTS`
 * JSON binding, and any indexed search text.
 *
 * This module detects the three trusted bash failure shapes, reclassifies
 * them into a structured `SafeExecutionFailure`, and provides a
 * `SafeExecutionError` class used by `core.ts` to wrap every error it
 * throws (including guard/redirect denials) so the Think coordinator can
 * decide which categories are safe to surface.
 *
 * Failure surface rules:
 *   - `bash_exit`, `bash_timeout`, `bash_aborted`: trusted suffix match;
 *     the message is replaced with only the suffix (no preceding stdout).
 *   - `guard`: a guard policy denied the command before execution.
 *     `error.message` is the guard match description and is proven free of
 *     command output (the underlying `inspectDangerousMatches` only inspects
 *     the command line for known patterns, never the captured stdin).
 *   - `redirect`: a native-tool redirect denied the command before
 *     execution. Same provenance as `guard`.
 *   - `unavailable`: the Sandbox runtime was not initialized or failed. The
 *     model-facing reason is bounded by the runtime contract.
 *   - `analyzer`: a downstream analyzer (QuickJS/Python) failure; the
 *     coordinator surfaces it but never includes the analyzer's stderr.
 *   - `abnormal`: an unrecognized safe-execution error. The message is
 *     refused and a generic redacted reason is returned.
 *
 * Cross-instance identity: Pi loads each extension entrypoint through
 * its own Jiti instance with `moduleCache: false`, so two extensions
 * (e.g. `safe-bash` and `think-in-code`) get separate copies of every
 * imported module. `instanceof SafeExecutionError` therefore compares
 * two distinct class objects and returns `false`. We bridge this with
 * a process-global `Symbol.for(...)` brand stamped on the instance
 * itself; the guard below checks for the brand presence AND validates
 * the kind against the closed `SafeExecutionFailureKind` set so a
 * spoof with arbitrary property names still fails closed.
 */

export type SafeExecutionFailureKind =
    | "bash_exit"
    | "bash_timeout"
    | "bash_aborted"
    | "guard"
    | "redirect"
    | "unavailable"
    | "analyzer"
    | "abnormal";

export interface SafeExecutionFailure {
    kind: SafeExecutionFailureKind;
    /** Safe, bounded reason that may appear in LLM-facing surfaces. */
    reason: string;
    /** Original error message, retained only for capture warnings / telemetry. */
    raw: string;
}

const BASH_ABORTED_RE = /^(.*\n\n)?Command aborted$/s;
const BASH_TIMED_OUT_RE = /^(.*\n\n)?Command timed out after (\d+) seconds$/s;
const BASH_EXITED_RE = /^(.*\n\n)?Command exited with code (-?\d+)$/s;
// bash.js emits internal pre-spawn throws with bare messages that do not
// embed raw output (the command never ran). Trust those exact shapes.
const BASH_INTERNAL_ABORTED_RE = /^aborted$/;
const BASH_INTERNAL_TIMEOUT_RE = /^timeout:(\d+)$/;

/**
 * Try to recognize a known bash.js exit/timeout/abort error shape.
 * Returns null when the message does not match a trusted suffix; the
 * caller MUST treat such messages as untrusted and refuse to surface them.
 */
export function extractBashFailure(message: string): {
    kind: "bash_exit" | "bash_timeout" | "bash_aborted";
    reason: string;
} | null {
    const trimmed = message.endsWith("\n") ? message.trimEnd() : message;
    const timedOut = BASH_TIMED_OUT_RE.exec(trimmed);
    if (timedOut && timedOut[2] !== undefined) {
        return {
            kind: "bash_timeout",
            reason: `Command timed out after ${timedOut[2]} seconds`,
        };
    }
    const exited = BASH_EXITED_RE.exec(trimmed);
    if (exited && exited[2] !== undefined) {
        return {
            kind: "bash_exit",
            reason: `Command exited with code ${exited[2]}`,
        };
    }
    if (BASH_INTERNAL_ABORTED_RE.test(trimmed)) {
        return { kind: "bash_aborted", reason: "Command aborted" };
    }
    const internalTimeout = BASH_INTERNAL_TIMEOUT_RE.exec(trimmed);
    if (internalTimeout && internalTimeout[1] !== undefined) {
        return {
            kind: "bash_timeout",
            reason: `Command timed out after ${internalTimeout[1]} seconds`,
        };
    }
    const aborted = BASH_ABORTED_RE.exec(trimmed);
    if (aborted) {
        return { kind: "bash_aborted", reason: "Command aborted" };
    }
    return null;
}

const UNAVAILABLE_BROKER_PREFIX = "Safe execution unavailable:";

/**
 * Normalize an unknown error thrown by the command-execution service. Used by
 * the coordinator as a fail-closed last resort when neither the bash shape
 * match nor a structured SafeExecutionError attachment is available.
 */
export function normalizeAbnormalError(message: string): SafeExecutionFailure {
    return {
        kind: "abnormal",
        reason: "Command failed (raw output redacted)",
        raw: message,
    };
}

/**
 * Normalize any error thrown by the command-execution service into a
 * structured failure. The bash.js trusted-suffix path returns only the
 * suffix (never the preceding text). The `unavailable` kind is reserved
 * for typed runtime failures: a Python/QuickJS program
 * can raise an exception whose message begins with the same prefix, so
 * message-prefix matching would be spoofable. We therefore (a) trust
 * `isSafeExecutionError(e) && e.kind === "unavailable"`, and (b) accept
 * the legacy message prefix only as a static-phrase fallback that
 * refuses to forward attacker-controlled tail text.
 */
export function classifySafeExecutionError(
    error: unknown,
): SafeExecutionFailure {
    // Typed Sandbox runtime unavailability: trust provenance via the
    // brand + closed kind. The bounded reason is the deterministic
    // 'Sandbox execution unavailable: <kind>' phrase, NEVER the raw
    // publisher.error text (held only in the typed error's non-enumerable
    // `initError` slot for telemetry).
    if (isSandboxUnavailableError(error)) {
        // The typed SandboxUnavailableError sets its own `message` to the
        // bounded, human-readable phrase 'Sandbox execution unavailable:
        // <kind>'. The publisher's arbitrary `initError` is held only on
        // the non-enumerable `initError` slot for telemetry and is NEVER
        // surfaced here.
        // oxlint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-type-assertion -- `initError` is non-enumerable; the brand+closed-set guard above already validated the value.
        const typedDiagnostic = error.getDiagnostic();
        return {
            kind: "unavailable",
            reason: error.message,
            raw: typedDiagnostic ?? "",
        };
    }
    const raw = error instanceof Error ? error.message : String(error);
    const bash = extractBashFailure(raw);
    if (bash) return { ...bash, raw };
    if (isSafeExecutionError(error) && error.kind === "unavailable") {
        return {
            kind: "unavailable",
            reason: error.message,
            raw: error.raw,
        };
    }
    if (raw.startsWith(UNAVAILABLE_BROKER_PREFIX)) {
        return {
            kind: "unavailable",
            reason: "Safe execution unavailable",
            raw,
        };
    }
    return normalizeAbnormalError(raw);
}

const SAFE_EXECUTION_ERROR_NAME = "SafeExecutionError";

/**
 * Process-global brand stamped on every SafeExecutionError instance.
 * Pi loads each extension entrypoint via its own Jiti instance with
 * `moduleCache: false` (see `@earendil-works/pi-coding-agent/dist/core/
 * extensions/loader.js`), so `instanceof SafeExecutionError` fails
 * across extensions. `Symbol.for(...)` lets us publish the brand on
 * `globalThis` so every extension's copy of `failure.ts` shares one
 * symbol identity. This is the same process-global identity pattern used by
 * `_shared/sandbox-runtime` and `_shared/ai-providers/catalog.ts`.
 */
const SAFE_EXECUTION_BRAND: unique symbol = Symbol.for(
    "pi.safe-execution.SafeExecutionError",
);

/** Closed enum of valid kinds. */
const VALID_SAFE_EXECUTION_KINDS: ReadonlySet<SafeExecutionFailureKind> =
    new Set<SafeExecutionFailureKind>([
        "bash_exit",
        "bash_timeout",
        "bash_aborted",
        "guard",
        "redirect",
        "unavailable",
        "analyzer",
        "abnormal",
    ]);

/**
 * Type guard that survives separately-evaluated Jiti module graphs.
 * Uses the process-global `Symbol.for` brand on the instance plus a
 * closed-set kind check so a malicious value that only mimics the
 * brand keys cannot spoof a SafeExecutionError. The `kind` and `raw`
 * properties are non-enumerable so JSON.stringify / spread logs do not
 * leak them; the brand symbol is also non-enumerable.
 */
export function isSafeExecutionError(
    error: unknown,
): error is SafeExecutionError {
    if (typeof error !== "object" || error === null) return false;
    // Read each property through a deliberately loose type because we
    // do not own the runtime shape; we then validate both fields with
    // structural + closed-enum checks below before trusting the value.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- type-erased to a Record so we can read both the brand (symbol) and the kind (string) keys; the closed-set `VALID_SAFE_EXECUTION_KINDS` check below proves the value is well-formed.
    const record = error as Record<string | symbol, unknown>;
    if (record[SAFE_EXECUTION_BRAND] !== true) return false;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Record keying by symbol mixes with string indexing; we validate the kind below against the closed enum.
    const kind = (record as Record<string, unknown>)["kind"];
    if (typeof kind !== "string") return false;
    return VALID_SAFE_EXECUTION_KINDS.has(
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the enum validation below proves the value is well-formed.
        kind as SafeExecutionFailureKind,
    );
}

/**
 * Error thrown by `_shared/command-execution/core.ts` so the coordinator can
 * distinguish guard/redirect/unavailable denials (which never embed raw
 * command output) from abnormal bash errors (which may).
 *
 * `kind`, `raw`, and the brand symbol are defined as non-enumerable own
 * properties so they never appear in `JSON.stringify`, spread logs, or
 * any consumer that iterates own enumerable properties. Downstream
 * callers that need the raw text must use the typed accessors
 * (`getKind`/`getRaw`) or the `toPublicFailure` helper.
 *
 * Cross-instance: the brand symbol uses `Symbol.for` so the same
 * symbol identity is reachable across separately-evaluated Jiti
 * module caches. See `isSafeExecutionError` and the `SAFE_EXECUTION_BRAND`
 * constant for the matching detection logic.
 *
 * We deliberately do NOT pass `{ cause: originalError }`: the cause
 * duplicates the same sensitive payload under `cause.message`, has no
 * verified consumer in the Think coordinator or telemetry, and creates
 * a second holder of the raw bytes that Pi's runtime cannot clean up.
 */
export class SafeExecutionError extends Error {
    readonly kind!: SafeExecutionFailureKind;
    readonly raw!: string;

    constructor(kind: SafeExecutionFailureKind, reason: string, raw: string) {
        super(reason);
        this.name = SAFE_EXECUTION_ERROR_NAME;
        Object.defineProperty(this, "kind", {
            value: kind,
            enumerable: false,
            writable: false,
            configurable: false,
        });
        Object.defineProperty(this, "raw", {
            value: raw,
            enumerable: false,
            writable: false,
            configurable: false,
        });
        Object.defineProperty(this, SAFE_EXECUTION_BRAND, {
            value: true,
            enumerable: false,
            writable: false,
            configurable: false,
        });
    }

    // Explicit opt-in accessors so the type system forces callers that
    // need the raw payload to be deliberate about it.
    getKind(): SafeExecutionFailureKind {
        return this.kind;
    }

    getRaw(): string {
        return this.raw;
    }
}

/**
 * Apply the public-boundary normalization that the Think coordinator uses
 * for every safe-execution error surfaced to the LLM. Safe guards and
 * redirects pass through; bash failures return only the trusted suffix;
 * everything else is replaced with a generic redacted reason. The raw
 * error text is preserved in `raw` so capture warnings can record it
 * without leaking it to the agent.
 */
export function toPublicFailure(error: unknown): SafeExecutionFailure {
    if (isSafeExecutionError(error)) {
        const result: SafeExecutionFailure = {
            kind: error.kind,
            reason: error.message,
            raw: error.raw,
        };
        return result;
    }
    return classifySafeExecutionError(error);
}
