import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateRelease } from "./pi-runtime-store.ts";
import { deployFork, rollbackFork, verifyRuntimeCoherence } from "./pi-fork-release.ts";

interface DeploymentFixture {
  root: string;
  sourceRoot: string;
  runtimeRoot: string;
  agentDir: string;
  sfwExecutable: string;
}

function createDeploymentFixture(options: { failAgentInstall?: boolean; failSmoke?: boolean; cliPath?: string; bunEntrypoint?: boolean; rpcResponseId?: string; nestedRuntimeVersion?: string } = {}): DeploymentFixture {
  const root = mkdtempSync(join(tmpdir(), "pi-fork-release-"));
  const sourceRoot = join(root, "pi-core");
  const runtimeRoot = join(root, ".pi", "runtime", "pi-core");
  const agentDir = join(root, ".pi", "agent");
  const toolsDir = join(root, "tools");
  mkdirSync(join(sourceRoot, "scripts"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(toolsDir, { recursive: true });
  writeFileSync(join(sourceRoot, "package.json"), JSON.stringify({ name: "pi-monorepo" }));
  writeFakeReleaseBuilder(sourceRoot);
  writeAgentManifest(agentDir);
  writeFileSync(join(agentDir, "bun.lock"), "old-lock\n");

  const sfwExecutable = join(toolsDir, "sfw");
  writeFakeSfw(sfwExecutable, agentDir, options);
  return { root, sourceRoot, runtimeRoot, agentDir, sfwExecutable };
}

function writeFakeReleaseBuilder(sourceRoot: string): void {
  writeFileSync(
    join(sourceRoot, "scripts", "local-release.mjs"),
    `import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
const args = process.argv.slice(2);
const out = args[args.indexOf("--out") + 1];
mkdirSync(join(out, "tarballs"), { recursive: true });
const specs = [
  ["@earendil-works/pi-coding-agent", "0.85.0", "pi-coding-agent-0.85.0.tgz"],
  ["@earendil-works/pi-tui", "0.85.0", "pi-tui-0.85.0.tgz"],
];
const packages = specs.map(([name, version, filename]) => {
  const tarball = join(out, "tarballs", filename);
  writeFileSync(tarball, name + "@" + version);
  return { name, version, tarball: relative(out, tarball), sha256: createHash("sha256").update(name + "@" + version).digest("hex") };
});
writeFileSync(join(out, "release-manifest.json"), JSON.stringify({
  schemaVersion: 1,
  source: { repository: process.cwd(), commit: "abcdef1234567890", dirty: false },
  packages,
}));
writeFileSync(join(process.cwd(), "builder-out.txt"), out);
writeFileSync(join(process.cwd(), "builder-args.json"), JSON.stringify(args));
`,
  );
}

function writeAgentManifest(agentDir: string): void {
  writeFileSync(
    join(agentDir, "package.json"),
    `{
  "name": "agent",
  "private": true,
  "dependencies": {
    "@earendil-works/pi-coding-agent": "file:../../../pi-core/packages/coding-agent",
    "@earendil-works/pi-tui": "0.84.2",
    "yaml": "2.9.0"
  },
  "devDependencies": {
    "@abdwhb-png/pi-test-harness": "file:/old-harness.tgz",
    "@abdwhb-png/pi-test-harness": "file:/stable-harness",
    "typescript": "7.0.2"
  }
}\n`,
  );
}

function writeFakeSfw(
  executable: string,
  agentDir: string,
  options: { failAgentInstall?: boolean; failSmoke?: boolean; cliPath?: string; bunEntrypoint?: boolean; rpcResponseId?: string; nestedRuntimeVersion?: string },
): void {
  writeFileSync(
    executable,
    `#!/usr/bin/env bun
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
if (process.argv[2] === "--version") {
  console.log("sfw-test");
  process.exit(0);
}
if (process.argv[2] !== "bun" || process.argv[3] !== "install") process.exit(90);
const cwd = process.cwd();
if (${JSON.stringify(options.failAgentInstall === true)} && cwd === ${JSON.stringify(agentDir)}) {
  writeFileSync(join(cwd, "bun.lock"), "broken-lock\\n");
  process.exit(41);
}
const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
for (const [name] of Object.entries(manifest.dependencies ?? {})) {
  if (!name.startsWith("@earendil-works/")) continue;
  const packageRoot = join(cwd, "node_modules", ...name.split("/"));
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name,
    version: "0.85.0",
    ...(name === "@earendil-works/pi-coding-agent" ? { bin: { pi: ${JSON.stringify(options.cliPath ?? "dist/pi")} } } : {}),
  }));
  if (name === "@earendil-works/pi-coding-agent") {
    const pi = join(packageRoot, ${JSON.stringify(options.cliPath ?? "dist/pi")});
    mkdirSync(dirname(pi), { recursive: true });
    writeFileSync(pi, ${JSON.stringify(`#!/usr/bin/env bun
const args = process.argv.slice(2);
if (${options.failSmoke === true ? "true" : "false"}) process.exit(42);
if (args.includes("--version")) { console.log("0.85.0"); process.exit(0); }
const extensionIndex = args.indexOf("--extension");
if (extensionIndex >= 0) {
  const loaded = await import(args[extensionIndex + 1]);
  await loaded.default?.({});
}
if (args.includes("--mode") && args[args.indexOf("--mode") + 1] === "rpc") {
  console.log(JSON.stringify({ id: ${JSON.stringify(options.rpcResponseId ?? "pi-runtime-smoke")}, type: "response", command: "get_state", success: true, data: {} }));
  process.exit(0);
}
process.exit(0);
`)});
    chmodSync(pi, 0o755);
    if (${JSON.stringify(options.bunEntrypoint === true)}) {
      const bunEntry = join(packageRoot, "dist", "bun", "cli.js");
      mkdirSync(dirname(bunEntry), { recursive: true });
      copyFileSync(pi, bunEntry);
      writeFileSync(pi, "#!/usr/bin/env node\\nprocess.exit(42);\\n");
    }
  }
}
if (cwd !== ${JSON.stringify(agentDir)} && ${JSON.stringify(options.nestedRuntimeVersion !== undefined)}) {
  const nested = join(cwd, "node_modules", "external", "node_modules", "@earendil-works", "pi-tui");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui", version: ${JSON.stringify(options.nestedRuntimeVersion ?? "")} }));
}
writeFileSync(join(cwd, "bun.lock"), "installed-lock\\n");
`,
  );
  chmodSync(executable, 0o755);
}

function createExistingRelease(runtimeRoot: string): string {
  const releaseRoot = join(runtimeRoot, "releases", "existing");
  const packageRoot = join(releaseRoot, "package");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
  writeFileSync(join(packageRoot, "dist", "pi"), "#!/usr/bin/env bun\n");
  chmodSync(join(packageRoot, "dist", "pi"), 0o755);
  writeFileSync(
    join(releaseRoot, "runtime-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      releaseId: "existing",
      createdAt: "2026-09-21T00:00:00.000Z",
      source: { repository: "/old", commit: "old", dirty: false },
      executable: "package/dist/pi",
      packageRoot: "package",
      packages: [],
    }),
  );
  return releaseRoot;
}

async function deploy(fixture: DeploymentFixture) {
  return deployFork({
    sourceRoot: fixture.sourceRoot,
    runtimeRoot: fixture.runtimeRoot,
    agentDir: fixture.agentDir,
    nodeExecutable: process.execPath,
    sfwExecutable: fixture.sfwExecutable,
  });
}

async function expectFailure(action: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await action();
  } catch (cause) {
    expect(cause).toBeInstanceOf(Error);
    expect(cause instanceof Error ? cause.message : String(cause)).toContain(message);
    return;
  }
  throw new Error(`Expected failure containing: ${message}`);
}

describe("pi-fork-release", () => {
  it("records the package bin and smoke-tests its Bun entry", async () => {
    const fixture = createDeploymentFixture({ cliPath: "dist/bundle/cli.js", bunEntrypoint: true });

    const runtime = await deploy(fixture);

    expect(runtime.executable).toBe(join(runtime.packageRoot, "dist", "bundle", "cli.js"));
  });

  it("builds below staging and pins every release tarball", async () => {
    const fixture = createDeploymentFixture();

    const runtime = await deploy(fixture);
    const builderOut = readFileSync(join(fixture.sourceRoot, "builder-out.txt"), "utf-8");
    expect(builderOut.startsWith(join(fixture.runtimeRoot, ".staging"))).toBe(true);

    const agentManifestText = readFileSync(join(fixture.agentDir, "package.json"), "utf-8");
    const agentManifest = JSON.parse(agentManifestText);
    for (const pkg of runtime.manifest.packages) {
      expect(agentManifest.dependencies[pkg.name]).toBe(agentManifest.overrides[pkg.name]);
      expect(agentManifest.dependencies[pkg.name]).toContain(`/releases/${runtime.releaseId}/`);
    }
    expect(agentManifestText.match(/"@abdwhb-png\/pi-test-harness"/g)).toHaveLength(1);
    expect(verifyRuntimeCoherence(runtime, fixture.agentDir)).toEqual({ ok: true, errors: [] });
  });

  it("leaves upstream tests and formatting untouched during deployment", async () => {
    const fixture = createDeploymentFixture();

    await deploy(fixture);

    const builderArgs = JSON.parse(readFileSync(join(fixture.sourceRoot, "builder-args.json"), "utf-8"));
    expect(builderArgs).toContain("--skip-test");
    expect(builderArgs).toContain("--skip-check");
  });

  it("rejects a nested Pi version inside the isolated runtime", async () => {
    const fixture = createDeploymentFixture({ nestedRuntimeVersion: "9.0.0" });

    await expectFailure(() => deploy(fixture), "@earendil-works/pi-tui: nested runtime version 9.0.0 != 0.85.0");
    expect(existsSync(join(fixture.runtimeRoot, "current"))).toBe(false);
  });

  it("ignores unrelated dangling package links during coherence verification", async () => {
    const fixture = createDeploymentFixture();
    const runtime = await deploy(fixture);
    symlinkSync(join(fixture.root, "missing-external-package"), join(fixture.agentDir, "node_modules", "old-external-package"));

    expect(verifyRuntimeCoherence(runtime, fixture.agentDir)).toEqual({ ok: true, errors: [] });
  });

  it("uses the host Pi graph instead of extension-local development packages", async () => {
    const fixture = createDeploymentFixture();
    const runtime = await deploy(fixture);
    const nestedRoot = join(fixture.agentDir, "node_modules", "external-extension", "node_modules", "@earendil-works", "pi-ai");
    mkdirSync(nestedRoot, { recursive: true });
    writeFileSync(join(nestedRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.81.0" }));

    expect(verifyRuntimeCoherence(runtime, fixture.agentDir)).toEqual({ ok: true, errors: [] });

    writeFileSync(
      join(fixture.agentDir, "node_modules", "@earendil-works", "pi-tui", "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-tui", version: "0.81.0" }),
    );
    expect(verifyRuntimeCoherence(runtime, fixture.agentDir).errors).toContain(
      "@earendil-works/pi-tui: agent version 0.81.0 != 0.85.0",
    );
  });

  it("restores agent files when its install fails", async () => {
    const fixture = createDeploymentFixture({ failAgentInstall: true });
    const packageBefore = readFileSync(join(fixture.agentDir, "package.json"), "utf-8");
    const lockBefore = readFileSync(join(fixture.agentDir, "bun.lock"), "utf-8");

    await expectFailure(() => deploy(fixture), "Command failed");

    expect(readFileSync(join(fixture.agentDir, "package.json"), "utf-8")).toBe(packageBefore);
    expect(readFileSync(join(fixture.agentDir, "bun.lock"), "utf-8")).toBe(lockBefore);
    expect(existsSync(join(fixture.runtimeRoot, "current"))).toBe(false);
  });

  it("does not activate a release that fails smoke checks", async () => {
    const fixture = createDeploymentFixture({ failSmoke: true });

    await expectFailure(() => deploy(fixture), "Pi runtime smoke check failed");

    expect(existsSync(join(fixture.runtimeRoot, "current"))).toBe(false);
  });

  it("rejects an RPC response for a different request", async () => {
    const fixture = createDeploymentFixture({ rpcResponseId: "smoke" });

    await expectFailure(() => deploy(fixture), "RPC exited");

    expect(existsSync(join(fixture.runtimeRoot, "current"))).toBe(false);
  });

  it("activates only after validation and rotates the previous release", async () => {
    const fixture = createDeploymentFixture();
    const existingRelease = createExistingRelease(fixture.runtimeRoot);
    activateRelease(existingRelease, fixture.runtimeRoot);

    const runtime = await deploy(fixture);

    expect(realpathSync(join(fixture.runtimeRoot, "current"))).toBe(realpathSync(runtime.releaseRoot));
    expect(realpathSync(join(fixture.runtimeRoot, "previous"))).toBe(realpathSync(existingRelease));
  });

  it("synchronizes agent pins before rolling back the active release", async () => {
    const fixture = createDeploymentFixture();
    const first = await deploy(fixture);
    const builderPath = join(fixture.sourceRoot, "scripts", "local-release.mjs");
    writeFileSync(
      builderPath,
      readFileSync(builderPath, "utf-8").replace("abcdef1234567890", "bbbbbb1234567890"),
    );
    const second = await deploy(fixture);

    const restored = await rollbackFork({
      runtimeRoot: fixture.runtimeRoot,
      agentDir: fixture.agentDir,
      sfwExecutable: fixture.sfwExecutable,
    });

    expect(restored.releaseId).toBe(first.releaseId);
    expect(restored.releaseId).not.toBe(second.releaseId);
    expect(realpathSync(join(fixture.runtimeRoot, "current"))).toBe(realpathSync(first.releaseRoot));
    expect(verifyRuntimeCoherence(restored, fixture.agentDir)).toEqual({ ok: true, errors: [] });
  });

  it("rejects a release manifest with a wrong tarball hash", async () => {
    const fixture = createDeploymentFixture();
    writeFileSync(
      join(fixture.sourceRoot, "scripts", "local-release.mjs"),
      readFileSync(join(fixture.sourceRoot, "scripts", "local-release.mjs"), "utf-8").replace(
        'digest("hex")',
        'digest("hex").replace(/^./, "0")',
      ),
    );

    await expectFailure(() => deploy(fixture), "Tarball hash mismatch");
    expect(existsSync(join(fixture.runtimeRoot, "current"))).toBe(false);
  });
});
