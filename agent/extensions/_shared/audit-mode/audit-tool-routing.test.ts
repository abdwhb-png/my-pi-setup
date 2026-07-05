import { describe, expect, it, beforeEach } from "bun:test";
import { setActiveProfile, resetAuditState, initAuditState } from "./audit-state";
import {
  shouldEnforceNativeTools,
  shouldReturnUnchanged,
  shouldIgnoreGitignore,
  shouldShowHidden,
  shouldDisableCompression,
  getShellRedirectAdvice,
  type ShellCommand,
  type CompressionContext,
} from "./audit-tool-routing";

// ─── reset state before each test ───────────────────────────────────────────

beforeEach(() => {
  resetAuditState();
});

// ─── shouldEnforceNativeTools ────────────────────────────────────────────────────

describe("shouldEnforceNativeTools", () => {
  it("returns true in standard profile (strict redirect)", () => {
    expect(shouldEnforceNativeTools()).toBe(true);
  });

  it("returns false in audit profile (soft prefer-native)", () => {
    setActiveProfile("audit");
    expect(shouldEnforceNativeTools()).toBe(false);
  });

  it("returns false in advanced profile (soft prefer-native)", () => {
    setActiveProfile("advanced");
    expect(shouldEnforceNativeTools()).toBe(false);
  });
});

// ─── shouldReturnUnchanged ────────────────────────────────────────────────────

describe("shouldReturnUnchanged", () => {
  it("returns true in standard profile", () => {
    expect(shouldReturnUnchanged()).toBe(true);
  });

  it("returns true in audit profile", () => {
    setActiveProfile("audit");
    expect(shouldReturnUnchanged()).toBe(true);
  });

  it("returns true in advanced profile", () => {
    setActiveProfile("advanced");
    expect(shouldReturnUnchanged()).toBe(true);
  });

  it("reflects settings override when initAuditState overrides read.unchanged", () => {
    initAuditState({
      profiles: { standard: { "read.unchanged": false } },
    });
    expect(shouldReturnUnchanged()).toBe(false);
  });
});

// ─── shouldIgnoreGitignore ───────────────────────────────────────────────────

describe("shouldIgnoreGitignore", () => {
  it("standard: grep honors gitignore (returns false = do not ignore it)", () => {
    expect(shouldIgnoreGitignore("grep")).toBe(false);
    expect(shouldIgnoreGitignore("find")).toBe(false);
  });

  it("audit: grep and find ignore gitignore (returns true)", () => {
    setActiveProfile("audit");
    expect(shouldIgnoreGitignore("grep")).toBe(true);
    expect(shouldIgnoreGitignore("find")).toBe(true);
  });

  it("advanced: same as audit for gitignore", () => {
    setActiveProfile("advanced");
    expect(shouldIgnoreGitignore("grep")).toBe(true);
    expect(shouldIgnoreGitignore("find")).toBe(true);
  });
});

// ─── shouldShowHidden ────────────────────────────────────────────────────────

describe("shouldShowHidden", () => {
  it("returns false in standard", () => {
    expect(shouldShowHidden()).toBe(false);
  });

  it("returns true in audit", () => {
    setActiveProfile("audit");
    expect(shouldShowHidden()).toBe(true);
  });

  it("returns true in advanced", () => {
    setActiveProfile("advanced");
    expect(shouldShowHidden()).toBe(true);
  });
});

// ─── shouldDisableCompression ────────────────────────────────────────────────

describe("shouldDisableCompression", () => {
  it("standard: compression always enabled (false)", () => {
    expect(shouldDisableCompression("search")).toBe(false);
    expect(shouldDisableCompression("read")).toBe(false);
    expect(shouldDisableCompression("shell")).toBe(false);
  });

  it("audit: compression still enabled (false)", () => {
    setActiveProfile("audit");
    expect(shouldDisableCompression("search")).toBe(false);
    expect(shouldDisableCompression("read")).toBe(false);
    expect(shouldDisableCompression("shell")).toBe(false);
  });

  it("advanced: search and shell compression disabled, read compression enabled", () => {
    setActiveProfile("advanced");
    expect(shouldDisableCompression("search")).toBe(true);
    expect(shouldDisableCompression("read")).toBe(false);
    expect(shouldDisableCompression("shell")).toBe(true);
  });
});

// ─── getShellRedirectAdvice ──────────────────────────────────────────────────

describe("getShellRedirectAdvice", () => {
  it("standard: grep and find commands get 'redirect' advice", () => {
    const grep: ShellCommand = { name: "grep", args: ["-r", "foo", "."] };
    expect(getShellRedirectAdvice(grep)).toBe("redirect");
  });

  it("standard: non-redirectable commands get 'allow' advice", () => {
    const echo: ShellCommand = { name: "echo", args: ["hello"] };
    expect(getShellRedirectAdvice(echo)).toBe("allow");
  });

  it("audit: redirectable commands get 'prefer-native' advice", () => {
    setActiveProfile("audit");
    const grep: ShellCommand = { name: "grep", args: ["-r", "foo", "."] };
    expect(getShellRedirectAdvice(grep)).toBe("prefer-native");
  });

  it("advanced: redirectable commands also get 'prefer-native' advice", () => {
    setActiveProfile("advanced");
    const find: ShellCommand = { name: "find", args: ["."] };
    expect(getShellRedirectAdvice(find)).toBe("prefer-native");
  });

  it("audit: ls get 'prefer-native' advice", () => {
    setActiveProfile("audit");
    const ls: ShellCommand = { name: "ls", args: ["-la"] };
    expect(getShellRedirectAdvice(ls)).toBe("prefer-native");
  });

  it("rg is treated same as grep for redirect advice", () => {
    const rg: ShellCommand = { name: "rg", args: ["pattern"] };
    // standard → redirect
    expect(getShellRedirectAdvice(rg)).toBe("redirect");
    setActiveProfile("audit");
    expect(getShellRedirectAdvice(rg)).toBe("prefer-native");
  });

  it("fd is treated same as find for redirect advice", () => {
    const fd: ShellCommand = { name: "fd", args: ["pattern"] };
    expect(getShellRedirectAdvice(fd)).toBe("redirect");
    setActiveProfile("audit");
    expect(getShellRedirectAdvice(fd)).toBe("prefer-native");
  });
});

// ─── type exports ────────────────────────────────────────────────────────────

describe("type exports", () => {
  it("ShellCommand has name and args fields", () => {
    const cmd: ShellCommand = { name: "grep", args: ["-r"] };
    expect(cmd.name).toBe("grep");
  });

  it("CompressionContext accepts all valid values", () => {
    const contexts: CompressionContext[] = ["search", "read", "shell"];
    expect(contexts.length).toBe(3);
  });
});
