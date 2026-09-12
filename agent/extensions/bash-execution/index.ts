import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createBashProcessSupervisor } from "../_shared/command-execution/exec.ts";
import { registerExecutionProvenance } from "../_shared/execution-provenance/index.ts";
import { updateShellContext } from "../_shared/shell-presentation/context.ts";
import { shellToolGuidelines } from "../_shared/shell-presentation/index.ts";
import { registerToolPresentation } from "../_shared/tool-policy/presentation.ts";
import { registerBuiltinBash, resolveBashOperations } from "./builtin-bash.ts";
import { registerSafeBash } from "./safe-bash/index.ts";

export default function bashExecutionExtension(pi: ExtensionAPI): void {
    registerExecutionProvenance(pi);
    registerToolPresentation(pi, "shell-execution", shellToolGuidelines);
    pi.on("context", (event) => {
        const tools = pi
            .getActiveTools()
            .filter((name) => name === "bash" || name === "safe_bash");
        return {
            messages: updateShellContext(
                event.messages,
                "availability",
                tools.length
                    ? `Active shell tools: ${tools.join(", ")}.`
                    : undefined,
            ),
        };
    });
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
