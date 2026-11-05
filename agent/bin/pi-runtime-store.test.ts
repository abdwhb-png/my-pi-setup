import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { cleanupRuntimes } from "./setup/cleanup.ts";
import { acquireRuntimeStorageLock, pinRuntimeEntry, runtimeProcessIdentity } from "../extensions/_shared/runtime-storage.ts";
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
  it('refuses runtime cleanup for an unknown installation-state version', async () => {
    const { homeDir, runtimeRoot } = createFixture();
    try {
      const release = createRelease(runtimeRoot, 'retained');
      chmodSync(join(runtimeRoot, 'releases'), 0o755);
      activateRelease(release, runtimeRoot);
      writeFileSync(join(homeDir, '.pi/.pi-setup-state.json'), JSON.stringify({ schemaVersion: 99, managed: {} }));
      await expect(cleanupRuntimes(join(homeDir, '.pi'))).rejects.toThrow('setup installation state');
      expect(existsSync(release)).toBe(true);
    } finally { rmSync(homeDir, { recursive: true, force: true }); }
  });

  it.each([1, 2])('retains runtime resources referenced by a portable installation snapshot (schema %s)', async (schemaVersion) => {
    const { homeDir, runtimeRoot } = createFixture();
    const root = join(homeDir, '.pi');
    try {
      const snapshot = createRelease(runtimeRoot, 'snapshot');
      const current = createRelease(runtimeRoot, 'current');
      chmodSync(join(runtimeRoot, 'releases'), 0o755); activateRelease(current, runtimeRoot);
      writeFileSync(join(root, '.pi-setup-state.json'), JSON.stringify({ schemaVersion, managed: {
        'runtime/pi-core/releases/snapshot/runtime-manifest.json': 'snapshot fingerprint',
      } }));
      const report = await cleanupRuntimes(root);
      expect(report.entries).toContainEqual(expect.objectContaining({ path: snapshot, action: 'keep', reason: 'managed setup snapshot' }));
    } finally { rmSync(homeDir, { recursive: true, force: true }); }
  });

  it('keeps releases referenced by installed package links', async () => {
    const { homeDir, runtimeRoot } = createFixture();
    const root = join(homeDir, '.pi');
    try {
      const linked = createRelease(runtimeRoot, 'linked');
      const current = createRelease(runtimeRoot, 'current');
      chmodSync(join(runtimeRoot, 'releases'), 0o755);
      activateRelease(current, runtimeRoot);
      mkdirSync(join(root, 'agent/node_modules'), { recursive: true });
      symlinkSync(join(linked, 'package'), join(root, 'agent/node_modules/fixture'));
      await cleanupRuntimes(root);
      expect(existsSync(linked)).toBe(true);
    } finally { rmSync(homeDir, { recursive: true, force: true }); }
  });

  it('retains an older runtime pinned by the current process and ignores a reused PID identity', async () => {
    const { homeDir, runtimeRoot } = createFixture();
    const root = join(homeDir, '.pi');
    try {
      const old = createRelease(runtimeRoot, 'live');
      const previous = createRelease(runtimeRoot, 'previous');
      const current = createRelease(runtimeRoot, 'current');
      chmodSync(join(runtimeRoot, 'releases'), 0o755);
      chmodSync(old, 0o755);
      activateRelease(previous, runtimeRoot); activateRelease(current, runtimeRoot);
      const binary = join(old, 'package/dist/pi');
      expect(pinRuntimeEntry(root, () => binary)).toBe(binary);
      const live = await cleanupRuntimes(root);
      expect(live.entries).toContainEqual(expect.objectContaining({ path: old, action: 'keep', reason: `live session PID ${process.pid}` }));
      const identity = runtimeProcessIdentity()!;
      const file = join(`${root}.runtime-users`, `${identity.pid}-${identity.started}.json`);
      const record = JSON.parse(readFileSync(file, 'utf8')); record.started = '0';
      const stale = join(`${root}.runtime-users`, `${identity.pid}-0.json`);
      renameSync(file, stale); writeFileSync(stale, JSON.stringify(record));
      await cleanupRuntimes(root);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(stale)).toBe(false);
    } finally { rmSync(homeDir, { recursive: true, force: true }); }
  });

  it('refuses cleanup while promotion holds the kernel lock', async () => {
    const { homeDir } = createFixture();
    const root = join(homeDir, '.pi');
    const lock = acquireRuntimeStorageLock(root);
    try {
      await expect(cleanupRuntimes(root)).rejects.toThrow('Runtime storage is busy');
      const alias = join(homeDir, 'alias'); symlinkSync(root, alias);
      expect(() => acquireRuntimeStorageLock(alias)).toThrow('Runtime storage is busy');
    }
    finally { lock.release(); rmSync(homeDir, { recursive: true, force: true }); }
  });

  it('preserves unknown directories and symlink targets outside the store', async () => {
    const { homeDir, runtimeRoot } = createFixture();
    const root = join(homeDir, '.pi');
    try {
      const current = createRelease(runtimeRoot, 'current');
      chmodSync(join(runtimeRoot, 'releases'), 0o755);
      activateRelease(current, runtimeRoot);
      const unknown = join(runtimeRoot, 'releases/unknown'); mkdirSync(unknown);
      const outside = join(homeDir, 'personal'); mkdirSync(outside); writeFileSync(join(outside, 'keep.txt'), 'keep');
      symlinkSync(outside, join(runtimeRoot, 'releases/redirect'));
      const report = await cleanupRuntimes(root);
      expect(report.entries).toContainEqual(expect.objectContaining({ path: unknown, action: 'keep', reason: 'unrecognized runtime metadata' }));
      expect(report.warnings.some(warning => warning.includes('/redirect'))).toBe(true);
      expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    } finally { rmSync(homeDir, { recursive: true, force: true }); }
  });

  it("previews and removes only unreferenced releases and inactive promotion states", async () => {
    const { homeDir, runtimeRoot } = createFixture();
    const root = join(homeDir, '.pi');
    try {
      const obsolete = createRelease(runtimeRoot, 'obsolete');
      const pinned = createRelease(runtimeRoot, 'package-pinned');
      const previous = createRelease(runtimeRoot, 'previous');
      const current = createRelease(runtimeRoot, 'current');
      chmodSync(join(runtimeRoot, 'releases'), 0o755);
      activateRelease(obsolete, runtimeRoot);
      activateRelease(previous, runtimeRoot);
      activateRelease(current, runtimeRoot);
      mkdirSync(join(root, 'agent'));
      writeFileSync(join(root, 'agent/package.json'), JSON.stringify({
        dependencies: { fixture: 'file:../runtime/pi-core/releases/package-pinned/package' },
      }));
      const preview = await cleanupRuntimes(root, true);
      expect(preview.entries).toContainEqual(expect.objectContaining({ path: obsolete, action: 'remove' }));
      expect(existsSync(obsolete)).toBe(true);
      await cleanupRuntimes(root);
      expect(existsSync(obsolete)).toBe(false);
      for (const kept of [current, previous, pinned]) expect(existsSync(kept)).toBe(true);
      expect(loadCurrentPiRuntime(runtimeRoot).releaseId).toBe('current');
      expect(loadPreviousPiRuntime(runtimeRoot).releaseId).toBe('previous');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

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
