import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  activateRelease,
  getPiRuntimeRoot,
  loadPreviousPiRuntime,
  resolvePiLaunchCommand,
  rollbackRelease,
  type ActivePiRuntime,
  type PiRuntimeManifest,
  type PiRuntimePackage,
} from "./pi-runtime-store.ts";

const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const RELEASE_MANIFEST = "release-manifest.json";
const RUNTIME_MANIFEST = "runtime-manifest.json";

type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue | undefined };

interface PackedReleaseManifest {
  schemaVersion: 1;
  source: PiRuntimeManifest["source"];
  packages: PiRuntimePackage[];
}

export interface DeployForkOptions {
  sourceRoot?: string;
  runtimeRoot?: string;
  agentDir?: string;
  nodeExecutable?: string;
  sfwExecutable?: string;
}

export interface CoherenceReport {
  ok: boolean;
  errors: string[];
}

export interface RollbackForkOptions {
  runtimeRoot?: string;
  agentDir?: string;
  sfwExecutable?: string;
}

interface DeploymentContext {
  sourceRoot: string;
  runtimeRoot: string;
  agentDir: string;
  nodeExecutable: string;
  sfwExecutable: string;
}

interface AgentFilesBackup {
  packageJson: Buffer;
  lockfile?: Buffer;
}

export async function deployFork(options: DeployForkOptions = {}): Promise<ActivePiRuntime> {
  const context = resolveDeploymentContext(options);
  verifySourceRoot(context.sourceRoot);
  runCommand(context.sfwExecutable, ["--version"]);
  const runtime = await buildImmutableRelease(context);
  const agentBackup = captureAgentFiles(context.agentDir);

  try {
    await synchronizeAgentPiPins(runtime, context.agentDir, context.sfwExecutable);
    const report = verifyRuntimeCoherence(runtime, context.agentDir);
    if (!report.ok) {
      throw new Error(`Pi runtime coherence check failed:\n${report.errors.join("\n")}`);
    }
    activateRelease(runtime.releaseRoot, context.runtimeRoot);
    return runtime;
  } catch (cause) {
    restoreAgentFiles(context.agentDir, agentBackup);
    throw cause;
  }
}

export async function rollbackFork(
  options: RollbackForkOptions = {},
): Promise<ActivePiRuntime> {
  const runtimeRoot = resolve(options.runtimeRoot ?? getPiRuntimeRoot());
  const agentDir = resolve(options.agentDir ?? join(homedir(), ".pi", "agent"));
  const sfwExecutable = options.sfwExecutable ?? "sfw";
  const previous = loadPreviousPiRuntime(runtimeRoot);
  const agentBackup = captureAgentFiles(agentDir);

  try {
    await synchronizeAgentPiPins(previous, agentDir, sfwExecutable);
    const report = verifyRuntimeCoherence(previous, agentDir);
    if (!report.ok) {
      throw new Error(`Pi runtime coherence check failed:\n${report.errors.join("\n")}`);
    }
    return rollbackRelease(runtimeRoot);
  } catch (cause) {
    restoreAgentFiles(agentDir, agentBackup);
    throw cause;
  }
}

function resolveDeploymentContext(options: DeployForkOptions): DeploymentContext {
  return {
    sourceRoot: resolve(options.sourceRoot ?? join(homedir(), "projects", "pi-core")),
    runtimeRoot: resolve(options.runtimeRoot ?? getPiRuntimeRoot()),
    agentDir: resolve(options.agentDir ?? join(homedir(), ".pi", "agent")),
    nodeExecutable: options.nodeExecutable ?? "node",
    sfwExecutable: options.sfwExecutable ?? "sfw",
  };
}

async function buildImmutableRelease(context: DeploymentContext): Promise<ActivePiRuntime> {
  const stagingRoot = join(context.runtimeRoot, ".staging", randomUUID());
  const packedRoot = join(stagingRoot, "packed");
  mkdirSync(join(context.runtimeRoot, ".staging"), { recursive: true });
  mkdirSync(join(context.runtimeRoot, "releases"), { recursive: true });

  try {
    const packedManifest = buildPackedRelease(context, packedRoot);
    const releaseId = createReleaseId(packedManifest);
    const finalRoot = join(context.runtimeRoot, "releases", releaseId);
    if (existsSync(finalRoot)) throw new Error(`Pi runtime release already exists: ${finalRoot}`);

    const installRoot = installPackedRelease(context, stagingRoot, packedRoot, packedManifest);
    const stagedRuntime = createStagedRuntime({
      releaseId,
      stagingRoot,
      packedManifest,
      installRoot,
      packedRoot,
    });
    await runRuntimeSmokeChecks(stagedRuntime);
    writeFileSync(join(stagingRoot, RUNTIME_MANIFEST), formatJson(stagedRuntime.manifest));
    renameSync(stagingRoot, finalRoot);
    makeTreeReadOnly(finalRoot);
    return relocateRuntime(stagedRuntime, stagingRoot, finalRoot);
  } catch (cause) {
    if (existsSync(stagingRoot)) removeReadOnlyTree(stagingRoot);
    throw cause;
  }
}

function buildPackedRelease(
  context: DeploymentContext,
  packedRoot: string,
): PackedReleaseManifest {
  runCommand(
    context.nodeExecutable,
    [join(context.sourceRoot, "scripts", "local-release.mjs"), "--out", packedRoot, "--skip-install", "--skip-test", "--skip-check"],
    context.sourceRoot,
  );
  const manifest = readPackedReleaseManifest(join(packedRoot, RELEASE_MANIFEST));
  verifyPackedTarballs(manifest, packedRoot);
  return manifest;
}

function installPackedRelease(
  context: DeploymentContext,
  stagingRoot: string,
  packedRoot: string,
  manifest: PackedReleaseManifest,
): string {
  const installRoot = join(stagingRoot, "install");
  mkdirSync(installRoot);
  writeFileSync(
    join(installRoot, "package.json"),
    formatJson(createInstallManifest(manifest, packedRoot, installRoot)),
  );
  runCommand(
    context.sfwExecutable,
    ["bun", "install", "--production", "--ignore-scripts"],
    installRoot,
  );
  return installRoot;
}

function captureAgentFiles(agentDir: string): AgentFilesBackup {
  const lockPath = join(agentDir, "bun.lock");
  return {
    packageJson: readFileSync(join(agentDir, "package.json")),
    lockfile: existsSync(lockPath) ? readFileSync(lockPath) : undefined,
  };
}

function restoreAgentFiles(agentDir: string, backup: AgentFilesBackup): void {
  writeFileSync(join(agentDir, "package.json"), backup.packageJson);
  const lockPath = join(agentDir, "bun.lock");
  if (backup.lockfile === undefined) rmSync(lockPath, { force: true });
  else writeFileSync(lockPath, backup.lockfile);
}

export async function synchronizeAgentPiPins(
  runtime: ActivePiRuntime,
  agentDir = join(homedir(), ".pi", "agent"),
  sfwExecutable = "sfw",
): Promise<void> {
  const packagePath = join(agentDir, "package.json");
  const lockPath = join(agentDir, "bun.lock");
  const packageBackup = readFileSync(packagePath);
  const lockExisted = existsSync(lockPath);
  const lockBackup = lockExisted ? readFileSync(lockPath) : undefined;

  try {
    const manifest = readJsonObject(packagePath, "Invalid agent package.json");
    const dependencies = optionalObject(manifest.dependencies);
    const overrides = optionalObject(manifest.overrides);
    for (const pkg of runtime.manifest.packages) {
      const pin = packageFileSpecifier(agentDir, join(runtime.releaseRoot, pkg.tarball));
      dependencies[pkg.name] = pin;
      overrides[pkg.name] = pin;
    }
    manifest.dependencies = dependencies;
    manifest.overrides = overrides;
    manifest.devDependencies = optionalObject(manifest.devDependencies);
    writeFileSync(packagePath, formatJson(manifest));

    runCommand(sfwExecutable, ["bun", "install", "--ignore-scripts"], agentDir);
  } catch (cause) {
    writeFileSync(packagePath, packageBackup);
    if (lockBackup !== undefined) writeFileSync(lockPath, lockBackup);
    else if (!lockExisted) rmSync(lockPath, { force: true });
    throw cause;
  }
}

export function verifyRuntimeCoherence(
  runtime: ActivePiRuntime,
  agentDir = join(homedir(), ".pi", "agent"),
): CoherenceReport {
  const errors: string[] = [];
  let agentManifest: JsonObject;
  try {
    agentManifest = readJsonObject(join(agentDir, "package.json"), "Invalid agent package.json");
  } catch (cause) {
    return { ok: false, errors: [errorMessage(cause)] };
  }

  const dependencies = optionalObject(agentManifest.dependencies);
  const overrides = optionalObject(agentManifest.overrides);
  const expectedPackages = new Map(runtime.manifest.packages.map((pkg) => [pkg.name, pkg]));
  for (const pkg of runtime.manifest.packages) {
    const expectedPin = packageFileSpecifier(agentDir, join(runtime.releaseRoot, pkg.tarball));
    if (dependencies[pkg.name] !== expectedPin) {
      errors.push(`${pkg.name}: dependency is not pinned to active release tarball`);
    }
    if (overrides[pkg.name] !== expectedPin) {
      errors.push(`${pkg.name}: override is not pinned to active release tarball`);
    }
    verifyInstalledPackage(
      join(runtime.releaseRoot, "install", "node_modules", ...pkg.name.split("/")),
      pkg,
      "runtime",
      errors,
    );
    verifyInstalledPackage(
      join(agentDir, "node_modules", ...pkg.name.split("/")),
      pkg,
      "agent",
      errors,
    );
  }
  scanNestedInternalPackages(
    join(runtime.releaseRoot, "install", "node_modules"),
    expectedPackages,
    "runtime",
    errors,
  );
  // Pi's extension loader aliases framework imports to the host; extension-local dev installs are not this runtime's graph.

  if (!isWithin(runtime.releaseRoot, runtime.packageRoot)) {
    errors.push("Active Pi package root is outside active release");
  }
  if (!isWithin(runtime.releaseRoot, runtime.executable)) {
    errors.push("Active Pi executable is outside active release");
  }
  return { ok: errors.length === 0, errors };
}

function createStagedRuntime(options: {
  releaseId: string;
  stagingRoot: string;
  packedManifest: PackedReleaseManifest;
  installRoot: string;
  packedRoot: string;
}): ActivePiRuntime {
  const { releaseId, stagingRoot, packedManifest, installRoot, packedRoot } = options;
  const packageRoot = realpathSync(
    join(installRoot, "node_modules", ...PI_CODING_AGENT_PACKAGE.split("/")),
  );
  const packageManifest = readJsonObject(
    join(packageRoot, "package.json"),
    "Invalid installed Pi package manifest",
  );
  if (packageManifest.name !== PI_CODING_AGENT_PACKAGE) {
    throw new Error(`Installed package is not ${PI_CODING_AGENT_PACKAGE}`);
  }
  const executable = realpathSync(
    resolve(packageRoot, requireNonEmptyString(requireObject(packageManifest.bin).pi)),
  );
  if (!isWithin(packageRoot, executable)) {
    throw new Error("Installed Pi executable is outside its package root");
  }

  const packages = packedManifest.packages.map((pkg) => ({
    ...pkg,
    tarball: relative(stagingRoot, resolvePackedPath(packedRoot, pkg.tarball)).replaceAll(sep, "/"),
  }));
  const manifest: PiRuntimeManifest = {
    schemaVersion: 1,
    releaseId,
    createdAt: new Date().toISOString(),
    source: packedManifest.source,
    executable: relative(stagingRoot, executable).replaceAll(sep, "/"),
    packageRoot: relative(stagingRoot, packageRoot).replaceAll(sep, "/"),
    packages,
  };
  return { releaseId, releaseRoot: stagingRoot, executable, packageRoot, manifest };
}

function relocateRuntime(
  runtime: ActivePiRuntime,
  oldRoot: string,
  releaseRoot: string,
): ActivePiRuntime {
  const relocate = (path: string) => join(releaseRoot, relative(oldRoot, path));
  return {
    ...runtime,
    releaseRoot,
    executable: relocate(runtime.executable),
    packageRoot: relocate(runtime.packageRoot),
  };
}

async function runRuntimeSmokeChecks(runtime: ActivePiRuntime): Promise<void> {
  const launch = resolvePiLaunchCommand(runtime.executable, runtime.packageRoot);
  const version = spawnSync(launch.command, [...launch.prefixArgs, "--version"], {
    cwd: runtime.releaseRoot,
    encoding: "utf-8",
    env: { ...process.env, PI_OFFLINE: "1" },
  });
  if (version.status !== 0) {
    throw new Error(`Pi runtime smoke check failed: --version exited ${String(version.status)}`);
  }

  const marker = join(runtime.releaseRoot, ".extension-smoke-ok");
  const extension = join(runtime.releaseRoot, "smoke-extension.mjs");
  writeFileSync(
    extension,
    `import { writeFileSync } from "node:fs";\nexport default function () {\n  if (process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT !== ${JSON.stringify(runtime.packageRoot)}) throw new Error("wrong subagent package root");\n  writeFileSync(${JSON.stringify(marker)}, "ok");\n}\n`,
  );
  await runRpcSmoke(runtime, extension, launch);
  if (!existsSync(marker)) {
    throw new Error("Pi runtime smoke check failed: explicit extension did not load");
  }
  rmSync(marker, { force: true });
  rmSync(extension, { force: true });
}

function runRpcSmoke(
  runtime: ActivePiRuntime,
  extension: string,
  launch: ReturnType<typeof resolvePiLaunchCommand>,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      launch.command,
      [
        ...launch.prefixArgs,
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--offline",
        "--extension",
        extension,
      ],
      {
        cwd: runtime.releaseRoot,
        env: {
          ...process.env,
          PI_OFFLINE: "1",
          PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: runtime.packageRoot,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill("SIGTERM");
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const timeout = setTimeout(
      () => finish(new Error(`Pi runtime smoke check failed: RPC timeout. ${stderr}`)),
      10_000,
    );
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as { id?: string; success?: boolean };
          if (message.id === "pi-runtime-smoke" && message.success === true) finish();
        } catch {
          // RPC stdout may contain startup text before its first JSONL response.
        }
      }
    });
    child.once("error", (cause) => finish(new Error("Pi runtime smoke check failed", { cause })));
    child.once("exit", (code) => {
      if (!settled) {
        finish(new Error(`Pi runtime smoke check failed: RPC exited ${String(code)}. ${stderr}`));
      }
    });
    child.stdin.write(`${JSON.stringify({ id: "pi-runtime-smoke", type: "get_state" })}\n`);
  });
}

function createInstallManifest(
  manifest: PackedReleaseManifest,
  packedRoot: string,
  installRoot: string,
): JsonObject {
  const dependencies: JsonObject = {};
  for (const pkg of manifest.packages) {
    dependencies[pkg.name] = packageFileSpecifier(
      installRoot,
      resolvePackedPath(packedRoot, pkg.tarball),
    );
  }
  return { private: true, dependencies, overrides: { ...dependencies } };
}

function readPackedReleaseManifest(path: string): PackedReleaseManifest {
  const value = readJsonObject(path, "Invalid packed release manifest");
  try {
    if (value.schemaVersion !== 1) throw new Error("schemaVersion");
    const source = requireObject(value.source);
    return {
      schemaVersion: 1,
      source: {
        repository: requireString(source.repository),
        commit: requireNonEmptyString(source.commit),
        dirty: requireBoolean(source.dirty),
      },
      packages: requireArray(value.packages).map(decodePackedPackage),
    };
  } catch (cause) {
    throw new Error("Invalid packed release manifest", { cause });
  }
}

function decodePackedPackage(value: JsonValue): PiRuntimePackage {
  const pkg = requireObject(value);
  return {
    name: requireNonEmptyString(pkg.name),
    version: requireNonEmptyString(pkg.version),
    tarball: requireNonEmptyString(pkg.tarball),
    sha256: requireNonEmptyString(pkg.sha256),
  };
}

function verifyPackedTarballs(manifest: PackedReleaseManifest, packedRoot: string): void {
  const names = new Set<string>();
  for (const pkg of manifest.packages) {
    if (names.has(pkg.name)) throw new Error(`Duplicate package in release manifest: ${pkg.name}`);
    names.add(pkg.name);
    const tarball = resolvePackedPath(packedRoot, pkg.tarball);
    if (!existsSync(tarball)) throw new Error(`Missing release tarball: ${pkg.tarball}`);
    const actualHash = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    if (actualHash !== pkg.sha256) throw new Error(`Tarball hash mismatch: ${pkg.name}`);
  }
  if (!names.has(PI_CODING_AGENT_PACKAGE)) {
    throw new Error(`Release manifest is missing ${PI_CODING_AGENT_PACKAGE}`);
  }
}

function resolvePackedPath(packedRoot: string, path: string): string {
  if (isAbsolute(path)) throw new Error("Release tarball path escapes packed release");
  const resolved = resolve(packedRoot, path);
  if (!isWithin(packedRoot, resolved)) throw new Error("Release tarball path escapes packed release");
  return resolved;
}

function createReleaseId(manifest: PackedReleaseManifest): string {
  const codingAgent = manifest.packages.find((pkg) => pkg.name === PI_CODING_AGENT_PACKAGE);
  if (codingAgent === undefined) throw new Error(`Release manifest is missing ${PI_CODING_AGENT_PACKAGE}`);
  const digest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex").slice(0, 12);
  const dirty = manifest.source.dirty ? "-dirty" : "";
  return `${codingAgent.version}-${manifest.source.commit.slice(0, 12)}${dirty}-${digest}`.replace(
    /[^A-Za-z0-9._-]/g,
    "-",
  );
}

function verifySourceRoot(sourceRoot: string): void {
  const manifest = readJsonObject(join(sourceRoot, "package.json"), "Invalid Pi fork package.json");
  if (manifest.name !== "pi-monorepo") throw new Error(`Not a Pi fork checkout: ${sourceRoot}`);
  if (!existsSync(join(sourceRoot, "scripts", "local-release.mjs"))) {
    throw new Error(`Pi fork local release builder is missing: ${sourceRoot}`);
  }
}

interface PackageScanContext {
  expectedPackages: ReadonlyMap<string, PiRuntimePackage>;
  owner: string;
  errors: string[];
  visited: Set<string>;
}

function scanNestedInternalPackages(
  nodeModulesRoot: string,
  expectedPackages: ReadonlyMap<string, PiRuntimePackage>,
  owner: string,
  errors: string[],
): void {
  scanNodeModules(nodeModulesRoot, { expectedPackages, owner, errors, visited: new Set() });
}

function scanNodeModules(root: string, context: PackageScanContext): void {
  if (!existsSync(root)) return;
  const canonicalRoot = realpathSync(root);
  if (context.visited.has(canonicalRoot)) return;
  context.visited.add(canonicalRoot);

  for (const packageRoot of listPackageRoots(canonicalRoot)) {
    inspectInternalPackage(packageRoot, context);
    scanNodeModules(join(packageRoot, "node_modules"), context);
  }
}

function inspectInternalPackage(packageRoot: string, context: PackageScanContext): void {
  const manifestPath = join(packageRoot, "package.json");
  if (!existsSync(manifestPath)) return;
  try {
    const manifest = readJsonObject(manifestPath, "Invalid installed package manifest");
    const name = requireString(manifest.name);
    if (!name.startsWith("@earendil-works/")) return;
    const expected = context.expectedPackages.get(name);
    if (expected === undefined) {
      context.errors.push(`${name}: nested ${context.owner} package is absent from active manifest`);
    } else {
      const installedVersion = requireString(manifest.version);
      if (installedVersion !== expected.version) {
        context.errors.push(
          `${name}: nested ${context.owner} version ${installedVersion} != ${expected.version}`,
        );
      }
    }
  } catch (cause) {
    context.errors.push(
      `${packageRoot}: nested ${context.owner} manifest invalid: ${errorMessage(cause)}`,
    );
  }
}

function listPackageRoots(nodeModulesRoot: string): string[] {
  const roots: string[] = [];
  for (const entry of readdirSync(nodeModulesRoot, { withFileTypes: true })) {
    const path = join(nodeModulesRoot, entry.name);
    if (entry.name.startsWith("@") && isExistingDirectory(path)) {
      for (const scopedEntry of readdirSync(path, { withFileTypes: true })) {
        const scopedPath = join(path, scopedEntry.name);
        if (isExistingDirectory(scopedPath)) roots.push(scopedPath);
      }
    } else if (isExistingDirectory(path)) {
      roots.push(path);
    }
  }
  return roots;
}

function isExistingDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function verifyInstalledPackage(
  packageRoot: string,
  expected: PiRuntimePackage,
  owner: string,
  errors: string[],
): void {
  if (!existsSync(packageRoot)) {
    errors.push(`${expected.name}: missing from ${owner} install`);
    return;
  }
  try {
    const manifest = readJsonObject(join(packageRoot, "package.json"), "Invalid installed package manifest");
    if (manifest.name !== expected.name) errors.push(`${expected.name}: wrong package name in ${owner} install`);
    const installedVersion = requireString(manifest.version);
    if (installedVersion !== expected.version) {
      errors.push(`${expected.name}: ${owner} version ${installedVersion} != ${expected.version}`);
    }
  } catch (cause) {
    errors.push(`${expected.name}: ${owner} manifest invalid: ${errorMessage(cause)}`);
  }
}

function removeReadOnlyTree(root: string): void {
  chmodSync(root, 0o755);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      removeReadOnlyTree(join(root, entry.name));
    }
  }
  rmSync(root, { force: true, recursive: true });
}

function makeTreeReadOnly(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      makeTreeReadOnly(path);
      chmodSync(path, 0o555);
    } else if (entry.isFile()) {
      const executable = (statSync(path).mode & 0o111) !== 0;
      chmodSync(path, executable ? 0o555 : 0o444);
    }
  }
  chmodSync(root, 0o555);
}

function runCommand(command: string, args: string[], cwd?: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    throw new Error(`Command failed (${String(result.status)}): ${command} ${args.join(" ")}`);
  }
}

function packageFileSpecifier(fromDirectory: string, file: string): string {
  const path = relative(fromDirectory, file).replaceAll(sep, "/");
  return `file:${path.startsWith(".") ? path : `./${path}`}`;
}

function readJsonObject(path: string, errorMessage: string): JsonObject {
  try {
    const value: JsonValue = JSON.parse(readFileSync(path, "utf-8"));
    return requireObject(value);
  } catch (cause) {
    throw new Error(errorMessage, { cause });
  }
}

function optionalObject(value: JsonValue | undefined): JsonObject {
  return value === undefined ? {} : requireObject(value);
}

function requireObject(value: JsonValue | undefined): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected JSON object");
  }
  return value;
}

function requireArray(value: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(value)) throw new Error("Expected JSON array");
  return value;
}

function requireString(value: JsonValue | undefined): string {
  if (typeof value !== "string") throw new Error("Expected string");
  return value;
}

function requireNonEmptyString(value: JsonValue | undefined): string {
  const string = requireString(value);
  if (string.length === 0) throw new Error("Expected non-empty string");
  return string;
}

function requireBoolean(value: JsonValue | undefined): boolean {
  if (typeof value !== "boolean") throw new Error("Expected boolean");
  return value;
}

function formatJson(value: JsonObject | PiRuntimeManifest): string {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

function isWithin(parent: string, candidate: string): boolean {
  const pathFromParent = relative(resolve(parent), resolve(candidate));
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
