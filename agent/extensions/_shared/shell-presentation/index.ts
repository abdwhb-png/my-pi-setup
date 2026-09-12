import {
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";

export type ShellToolName = "bash" | "safe_bash";

const COMMON_GUIDELINES = [
    "When a command targets another execution environment, resolve its executable paths and variables in that environment.",
    "Preserve intentional caller-side values explicitly. Do not assume that HOME or PATH is shared between execution environments.",
    "Use the current shell execution context to distinguish sandbox restrictions, command permission checks, and command failures. Never infer a sandbox denial from a command failure alone.",
];
const SAFE_GUIDELINES = [
    "Follow the current safe_bash command checks and native-tool redirection policy. Denied commands remain blocked; ask rules require approval unless already approved for the session.",
];

export function shellToolPresentation(name: ShellToolName) {
    const promptSnippet =
        name === "bash"
            ? "Execute a shell command using the current sandbox or host execution mode."
            : "Execute a shell command using the current sandbox or host execution mode, with additional command checks.";
    return {
        description: `${promptSnippet} Run in the current working directory. Returns stdout and stderr. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first); full output is saved to a temp file when truncated. Optionally provide a timeout in seconds and stdin as text.`,
        promptSnippet,
        promptGuidelines: [
            ...COMMON_GUIDELINES,
            ...(name === "safe_bash" ? SAFE_GUIDELINES : []),
        ],
    };
}

/** Share the same rules with the provider catalog when a custom prompt is used. */
export function shellToolGuidelines(
    tools: readonly { name: string }[],
): string[] {
    return [
        ...new Set(
            tools.flatMap(({ name }) =>
                name === "bash" || name === "safe_bash"
                    ? shellToolPresentation(name).promptGuidelines
                    : [],
            ),
        ),
    ];
}
