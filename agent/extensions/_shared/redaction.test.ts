import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { redactValue, redactTextPreservingContext, sanitizeDisplayText } from "./redaction";
import { redactValue as legacyRedactValue } from "../save-tokens/telemetry/redaction";

describe("shared display sanitization", () => {
  it("redacts sensitive values in JSON text", () => {
    const sanitized = sanitizeDisplayText(
      JSON.stringify({ password: "hunter2", token: "secret-token", safe: "ok" }),
    );

    expect(sanitized).toContain('"password":"[REDACTED]"');
    expect(sanitized).toContain('"token":"[REDACTED]"');
    expect(sanitized).toContain('"safe":"ok"');
    expect(sanitized).not.toContain("hunter2");
    expect(sanitized).not.toContain("secret-token");
  });

  it("redacts secret patterns in plain strings", () => {
    expect(sanitizeDisplayText("Authorization: Bearer abcdefghijklmnop")).toBe(
      "[REDACTED]",
    );
  });

  it("removes ANSI and control characters from a single display line", () => {
    expect(sanitizeDisplayText("\u001b[31mhello\u001b[0m\tworld\u0000\nnext")).toBe(
      "hello world next",
    );
  });

  it("limits sanitized output to 240 visible columns by default", () => {
    const sanitized = sanitizeDisplayText("x".repeat(400));
    expect(visibleWidth(sanitized)).toBeLessThanOrEqual(240);
  });

  it("keeps the legacy redaction import compatible", () => {
    expect(legacyRedactValue).toBe(redactValue);
    expect(legacyRedactValue({ password: "secret" }).value).toEqual({
      password: "[REDACTED]",
    });
  });

  it("preserves bounded context around a Bearer token", () => {
    const text =
      "Header line one\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\nFooter line";
    const redacted = redactTextPreservingContext(text);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(redacted).toContain("Authorization:");
    expect(redacted).toContain("Footer");
  });

  it("collapses to a marker when the entire input is a single secret", () => {
    expect(redactTextPreservingContext("sk-abcdefghijklmnopqrstuv")).toBe(
      "[REDACTED]",
    );
  });

  it("clamps output length to the configured maximum", () => {
    const filler = "y".repeat(2_000);
    const text = `prefix ${filler} Bearer abcdefghijklmnop suffix`;
    const redacted = redactTextPreservingContext(text, { maxLength: 64 });
    expect(redacted.length).toBeLessThanOrEqual(64);
    expect(redacted).not.toContain("abcdefghijklmnop");
  });

  it("redacts every assigned and repeated secret value while preserving context", () => {
    const redacted = redactTextPreservingContext(
      "export API_KEY=first-secret-value; export API_KEY=second-secret-value; sk-abcdefghijklmno sk-pqrstuvwxyzabcd",
    );
    expect(redacted).toContain("export API_KEY=[REDACTED]");
    expect(redacted).not.toContain("first-secret-value");
    expect(redacted).not.toContain("second-secret-value");
    expect(redacted.match(/\[REDACTED\]/g)?.length).toBe(4);
  });

  it("preserves primitive value semantics (undefined/null/boolean/number) through redactValue", () => {
    // Verified type contract: redactValue must pass through primitives
    // without coercing them to null. This is the pre-existing behavior
    // relied on by save-tokens/telemetry/redaction.test.ts.
    expect(redactValue(null).value).toBeNull();
    expect(redactValue(undefined).value).toBeUndefined();
    expect(redactValue(42).value).toBe(42);
    expect(redactValue(true).value).toBe(true);
    expect(redactValue(false).value).toBe(false);
    expect(redactValue("hello").value).toBe("hello");
  });

  it("preserves number/boolean array items without coercing them to null", () => {
    const result = redactValue({ items: [1, 2, 3, 4, 5] }, {
      maxArrayItems: 100,
    });
    const v = result.value as Record<string, unknown>;
    expect(v.items).toEqual([1, 2, 3, 4, 5]);
    expect(result.counters.maskedKeys).toBe(0);
  });

  it("preserves numeric fields in objects without coercing them to null", () => {
    const result = redactValue({
      username: "john",
      count: 42,
      active: true,
    });
    const v = result.value as Record<string, unknown>;
    expect(v.username).toBe("john");
    expect(v.count).toBe(42);
    expect(v.active).toBe(true);
  });
});
