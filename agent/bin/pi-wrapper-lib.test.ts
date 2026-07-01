import { describe, expect, it } from "bun:test";

describe("pi-wrapper-lib", () => {
  it("detects package mutation commands", async () => {
    const mod = await import("./pi-wrapper-lib.ts");
    expect(mod.isPackageMutationCommand(["install", "x"])).toBe(true);
    expect(mod.isPackageMutationCommand(["remove", "x"])).toBe(true);
    expect(mod.isPackageMutationCommand(["uninstall", "x"])).toBe(true);
    expect(mod.isPackageMutationCommand(["update"])).toBe(true);
    expect(mod.isPackageMutationCommand(["list"])).toBe(false);
    expect(mod.isPackageMutationCommand(["--role", "ask"])).toBe(false);
  });
});
