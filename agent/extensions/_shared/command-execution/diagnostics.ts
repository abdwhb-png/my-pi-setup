import {
    parseSandboxExecutionContext,
    type SandboxExecutionContext,
} from "../sandbox-runtime/execution-context.ts";
import { sandboxPathDiagnostic } from "./path-diagnostic.ts";

/** Explain recognized loader failures without resolving libraries on the host. */
export function sandboxShellDiagnostic(
    output: string,
    value: SandboxExecutionContext | undefined,
): string | undefined {
    const context = parseSandboxExecutionContext(value);
    if (context?.version !== 3 || context.profile !== "bash-general")
        return undefined;
    const diagnostics = [sandboxPathDiagnostic(output, context)].filter(
        (diagnostic) => diagnostic !== undefined,
    );
    const libraries = new Set<string>();
    for (const line of output.split("\n")) {
        const library =
            /^\s*(?:(?:cause: )?(?:Error|error): |[^\s:]+: error while loading shared libraries: )([A-Za-z0-9_+.-]+\.so(?:\.[0-9]+)*): cannot open shared object file: No such file or directory\r?$/.exec(
                line,
            )?.[1];
        if (!library) continue;
        libraries.add(library);
        if (libraries.size === 3) break;
    }
    if (libraries.size) {
        diagnostics.push(
            [...libraries]
                .map(
                    (library) =>
                        `Sandbox: the dynamic loader could not find ${library}.`,
                )
                .join("\n") +
                "\nThe library may be absent or outside this execution's read permissions. Review the authorized installation's library dependencies before retrying.",
        );
        if (
            /^\s*(?:cause: )?Error: Cannot find (?:module |native binding[.\s])/m.test(
                output,
            )
        )
            diagnostics.push(
                "The accompanying module/binding errors do not establish that the package is missing.",
            );
    }
    return diagnostics.length ? diagnostics.join("\n") : undefined;
}
