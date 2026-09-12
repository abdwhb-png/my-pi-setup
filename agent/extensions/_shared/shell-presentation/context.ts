import type { ContextEvent } from "@earendil-works/pi-coding-agent";

export const SHELL_CONTEXT_TYPE = "pi.shell-context.v2";
type Section = "availability" | "checks" | "execution";
const SECTIONS: Section[] = ["availability", "execution", "checks"];

/** Combine independently owned facts without persisting messages or sharing Jiti module state. */
export function updateShellContext(
    messages: ContextEvent["messages"],
    section: Section,
    content?: string,
): ContextEvent["messages"] {
    const sections: Partial<Record<Section, string>> = {};
    const previous = messages.find(
        (message) =>
            message.role === "custom" &&
            message.customType === SHELL_CONTEXT_TYPE,
    );
    if (
        previous?.role === "custom" &&
        typeof previous.details === "object" &&
        previous.details !== null
    ) {
        // oxlint-disable-next-line typescript/no-restricted-types -- Pi custom-message details have no exported shape.
        const values: unknown = Reflect.get(previous.details, "sections");
        if (typeof values === "object" && values !== null) {
            for (const key of SECTIONS) {
                // oxlint-disable-next-line typescript/no-restricted-types -- Validate each value from Pi's untyped details boundary.
                const value: unknown = Reflect.get(values, key);
                if (typeof value === "string") sections[key] = value;
            }
        }
    }
    if (content) sections[section] = content;
    else delete sections[section];
    const remaining = messages.filter(
        (message) =>
            message.role !== "custom" ||
            message.customType !== SHELL_CONTEXT_TYPE,
    );
    if (!Object.keys(sections).length) return remaining;
    const unavailable =
        sections.availability && !sections.execution
            ? "Shell policy context is unavailable. Shell execution remains blocked until the Sandbox policy is initialized."
            : undefined;
    return [
        ...remaining,
        {
            role: "custom",
            customType: SHELL_CONTEXT_TYPE,
            display: false,
            timestamp: previous?.timestamp ?? Date.now(),
            details: { sections },
            content: [
                "Current shell execution context",
                "Use these as current execution facts, not evidence that a particular failure was caused by the sandbox. Configured access does not prove executable availability or service reachability.",
                "Policy path aliases are display-only: ~ denotes the host user's home, and <sandbox-...> denotes private runtime paths. Inside a sandbox command, shell ~ and $HOME resolve to its private HOME instead.",
                ...SECTIONS.map((key) => sections[key]),
                unavailable,
            ]
                .filter(Boolean)
                .join("\n"),
        },
    ];
}

export function stripLegacyShellContext(prompt: string): string {
    return prompt
        .replace(
            /\n?<!-- pi:sandbox-execution-context:v1:start -->[\s\S]*?<!-- pi:sandbox-execution-context:v1:end -->/g,
            "",
        )
        .replace(
            /\n?<!-- pi:shell-capabilities:start -->[\s\S]*?<!-- pi:shell-capabilities:end -->/g,
            "",
        )
        .trimEnd();
}
