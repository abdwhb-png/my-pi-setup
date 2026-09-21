import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const RUNTIME_MANIFEST = "runtime-manifest.json";

type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue | undefined };

export interface PiRuntimePackage {
  name: string;
  version: string;
  tarball: string;
  sha256: string;
}

export interface PiRuntimeManifest {
  schemaVersion: 1;
  releaseId: string;
  createdAt: string;
  source: {
    repository: string;
    commit: string;
    dirty: boolean;
  };
  executable: string;
  packageRoot: string;
  packages: PiRuntimePackage[];
}

export interface ActivePiRuntime {
  releaseId: string;
  releaseRoot: string;
  executable: string;
  packageRoot: string;
  manifest: PiRuntimeManifest;
}

export function getPiRuntimeRoot(homeDir = homedir()): string {
  return join(homeDir, ".pi", "runtime", "pi-core");
}

export function loadActivePiRuntime(homeDir = homedir()): ActivePiRuntime {
  return loadCurrentPiRuntime(getPiRuntimeRoot(homeDir));
}

export function resolvePiLaunchCommand(executable: string, packageRoot: string): {
  command: string;
  prefixArgs: string[];
} {
  if (resolve(executable) !== join(packageRoot, "dist", "bundle", "cli.js")) {
    return { command: executable, prefixArgs: [] };
  }

  const bunEntry = join(packageRoot, "dist", "bun", "cli.js");
  if (!existsSync(bunEntry)) throw new Error(`Pi Bun entry does not exist: ${bunEntry}`);
  const canonicalEntry = realpathSync(bunEntry);
  if (!isWithin(realpathSync(packageRoot), canonicalEntry)) {
    throw new Error("Pi Bun entry escapes package root");
  }
  if (!process.versions.bun) throw new Error("Bun is required to launch this Pi runtime");
  return { command: process.execPath, prefixArgs: [canonicalEntry] };
}

export function loadCurrentPiRuntime(runtimeRoot = getPiRuntimeRoot()): ActivePiRuntime {
  return loadReleaseFromLink(join(runtimeRoot, "current"), runtimeRoot, {
    missing: "No active Pi runtime release",
  });
}

export function loadPreviousPiRuntime(runtimeRoot = getPiRuntimeRoot()): ActivePiRuntime {
  return loadReleaseFromLink(join(runtimeRoot, "previous"), runtimeRoot, {
    missing: "No previous Pi runtime release",
  });
}

export function activateRelease(
  releaseRoot: string,
  runtimeRoot = getPiRuntimeRoot(),
): void {
  const release = loadManagedRelease(releaseRoot, runtimeRoot);
  const current = resolveOptionalReleaseLink(join(runtimeRoot, "current"), runtimeRoot);

  publishState(runtimeRoot, release.releaseRoot, current?.releaseRoot);
}

export function rollbackRelease(runtimeRoot = getPiRuntimeRoot()): ActivePiRuntime {
  const current = loadReleaseFromLink(join(runtimeRoot, "current"), runtimeRoot, {
    missing: "No active Pi runtime release",
  });
  const previous = loadReleaseFromLink(join(runtimeRoot, "previous"), runtimeRoot, {
    missing: "No previous Pi runtime release",
  });

  publishState(runtimeRoot, previous.releaseRoot, current.releaseRoot);
  return loadReleaseFromLink(join(runtimeRoot, "current"), runtimeRoot, {
    missing: "No active Pi runtime release",
  });
}

function publishState(runtimeRoot: string, currentRelease: string, previousRelease?: string): void {
  const statesRoot = join(runtimeRoot, "states");
  mkdirSync(statesRoot, { recursive: true });
  const stateRoot = join(statesRoot, `${Date.now()}-${process.pid}-${randomUUID()}`);
  mkdirSync(stateRoot);
  symlinkSync(relative(stateRoot, currentRelease), join(stateRoot, "current"));
  if (previousRelease !== undefined) {
    symlinkSync(relative(stateRoot, previousRelease), join(stateRoot, "previous"));
  }

  ensureFacadeLink(join(runtimeRoot, "current"), "active/current");
  ensureFacadeLink(join(runtimeRoot, "previous"), "active/previous");
  replaceSymlink(join(runtimeRoot, "active"), relative(runtimeRoot, stateRoot));
}

function ensureFacadeLink(linkPath: string, target: string): void {
  try {
    const metadata = lstatSync(linkPath);
    if (!metadata.isSymbolicLink() || readlinkSync(linkPath) !== target) {
      throw new Error(`Pi runtime pointer has unexpected content: ${linkPath}`);
    }
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      symlinkSync(target, linkPath);
      return;
    }
    throw cause;
  }
}

function replaceSymlink(linkPath: string, target: string): void {
  try {
    const metadata = lstatSync(linkPath);
    if (!metadata.isSymbolicLink()) {
      throw new Error(`Pi runtime pointer is not a symlink: ${linkPath}`);
    }
  } catch (cause) {
    if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
  }

  const temporaryLink = join(dirname(linkPath), `.${basename(linkPath)}.${process.pid}.${randomUUID()}`);
  symlinkSync(target, temporaryLink);
  renameSync(temporaryLink, linkPath);
}

function resolveOptionalReleaseLink(
  linkPath: string,
  runtimeRoot: string,
): ActivePiRuntime | undefined {
  if (!existsSync(linkPath)) return undefined;
  return loadReleaseFromLink(linkPath, runtimeRoot, { missing: "Pi runtime release does not exist" });
}

function loadReleaseFromLink(
  linkPath: string,
  runtimeRoot: string,
  messages: { missing: string },
): ActivePiRuntime {
  if (!existsSync(linkPath)) throw new Error(messages.missing);
  return loadManagedRelease(realpathSync(linkPath), runtimeRoot);
}

function loadManagedRelease(releaseRoot: string, runtimeRoot: string): ActivePiRuntime {
  const releasesRoot = realpathSync(join(runtimeRoot, "releases"));
  const canonicalReleaseRoot = realpathSync(releaseRoot);
  if (!isWithin(releasesRoot, canonicalReleaseRoot)) {
    throw new Error("Pi runtime release is outside managed releases");
  }

  const manifest = readRuntimeManifest(join(canonicalReleaseRoot, RUNTIME_MANIFEST));
  if (manifest.releaseId !== basename(canonicalReleaseRoot)) {
    throw new Error("Pi runtime manifest releaseId does not match release directory");
  }

  const executable = resolveManifestPath(
    canonicalReleaseRoot,
    manifest.executable,
    "Pi runtime executable does not exist",
  );
  const packageRoot = resolveManifestPath(
    canonicalReleaseRoot,
    manifest.packageRoot,
    "Pi runtime package root does not exist",
  );

  try {
    accessSync(executable, constants.X_OK);
  } catch {
    throw new Error("Pi runtime executable is not executable");
  }

  const packageManifest = readJsonObject(
    join(packageRoot, "package.json"),
    "Invalid Pi runtime package manifest",
  );
  if (packageManifest.name !== PI_CODING_AGENT_PACKAGE) {
    throw new Error(`Pi runtime package root is not ${PI_CODING_AGENT_PACKAGE}`);
  }

  return {
    releaseId: manifest.releaseId,
    releaseRoot: canonicalReleaseRoot,
    executable,
    packageRoot,
    manifest,
  };
}

function resolveManifestPath(releaseRoot: string, path: string, missingMessage: string): string {
  if (isAbsolute(path)) throw new Error("Pi runtime manifest path escapes release root");
  const candidate = resolve(releaseRoot, path);
  if (!isWithin(releaseRoot, candidate)) {
    throw new Error("Pi runtime manifest path escapes release root");
  }
  if (!existsSync(candidate)) throw new Error(missingMessage);
  const canonicalCandidate = realpathSync(candidate);
  if (!isWithin(releaseRoot, canonicalCandidate)) {
    throw new Error("Pi runtime manifest path escapes release root");
  }
  return canonicalCandidate;
}

function readRuntimeManifest(path: string): PiRuntimeManifest {
  const value = readJsonObject(path, "Invalid Pi runtime manifest");
  try {
    if (value.schemaVersion !== 1) throw new Error("schemaVersion");
    const source = requireObject(value.source);
    const packages = requireArray(value.packages).map(decodeRuntimePackage);
    return {
      schemaVersion: 1,
      releaseId: requireNonEmptyString(value.releaseId),
      createdAt: requireString(value.createdAt),
      source: {
        repository: requireString(source.repository),
        commit: requireString(source.commit),
        dirty: requireBoolean(source.dirty),
      },
      executable: requireNonEmptyString(value.executable),
      packageRoot: requireNonEmptyString(value.packageRoot),
      packages,
    };
  } catch (cause) {
    throw new Error("Invalid Pi runtime manifest", { cause });
  }
}

function decodeRuntimePackage(value: JsonValue): PiRuntimePackage {
  const entry = requireObject(value);
  return {
    name: requireString(entry.name),
    version: requireString(entry.version),
    tarball: requireString(entry.tarball),
    sha256: requireString(entry.sha256),
  };
}

function readJsonObject(path: string, errorMessage: string): JsonObject {
  try {
    const value: JsonValue = JSON.parse(readFileSync(path, "utf-8"));
    return requireObject(value);
  } catch (cause) {
    throw new Error(errorMessage, { cause });
  }
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

function isWithin(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}
