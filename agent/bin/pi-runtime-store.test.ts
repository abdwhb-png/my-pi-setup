import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  activateRelease,
  loadActivePiRuntime,
  loadCurrentPiRuntime,
  loadPreviousPiRuntime,
  resolvePiLaunchCommand,
  rollbackRelease,
} from "./pi-runtime-store.ts";

interface RuntimeFixture {
  homeDir: string;
  runtimeRoot: string;
}

function createFixture(): RuntimeFixture {
  const homeDir = mkdtempSync(join(tmpdir(), "pi-runtime-store-"));
  const runtimeRoot = join(homeDir, ".pi", "runtime", "pi-core");
  mkdirSync(join(runtimeRoot, "releases"), { recursive: true });
  return { homeDir, runtimeRoot };
}

function createRelease(runtimeRoot: string, releaseId: string): string {
  const releaseRoot = join(runtimeRoot, "releases", releaseId);
  const packageRoot = join(releaseRoot, "package");
  const executable = join(packageRoot, "dist", "pi");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.85.0" }),
  );
  writeFileSync(executable, "#!/usr/bin/env bun\n");
  chmodSync(executable, 0o755);
  writeFileSync(
    join(releaseRoot, "runtime-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      releaseId,
      createdAt: "2026-09-21T00:00:00.000Z",
      source: { repository: "/src/pi-core", commit: "abc123", dirty: false },
      executable: "package/dist/pi",
      packageRoot: "package",
      packages: [
        {
          name: "@earendil-works/pi-coding-agent",
          version: "0.85.0",
          tarball: "pi-coding-agent-0.85.0.tgz",
          sha256: "a".repeat(64),
        },
      ],
    }),
  );
  return releaseRoot;
}

function pointCurrent(runtimeRoot: string, releaseRoot: string): void {
  symlinkSync(releaseRoot, join(runtimeRoot, "current"));
}

describe("pi-runtime-store", () => {
  it("rejects a Bun entry that escapes the installed package", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-bun-entry-"));
    const packageRoot = join(root, "package");
    const bundle = join(packageRoot, "dist", "bundle", "cli.js");
    const bunEntry = join(packageRoot, "dist", "bun", "cli.js");
    const outside = join(root, "outside.js");
    mkdirSync(join(packageRoot, "dist", "bundle"), { recursive: true });
    mkdirSync(join(packageRoot, "dist", "bun"), { recursive: true });
    writeFileSync(outside, "process.exit(0);\n");
    symlinkSync(outside, bunEntry);

    expect(() => resolvePiLaunchCommand(bundle, packageRoot)).toThrow("Pi Bun entry escapes package root");
  });

  it("rejects a missing active release", () => {
    const { homeDir } = createFixture();

    expect(() => loadActivePiRuntime(homeDir)).toThrow("No active Pi runtime release");
  });

  it("rejects a malformed runtime manifest", () => {
    const { homeDir, runtimeRoot } = createFixture();
    const releaseRoot = createRelease(runtimeRoot, "release-a");
    writeFileSync(join(releaseRoot, "runtime-manifest.json"), "not-json");
    pointCurrent(runtimeRoot, releaseRoot);

    expect(() => loadActivePiRuntime(homeDir)).toThrow("Invalid Pi runtime manifest");
  });

  it("rejects manifest paths that escape the release", () => {
    const { homeDir, runtimeRoot } = createFixture();
    const releaseRoot = createRelease(runtimeRoot, "release-a");
    const manifestPath = join(releaseRoot, "runtime-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    manifest.executable = "../outside/pi";
    mkdirSync(join(runtimeRoot, "releases", "outside"), { recursive: true });
    writeFileSync(join(runtimeRoot, "releases", "outside", "pi"), "#!/usr/bin/env bun\n");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    pointCurrent(runtimeRoot, releaseRoot);

    expect(() => loadActivePiRuntime(homeDir)).toThrow("escapes release root");
  });

  it("rejects a missing runtime executable", () => {
    const { homeDir, runtimeRoot } = createFixture();
    const releaseRoot = createRelease(runtimeRoot, "release-a");
    rmSync(join(releaseRoot, "package", "dist", "pi"));
    pointCurrent(runtimeRoot, releaseRoot);

    expect(() => loadActivePiRuntime(homeDir)).toThrow("Pi runtime executable does not exist");
  });

  it("rejects a package root owned by another package", () => {
    const { homeDir, runtimeRoot } = createFixture();
    const releaseRoot = createRelease(runtimeRoot, "release-a");
    writeFileSync(join(releaseRoot, "package", "package.json"), JSON.stringify({ name: "wrong" }));
    pointCurrent(runtimeRoot, releaseRoot);

    expect(() => loadActivePiRuntime(homeDir)).toThrow(
      "Pi runtime package root is not @earendil-works/pi-coding-agent",
    );
  });

  it("atomically rotates current and previous releases", () => {
    const { homeDir, runtimeRoot } = createFixture();
    const releaseA = createRelease(runtimeRoot, "release-a");
    const releaseB = createRelease(runtimeRoot, "release-b");

    activateRelease(releaseA, runtimeRoot);
    expect(realpathSync(join(runtimeRoot, "current"))).toBe(realpathSync(releaseA));
    expect(existsSync(join(runtimeRoot, "previous"))).toBe(false);

    activateRelease(releaseB, runtimeRoot);
    expect(realpathSync(join(runtimeRoot, "current"))).toBe(realpathSync(releaseB));
    expect(realpathSync(join(runtimeRoot, "previous"))).toBe(realpathSync(releaseA));
    expect(loadActivePiRuntime(homeDir).releaseId).toBe("release-b");
    expect(loadCurrentPiRuntime(runtimeRoot).releaseId).toBe("release-b");
    expect(loadPreviousPiRuntime(runtimeRoot).releaseId).toBe("release-a");

    const restored = rollbackRelease(runtimeRoot);
    expect(restored.releaseId).toBe("release-a");
    expect(realpathSync(join(runtimeRoot, "current"))).toBe(realpathSync(releaseA));
    expect(realpathSync(join(runtimeRoot, "previous"))).toBe(realpathSync(releaseB));
  });

  it("rejects rollback without a previous release", () => {
    const { runtimeRoot } = createFixture();
    activateRelease(createRelease(runtimeRoot, "release-a"), runtimeRoot);

    expect(() => rollbackRelease(runtimeRoot)).toThrow("No previous Pi runtime release");
  });

  it("rejects activation outside the managed release directory", () => {
    const { runtimeRoot } = createFixture();
    const outsideRoot = join(runtimeRoot, "outside", basename(runtimeRoot));
    mkdirSync(join(outsideRoot, "package", "dist"), { recursive: true });

    expect(() => activateRelease(outsideRoot, runtimeRoot)).toThrow(
      "Pi runtime release is outside managed releases",
    );
  });
});
