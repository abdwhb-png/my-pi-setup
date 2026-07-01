import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getDefaultAgentDir,
  repairConfiguredPiPackages,
  type RepairLogger,
} from "./_shared/package-install-finalizer.ts";

function createStartupLogger(): RepairLogger {
  return {
    info(message: string) {
      if (message.includes("Built ") || message.includes("Linked ")) {
        console.log(message);
      }
    },
    warn(message: string) {
      console.warn(message);
    },
  };
}

export function runPackageFinalizerStartup(cwd: string, agentDir = getDefaultAgentDir()) {
  return repairConfiguredPiPackages({
    cwd,
    agentDir,
    logger: createStartupLogger(),
    force: false,
  });
}

export default function packageFinalizer(_pi: ExtensionAPI): void {
  runPackageFinalizerStartup(process.cwd());
}
