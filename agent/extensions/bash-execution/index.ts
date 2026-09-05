import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createBashProcessSupervisor } from "../_shared/command-execution/exec.ts";
import { registerBuiltinBash, resolveBashOperations } from "./builtin-bash.ts";
import { registerSafeBash } from "./safe-bash/index.ts";

export default function bashExecutionExtension(pi: ExtensionAPI): void {
    const localSupervisor = createBashProcessSupervisor();
    const createOperations = (
        options: Parameters<typeof resolveBashOperations>[1],
    ) => resolveBashOperations(localSupervisor, options);

    registerBuiltinBash(pi, { localSupervisor });
    registerSafeBash(pi, { createOperations });

    pi.on("session_shutdown", () => {
        localSupervisor.shutdown();
    });
}
