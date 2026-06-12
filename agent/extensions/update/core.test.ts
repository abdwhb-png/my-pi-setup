/**
 * Tests for the extracted update-core helpers.
 *
 * All tests are self-contained — no filesystem state, no pi API.
 * Dependencies (exec, resolve, realpath, pathExists) are injected as
 * function arguments, making everything testable without mocking.
 */

import { describe, it, expect } from "bun:test";
import {
  isTransient,
  commandFor,
  detectInstallMethod,
  runWithRetry,
  PACKAGE_NAME,
} from "./core.ts";
import type { CommandSpec, ExecFunction } from "./core.ts";

// ===========================================================================
// isTransient
// ===========================================================================
describe("isTransient", () => {
  it("matches EAI_AGAIN", () => {
    expect(isTransient("Error: EAI_AGAIN")).toBe(true);
  });

  it("matches ETIMEDOUT", () => {
    expect(isTransient("fetch failed: ETIMEDOUT")).toBe(true);
  });

  it("matches ECONNRESET", () => {
    expect(isTransient("ECONNRESET")).toBe(true);
  });

  it("matches ECONNREFUSED", () => {
    expect(isTransient("ECONNREFUSED")).toBe(true);
  });

  it('matches "socket hang up"', () => {
    expect(isTransient("socket hang up")).toBe(true);
  });

  it("matches network-related messages", () => {
    expect(isTransient("network error")).toBe(true);
    expect(isTransient("Network is unreachable")).toBe(true);
  });

  it("matches timeout", () => {
    expect(isTransient("timeout exceeded")).toBe(true);
  });

  it('matches "temporar" substring', () => {
    expect(isTransient("temporary failure")).toBe(true);
  });

  it("matches too many requests", () => {
    expect(isTransient("too many requests")).toBe(true);
  });

  it("matches HTTP 429", () => {
    expect(isTransient("429 Too Many Requests")).toBe(true);
  });

  it("matches HTTP 502", () => {
    expect(isTransient("502 Bad Gateway")).toBe(true);
  });

  it("matches HTTP 503", () => {
    expect(isTransient("503 Service Unavailable")).toBe(true);
  });

  it("matches HTTP 504", () => {
    expect(isTransient("504 Gateway Timeout")).toBe(true);
  });

  it("does not match safe success output", () => {
    expect(isTransient("success")).toBe(false);
  });

  it("does not match generic error messages", () => {
    expect(isTransient("syntax error")).toBe(false);
    expect(isTransient("permission denied")).toBe(false);
  });

  it("does not match empty string", () => {
    expect(isTransient("")).toBe(false);
  });
});

// ===========================================================================
// commandFor
// ===========================================================================
describe("commandFor", () => {
  it("returns vp CommandSpec for vp method", () => {
    const spec = commandFor("vp");
    expect(spec).toBeDefined();
    expect(spec!.command).toBe("vp");
    expect(spec!.args).toContain("add");
    expect(spec!.args).toContain("-g");
    expect(spec!.args).toContain(`${PACKAGE_NAME}@latest`);
    expect(spec!.label).toContain("vp add -g");
  });

  it("returns bun CommandSpec for bun method", () => {
    const spec = commandFor("bun");
    expect(spec).toBeDefined();
    expect(spec!.command).toBe("bun");
    expect(spec!.args).toContain("add");
    expect(spec!.args).toContain("-g");
    expect(spec!.args).toContain(`${PACKAGE_NAME}@latest`);
    expect(spec!.label).toContain("bun add -g");
  });

  it("returns npm CommandSpec for npm method", () => {
    const spec = commandFor("npm");
    expect(spec).toBeDefined();
    expect(spec!.command).toBe("npm");
    expect(spec!.args).toContain("install");
    expect(spec!.args).toContain("-g");
    expect(spec!.args).toContain(`${PACKAGE_NAME}@latest`);
    expect(spec!.label).toContain("npm install -g");
  });

  it("returns brew CommandSpec for brew method", () => {
    const spec = commandFor("brew");
    expect(spec).toBeDefined();
    expect(spec!.command).toBe("/bin/sh");
    expect(spec!.args).toContain("-lc");
    expect(spec!.label).toMatch(/brew upgrade/);
  });

  it("returns undefined for native method", () => {
    expect(commandFor("native")).toBeUndefined();
  });
});

// ===========================================================================
// detectInstallMethod
// ===========================================================================
describe("detectInstallMethod", () => {
  function mockFs(opts: {
    piPath?: string;
    realPiPath?: string;
    hasNodeModules?: boolean;
    fallbackCommands?: Record<string, string | undefined>;
  }) {
    return {
      resolve: async (cmd: string): Promise<string | undefined> => {
        if (cmd === "pi") return opts.piPath;
        return opts.fallbackCommands?.[cmd];
      },
      real: async (_path: string): Promise<string> => {
        return opts.realPiPath ?? _path;
      },
      exists: async (_path: string): Promise<boolean> => {
        return opts.hasNodeModules ?? false;
      },
    };
  }

  it("returns vp when pi path contains /.vite-plus/", async () => {
    const { resolve, real, exists } = mockFs({
      piPath: "/root/.vite-plus/bin/pi",
    });
    expect(await detectInstallMethod(resolve, real, exists)).toBe("vp");
  });

  it("returns vp when realpath resolves to /.vite-plus/", async () => {
    const { resolve, real, exists } = mockFs({
      piPath: "/usr/local/bin/pi",
      realPiPath: "/root/.vite-plus/bin/pi",
    });
    expect(await detectInstallMethod(resolve, real, exists)).toBe("vp");
  });

  it("returns bun when pi path contains /.bun/", async () => {
    const { resolve, real, exists } = mockFs({
      piPath: "/root/.bun/bin/pi",
    });
    expect(await detectInstallMethod(resolve, real, exists)).toBe("bun");
  });

  it("returns bun when realpath resolves to /.bun/", async () => {
    const { resolve, real, exists } = mockFs({
      piPath: "/usr/local/bin/pi",
      realPiPath: "/root/.bun/bin/pi",
    });
    expect(await detectInstallMethod(resolve, real, exists)).toBe("bun");
  });

  it("returns brew when pi path contains /Homebrew/", async () => {
    const { resolve, real, exists } = mockFs({
      piPath: "/opt/homebrew/bin/pi",
    });
    expect(await detectInstallMethod(resolve, real, exists)).toBe("brew");
  });

  it("returns brew when realpath resolves to /Homebrew/ path", async () => {
    const { resolve, real, exists } = mockFs({
      piPath: "/usr/local/bin/pi",
      realPiPath: "/opt/homebrew/bin/pi",
    });
    expect(await detectInstallMethod(resolve, real, exists)).toBe("brew");
  });

  it("returns brew when realpath resolves to /Homebrew/", async () => {
    const { resolve, real, exists } = mockFs({
      piPath: "/usr/local/bin/pi",
      realPiPath: "/opt/homebrew/bin/pi",
    });
    expect(await detectInstallMethod(resolve, real, exists)).toBe("brew");
  });

  it("returns npm when node_modules exists near pi", async () => {
    const { resolve, real, exists } = mockFs({
      piPath: "/usr/local/lib/node_modules/.bin/pi",
      hasNodeModules: true,
    });
    expect(await detectInstallMethod(resolve, real, exists)).toBe("npm");
  });

  it("returns npm when node_modules found via parent walk", async () => {
    const { resolve, real, exists } = mockFs({
      piPath: "/some/custom/path/bin/pi",
      hasNodeModules: true,
    });
    expect(await detectInstallMethod(resolve, real, exists)).toBe("npm");
  });

  it("returns vp via fallback when pi not found but vp exists", async () => {
    const { resolve, real, exists } = mockFs({
      piPath: undefined,
      fallbackCommands: { vp: "/usr/local/bin/vp" },
    });
    expect(await detectInstallMethod(resolve, real, exists)).toBe("vp");
  });

  it("returns bun via fallback when pi not found but bun exists", async () => {
    const { resolve, real, exists } = mockFs({
      piPath: undefined,
      fallbackCommands: { bun: "/usr/local/bin/bun" },
    });
    expect(await detectInstallMethod(resolve, real, exists)).toBe("bun");
  });

  it("returns npm via fallback when pi not found but npm exists", async () => {
    const { resolve, real, exists } = mockFs({
      piPath: undefined,
      fallbackCommands: { npm: "/usr/local/bin/npm" },
    });
    expect(await detectInstallMethod(resolve, real, exists)).toBe("npm");
  });

  it("returns brew via fallback when pi not found but brew exists", async () => {
    const { resolve, real, exists } = mockFs({
      piPath: undefined,
      fallbackCommands: { brew: "/usr/local/bin/brew" },
    });
    expect(await detectInstallMethod(resolve, real, exists)).toBe("brew");
  });

  it("returns native when no method is detected", async () => {
    const { resolve, real, exists } = mockFs({ piPath: undefined });
    expect(await detectInstallMethod(resolve, real, exists)).toBe("native");
  });

  it("prefers pi-path detection over fallback commands", async () => {
    const { resolve, real, exists } = mockFs({
      piPath: "/opt/homebrew/bin/pi",
      fallbackCommands: { vp: "/usr/local/bin/vp" },
    });
    expect(await detectInstallMethod(resolve, real, exists)).toBe("brew");
  });

  it("returns native when pi at /usr/local/bin/pi and nothing matches", async () => {
    const { resolve, real, exists } = mockFs({
      piPath: "/usr/local/bin/pi",
      hasNodeModules: false,
    });
    expect(await detectInstallMethod(resolve, real, exists)).toBe("native");
  });
});

// ===========================================================================
// runWithRetry
// ===========================================================================
describe("runWithRetry", () => {
  const dummySpec: CommandSpec = {
    command: "echo",
    args: ["hello"],
    label: "echo hello",
  };

  it("returns success on first try", async () => {
    const exec: ExecFunction = async () => ({
      stdout: "hello",
      stderr: "",
      code: 0,
    });
    const result = await runWithRetry(exec, dummySpec);
    expect(result.ok).toBe(true);
    expect(result.output).toBe("hello");
    expect(result.attempts).toBe(1);
  });

  it("retries on transient failure and succeeds on second attempt", async () => {
    let calls = 0;
    const exec: ExecFunction = async () => {
      calls++;
      if (calls === 1) return { stdout: "", stderr: "econnrefused", code: 1 };
      return { stdout: "ok", stderr: "", code: 0 };
    };
    const result = await runWithRetry(exec, dummySpec);
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("fails after max retries on persistent transient failure", async () => {
    const exec: ExecFunction = async () => ({
      stdout: "",
      stderr: "econnrefused",
      code: 1,
    });
    const result = await runWithRetry(exec, dummySpec);
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
  });

  it("does not retry on non-transient failure", async () => {
    const exec: ExecFunction = async () => ({
      stdout: "",
      stderr: "syntax error",
      code: 1,
    });
    const result = await runWithRetry(exec, dummySpec);
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
  });

  it("retries up to 3 times on persistent transient failures then stops", async () => {
    let calls = 0;
    const exec: ExecFunction = async () => {
      calls++;
      return { stdout: "", stderr: "ETIMEDOUT", code: 1 };
    };
    const result = await runWithRetry(exec, dummySpec);
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(calls).toBe(3);
  });
});