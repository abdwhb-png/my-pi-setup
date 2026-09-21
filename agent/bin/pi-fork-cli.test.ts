import { describe, expect, it } from "bun:test";
import type { ActivePiRuntime } from "./pi-runtime-store.ts";
import { runPiForkCli, type PiForkCliDependencies } from "./pi-fork-cli.ts";

function runtime(releaseId = "release-a"): ActivePiRuntime {
  return {
    releaseId,
    releaseRoot: `/runtime/releases/${releaseId}`,
    executable: `/runtime/releases/${releaseId}/install/node_modules/@earendil-works/pi-coding-agent/dist/pi`,
    packageRoot: `/runtime/releases/${releaseId}/install/node_modules/@earendil-works/pi-coding-agent`,
    manifest: {
      schemaVersion: 1,
      releaseId,
      createdAt: "2026-09-21T00:00:00.000Z",
      source: { repository: "/src/pi-core", commit: "abc123", dirty: false },
      executable: "install/node_modules/@earendil-works/pi-coding-agent/dist/pi",
      packageRoot: "install/node_modules/@earendil-works/pi-coding-agent",
      packages: [],
    },
  };
}

function createDependencies() {
  const calls: string[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const dependencies: PiForkCliDependencies = {
    deploy: async () => {
      calls.push("deploy");
      return runtime("deployed");
    },
    rollback: async () => {
      calls.push("rollback");
      return runtime("restored");
    },
    loadCurrent: () => {
      calls.push("status");
      return runtime();
    },
    verify: () => {
      calls.push("verify");
      return { ok: true, errors: [] };
    },
    writeOutput: (message: string) => output.push(message),
    writeError: (message: string) => errors.push(message),
  };
  return { calls, output, errors, dependencies };
}

describe("pi-fork-cli", () => {
  it("rejects invalid arguments before dispatching stateful commands", async () => {
    const fixture = createDependencies();

    expect(await runPiForkCli([], fixture.dependencies)).toBe(2);
    expect(await runPiForkCli(["deploy", "extra"], fixture.dependencies)).toBe(2);
    expect(await runPiForkCli(["unknown"], fixture.dependencies)).toBe(2);

    expect(fixture.calls).toEqual([]);
    expect(fixture.errors.at(-1)).toContain("Usage:");
  });

  it("reports active release identity and immutable paths", async () => {
    const fixture = createDependencies();

    expect(await runPiForkCli(["status"], fixture.dependencies)).toBe(0);

    expect(fixture.calls).toEqual(["status"]);
    expect(fixture.output.join("\n")).toContain("release-a");
    expect(fixture.output.join("\n")).toContain("abc123");
    expect(fixture.output.join("\n")).toContain("/runtime/releases/release-a");
  });

  it("dispatches deploy and rollback exactly once", async () => {
    const deployFixture = createDependencies();
    const rollbackFixture = createDependencies();

    expect(await runPiForkCli(["deploy"], deployFixture.dependencies)).toBe(0);
    expect(await runPiForkCli(["rollback"], rollbackFixture.dependencies)).toBe(0);

    expect(deployFixture.calls).toEqual(["deploy"]);
    expect(deployFixture.output.join("\n")).toContain("deployed");
    expect(rollbackFixture.calls).toEqual(["rollback"]);
    expect(rollbackFixture.output.join("\n")).toContain("restored");
  });

  it("returns non-zero when verification fails", async () => {
    const fixture = createDependencies();
    fixture.dependencies.verify = () => {
      fixture.calls.push("verify");
      return { ok: false, errors: ["bad pin", "wrong package root"] };
    };

    expect(await runPiForkCli(["verify"], fixture.dependencies)).toBe(1);

    expect(fixture.calls).toEqual(["status", "verify"]);
    expect(fixture.errors).toEqual(["bad pin", "wrong package root"]);
  });

  it("reports command failures without dispatching a fallback", async () => {
    const fixture = createDependencies();
    fixture.dependencies.deploy = async () => {
      fixture.calls.push("deploy");
      throw new Error("build failed");
    };

    expect(await runPiForkCli(["deploy"], fixture.dependencies)).toBe(1);

    expect(fixture.calls).toEqual(["deploy"]);
    expect(fixture.errors).toEqual(["build failed"]);
  });
});
