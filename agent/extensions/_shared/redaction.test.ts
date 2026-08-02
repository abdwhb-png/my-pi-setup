import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { redactValue, sanitizeDisplayText } from "./redaction";
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
});
