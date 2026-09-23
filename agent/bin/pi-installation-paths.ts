import { dirname, join, resolve } from "node:path";

export interface PiInstallationPaths {
  piRoot: string;
  agentDir: string;
  runtimeRoot: string;
  sourceRoot: string;
}

export function resolvePiInstallationPaths(piRoot: string): PiInstallationPaths {
  const resolvedPiRoot = resolve(piRoot);

  return {
    piRoot: resolvedPiRoot,
    agentDir: join(resolvedPiRoot, "agent"),
    runtimeRoot: join(resolvedPiRoot, "runtime", "pi-core"),
    sourceRoot: join(dirname(resolvedPiRoot), "projects", "pi-core"),
  };
}
