import { deployFork, rollbackFork, verifyRuntimeCoherence, type CoherenceReport } from "./pi-fork-release.ts";
import { loadCurrentPiRuntime, type ActivePiRuntime } from "./pi-runtime-store.ts";

const USAGE = "Usage: pi-fork <status|deploy|verify|rollback>";
const COMMANDS = new Set(["status", "deploy", "verify", "rollback"]);

export interface PiForkCliDependencies {
  deploy(): Promise<ActivePiRuntime>;
  rollback(): Promise<ActivePiRuntime>;
  loadCurrent(): ActivePiRuntime;
  verify(runtime: ActivePiRuntime): CoherenceReport;
  writeOutput(message: string): void;
  writeError(message: string): void;
}

const defaultDependencies: PiForkCliDependencies = {
  deploy: () => deployFork(),
  rollback: () => rollbackFork(),
  loadCurrent: () => loadCurrentPiRuntime(),
  verify: (runtime) => verifyRuntimeCoherence(runtime),
  writeOutput: (message) => process.stdout.write(`${message}\n`),
  writeError: (message) => process.stderr.write(`${message}\n`),
};

export async function runPiForkCli(
  args: string[],
  dependencies: PiForkCliDependencies = defaultDependencies,
): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    dependencies.writeOutput(USAGE);
    return 0;
  }
  if (args.length !== 1 || !COMMANDS.has(args[0])) {
    dependencies.writeError(USAGE);
    return 2;
  }

  try {
    return await dispatchCommand(args[0], dependencies);
  } catch (cause) {
    dependencies.writeError(cause instanceof Error ? cause.message : String(cause));
    return 1;
  }
}

async function dispatchCommand(
  command: string,
  dependencies: PiForkCliDependencies,
): Promise<number> {
  if (command === "deploy") {
    const runtime = await dependencies.deploy();
    dependencies.writeOutput(`Deployed Pi fork release: ${runtime.releaseId}`);
    return 0;
  }
  if (command === "rollback") {
    const runtime = await dependencies.rollback();
    dependencies.writeOutput(`Restored Pi fork release: ${runtime.releaseId}`);
    return 0;
  }

  const runtime = dependencies.loadCurrent();
  if (command === "status") {
    writeStatus(runtime, (message) => dependencies.writeOutput(message));
    return 0;
  }

  const report = dependencies.verify(runtime);
  if (!report.ok) {
    for (const error of report.errors) dependencies.writeError(error);
    return 1;
  }
  dependencies.writeOutput(`Pi runtime verified: ${runtime.releaseId}`);
  return 0;
}

function writeStatus(runtime: ActivePiRuntime, writeOutput: (message: string) => void): void {
  const dirty = runtime.manifest.source.dirty ? "dirty" : "clean";
  writeOutput(`Release: ${runtime.releaseId}`);
  writeOutput(`Source: ${runtime.manifest.source.repository}@${runtime.manifest.source.commit} (${dirty})`);
  writeOutput(`Release root: ${runtime.releaseRoot}`);
  writeOutput(`Executable: ${runtime.executable}`);
  writeOutput(`Package root: ${runtime.packageRoot}`);
}
