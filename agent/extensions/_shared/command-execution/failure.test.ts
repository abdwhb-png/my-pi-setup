import { describe, expect, it } from "bun:test";
import { createJiti } from "jiti";
import { pathToFileURL } from "node:url";

import {
    SandboxUnavailableError,
} from "../sandbox-runtime/index.ts";
import {
    SafeExecutionError,
    classifySafeExecutionError,
    extractBashFailure,
    isSafeExecutionError,
    normalizeAbnormalError,
    toPublicFailure,
} from "./failure.ts";

/**
 * Load failure.ts via a Jiti instance with `moduleCache:false`. We use
 * two independent loaders to reproduce the production cross-extension
 * module graph: Pi's extension loader uses `createJiti(import.meta.url, {
 * moduleCache: false })` for every extension entrypoint, so each
 * extension gets its own copy of every imported module — including
 * this one. `instanceof` therefore fails across loaders.
 */
function loadFailureModule() {
    const jiti = createJiti(import.meta.url, { moduleCache: false });
    // Use an absolute file URL so jiti's resolver does not depend on
    // the test runner's cwd. This mirrors how Pi loads extensions via
    // absolute paths from the extension entrypoint directory.
    const absolutePath = pathToFileURL(
        `${import.meta.dir}/failure.ts`,
    ).href;
    const imported = jiti(absolutePath) as Record<string, unknown>;
    return imported;
}

/**
 * Build a typed SandboxUnavailableError using the real runtime class so
 * the test exercises the production message-mapping and brand contract.
 * The optional `initError` mirrors the publisher.error captured by the
 * sandbox broker; it is exposed via the typed error's non-enumerable
 * `initError` slot for telemetry only and NEVER reaches the surfaced
 * reason or JSON output.
 */
function makeTypedUnavailableFromRuntime(
    kind: "uninitialized" | "disabled" | "initialization-failed",
    initError?: string,
): SandboxUnavailableError {
    return new SandboxUnavailableError(kind, initError);
}

describe("safe-execution failure normalization", () => {
    it("extracts the trusted exit suffix and discards preceding raw stdout", () => {
        const result = extractBashFailure(
            "SECRET_TOKEN_FROM_COMMAND\n\nCommand exited with code 1",
        );
        expect(result).toEqual({ kind: "bash_exit", reason: "Command exited with code 1" });
    });

    it("extracts the trusted timed-out suffix with seconds", () => {
        const result = extractBashFailure(
            "STDOUT_BEFORE_TIMEOUT\n\nCommand timed out after 30 seconds",
        );
        expect(result).toEqual({
            kind: "bash_timeout",
            reason: "Command timed out after 30 seconds",
        });
    });

    it("extracts the trusted aborted suffix and matches empty stdout", () => {
        const truncated = extractBashFailure("Command aborted");
        expect(truncated).toEqual({ kind: "bash_aborted", reason: "Command aborted" });
        const withStdout = extractBashFailure("partial stdout\n\nCommand aborted");
        expect(withStdout).toEqual({ kind: "bash_aborted", reason: "Command aborted" });
    });

    it("rejects messages with no trusted suffix", () => {
        expect(extractBashFailure("just an arbitrary failure")).toBeNull();
        expect(extractBashFailure("Command exited with code 1 (extra trailing)")).toBeNull();
        expect(extractBashFailure("Command exited with code one")).toBeNull();
        expect(extractBashFailure("")).toBeNull();
    });

    it("recognizes bash.js's pre-spawn internal abort and timeout patterns", () => {
        expect(extractBashFailure("aborted")).toEqual({
            kind: "bash_aborted",
            reason: "Command aborted",
        });
        expect(extractBashFailure("timeout:30")).toEqual({
            kind: "bash_timeout",
            reason: "Command timed out after 30 seconds",
        });
    });

    it("classifies unknown errors as abnormal with a generic reason", () => {
        const result = classifySafeExecutionError(new Error("anything else"));
        expect(result.kind).toBe("abnormal");
        expect(result.reason).toBe("Command failed (raw output redacted)");
        expect(result.raw).toBe("anything else");
    });

    it("normalizes abnormal errors directly with the raw captured", () => {
        const result = normalizeAbnormalError("opaque failure");
        expect(result.kind).toBe("abnormal");
        expect(result.reason).toBe("Command failed (raw output redacted)");
        expect(result.raw).toBe("opaque failure");
    });

    it("strips the safe-execution-unavailable tail when the error is not a typed broker error", () => {
        // The legacy broker-throw path used a plain Error whose message
        // started with the unavailable prefix. With the typed
        // SafeExecutionError broker in place, that path is now only a
        // defensive fallback. The fallback MUST refuse to forward any
        // text after the prefix, even when the prefix happens to match.
        const result = classifySafeExecutionError(
            new Error("Safe execution unavailable: bwrap missing"),
        );
        // The reason is a static phrase; the broker's tail text never
        // appears in the LLM-facing reason (the whole tail is captured
        // under `raw` for telemetry only).
        expect(result.reason).not.toContain("bwrap missing");
        expect(result.reason).toBe("Safe execution unavailable");
        // raw still carries the original for telemetry capture.
        expect(result.raw).toContain("bwrap missing");
    });

    it("treats SafeExecutionError as a typed structured failure", () => {
        const guard = new SafeExecutionError(
            "guard",
            "Denied: dangerous command pattern",
            "Denied: dangerous command pattern",
        );
        expect(isSafeExecutionError(guard)).toBe(true);
        const publicFailure = toPublicFailure(guard);
        expect(publicFailure).toEqual({
            kind: "guard",
            reason: "Denied: dangerous command pattern",
            raw: "Denied: dangerous command pattern",
        });
    });

    it("returns the generic abnormal reason for non-Error inputs", () => {
        const result = classifySafeExecutionError("plain string failure");
        expect(result.kind).toBe("abnormal");
        expect(result.raw).toBe("plain string failure");
    });

    it("preserves a non-matching SafeExecutionError message and raw cause separately", () => {
        const abnormal = new SafeExecutionError(
            "abnormal",
            "Command failed (raw output redacted)",
            "secret-payload",
        );
        const result = toPublicFailure(abnormal);
        expect(result.kind).toBe("abnormal");
        expect(result.reason).toBe("Command failed (raw output redacted)");
        expect(result.raw).toBe("secret-payload");
        expect(result.reason).not.toContain("secret-payload");
    });

    it("does not serialize raw/kind enumerable fields in JSON.stringify", () => {
        const error = new SafeExecutionError(
            "bash_exit",
            "Command exited with code 1",
            "SECRET_RAW_PAYLOAD_DO_NOT_LEAK_VIA_JSON",
        );
        const serialized = JSON.stringify(error);
        // The `message` and `name` fields stay because they are inherited
        // from Error and considered public. `raw` and `kind` must be
        // absent because they hold the original payload and a structured
        // classifier that should never leak outward.
        expect(serialized).not.toContain("SECRET_RAW_PAYLOAD_DO_NOT_LEAK");
        expect(serialized).not.toContain("bash_exit");
        // Getters still expose the typed values for in-process consumers.
        expect(error.getKind()).toBe("bash_exit");
        expect(error.getRaw()).toBe(
            "SECRET_RAW_PAYLOAD_DO_NOT_LEAK_VIA_JSON",
        );
    });

    it("treats prefix-spoofed 'Safe execution unavailable' from a plain Error with a bounded reason", () => {
        // A Python/QuickJS program can raise an exception whose message
        // happens to begin with the broker prefix. The classifier must
        // never forward the attacker-controlled text following the
        // prefix; the reason is replaced with a static phrase and the
        // raw payload is captured under `raw` for telemetry only.
        const spoofed = new Error(
            "Safe execution unavailable: ATTACKER_TAIL_DO_NOT_LEAK",
        );
        const failure = classifySafeExecutionError(spoofed);
        // The reason (LLM-facing surface) never carries attacker text.
        expect(failure.reason).not.toContain("ATTACKER_TAIL_DO_NOT_LEAK");
        // The raw field is telemetry-only and intentionally retains the
        // original payload for the broker fallback path (this is
        // consumer-protected by the failure.ts / coordinator contract:
        // raw is never returned to the LLM and never serialized into a
        // tool result).
        expect(failure.reason).toBe("Safe execution unavailable");
        expect(failure.raw).toBe(spoofed.message);
    });

    it("treats typed broker SafeExecutionError as unavailable without forwarding raw attacker text", () => {
        const brokerError = new SafeExecutionError(
            "unavailable",
            "Safe execution unavailable: bwrap missing",
            "Safe execution unavailable: bwrap missing",
        );
        const failure = classifySafeExecutionError(brokerError);
        expect(failure.kind).toBe("unavailable");
        expect(failure.reason).toBe("Safe execution unavailable: bwrap missing");
        // raw still carries the original broker text for telemetry; the
        // broker is the legitimate source so this is acceptable.
        expect(failure.raw).toBe("Safe execution unavailable: bwrap missing");
    });

    it("classifies the typed sandbox-broker unavailable brand with bounded actionable reason", () => {
        // The sandbox broker stamps a non-enumerable Symbol.for brand plus
        // a closed kind enum so the safe-execution classifier trusts
        // provenance over arbitrary message prefixes. The default
        // reason ('Sandbox execution unavailable: <kind>') stays
        // actionable and never includes the publisher's raw init text.
        const typed = makeTypedUnavailableFromRuntime("uninitialized");
        const failure = classifySafeExecutionError(typed);
        expect(failure.kind).toBe("unavailable");
        expect(failure.reason).toBe(
            "Sandbox execution unavailable: uninitialized",
        );
        expect(failure.reason).not.toContain("bwrap");
        expect(failure.reason).not.toContain("RAW_");
        // raw is the typed-error reference, not the publisher's message.
        expect(failure.raw).not.toContain("bwrap");
    });

    it("refuses to surface raw publisher.error text when sandbox-broker state is 'error'", () => {
        // Adversarial RED for hostile publisher text. The classifier must
        // never forward arbitrary publication.error text (e.g. an upstream
        // process that injected a sensitive stack-trace fragment). The
        // kind is closed-set so this surfaces the bounded 'initialization
        // failed' phrase and nothing else.
        const typed = makeTypedUnavailableFromRuntime(
            "initialization-failed",
            "bwrap stack trace SECRET_DO_NOT_LEAK",
        );
        const failure = classifySafeExecutionError(typed);
        expect(failure.kind).toBe("unavailable");
        expect(failure.reason).toBe(
            "Sandbox execution unavailable: initialization failed",
        );
        expect(failure.reason).not.toContain("SECRET_DO_NOT_LEAK");
        expect(failure.reason).not.toContain("stack trace");
    });

    it("recognizes a SafeExecutionError produced by a separate Jiti module cache (cross-extension identity)", () => {
        // Reproduce the production failure surface: Pi loads each
        // extension through its own Jiti instance with moduleCache:false.
        // We do the same here with two independent loaders and assert
        // that one loader's `isSafeExecutionError` recognizes the
        // other's branded error.
        const loaderA = loadFailureModule();
        const loaderB = loadFailureModule();
        const SafeExecutionErrorA = loaderA.SafeExecutionError as typeof SafeExecutionError;
        const SafeExecutionErrorB = loaderB.SafeExecutionError as typeof SafeExecutionError;
        const isSafeB = loaderB.isSafeExecutionError as typeof isSafeExecutionError;
        // The two class identities are distinct (this is the bug).
        expect(SafeExecutionErrorA).not.toBe(SafeExecutionErrorB);
        const error = new SafeExecutionErrorA(
            "guard",
            "dangerous command blocked",
            "dangerous command blocked",
        );
        // Today this returns false because the class identity differs.
        // The fix MUST make this return true via a process-global brand,
        // not by relying on `instanceof`.
        expect(isSafeB(error)).toBe(true);
        // The same brand must survive JSON.stringify / spread logs.
        const serialized = JSON.stringify(error);
        expect(serialized).not.toContain("dangerous command blocked");
        expect(serialized).not.toContain("guard");
    });

    it("ignores spoof attempts that mimic the brand through non-enumerable own properties", () => {
        // Defense-in-depth: a malicious script could attempt to mimic the
        // brand by setting a non-enumerable property. The guard must
        // also confirm the kind is in the closed SafeExecutionFailureKind
        // set, not just a property name match.
        const loader = loadFailureModule();
        const isSafe = loader.isSafeExecutionError as typeof isSafeExecutionError;
        const forged: unknown = new Error("decoy");
        Object.defineProperty(forged, "kind", {
            value: "guard",
            enumerable: false,
            writable: false,
            configurable: false,
        });
        Object.defineProperty(forged, "raw", {
            value: "secret",
            enumerable: false,
            writable: false,
            configurable: false,
        });
        expect(isSafe(forged)).toBe(false);
    });
});
