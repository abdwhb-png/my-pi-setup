import { spawnSync } from "node:child_process";
import { getDefaultAgentDir, repairConfiguredPiPackages } from "../extensions/_shared/package-install/finalizer.ts";

export function isPackageMutationCommand(args: string[]): boolean {
  const command = args[0];
  return command === "install" || command === "remove" || command === "uninstall" || command === "update";
}

export async function runPackageFinalizer(cwd: string, options?: { force?: boolean; quiet?: boolean; agentDir?: string }) {
  const agentDir = options?.agentDir ?? getDefaultAgentDir();
  const quiet = options?.quiet ?? false;
  await repairConfiguredPiPackages({
    cwd,
    agentDir,
    force: options?.force ?? false,
    logger: {
      info(message: string) {
        if (!quiet) console.log(message);
      },
      warn(message: string) {
        console.warn(message);
      },
    },
  });
}

export function runRealPi(realPiPath: string, args: string[], cwd: string): number {
  const result = spawnSync(realPiPath, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, PI_PACKAGE_FINALIZER_ACTIVE: "1" },
  });
  if (typeof result.status === "number") return result.status;
  return 1;
}
