import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SandboxExecutionContext } from "../_shared/sandbox-runtime/execution-context.ts";
import { getSandboxRuntime } from "../_shared/sandbox-runtime/index.ts";
import {
    stripLegacyShellContext,
    updateShellContext,
} from "../_shared/shell-presentation/context.ts";
import { currentShellPolicy } from "./capabilities/runtime.ts";

export function readShellModelContext() {
    const runtime = getSandboxRuntime();
    const strictEnvironments =
        runtime.state === "enabled" && runtime.contexts
            ? {
                  "think-strict": runtime.contexts["think-strict"],
                  "analysis-strict": runtime.contexts["analysis-strict"],
              }
            : undefined;
    const base = {
        version: 2,
        runtime: runtime.state,
        scope: "Shell only. Native file tools, extensions and MCP tools execute outside this boundary.",
        strictEnvironmentScope:
            "Think-in-Code uses the separate strict environments below regardless of shell mode.",
        strictEnvironments,
    };
    let policy;
    try {
        // This resolver only reads configuration. Never call the preparation/admission path here.
        policy = currentShellPolicy();
    } catch {
        return {
            ...base,
            mode: "unknown",
            availability: "blocked",
            reason: "Invalid shell configuration. New shell calls are blocked. Inspect /sandbox status.",
        };
    }
    if (!policy)
        return {
            ...base,
            mode: "unknown",
            availability: "blocked",
            reason: "Shell policy is not initialized. No automatic host fallback.",
        };
    const selected = {
        ...base,
        mode: policy.mode ?? "sandbox",
        profile: policy.profile,
    };
    if (policy.state !== "ready")
        return {
            ...selected,
            availability: "blocked",
            reason: `Shell authorization is not ready (${policy.state}). Inspect /sandbox status.`,
        };
    if (runtime.state === "reconfiguring")
        return {
            ...selected,
            availability: "reconfiguring",
            reason: "Shell runtime replacement is in progress. No automatic host fallback.",
        };
    if (
        runtime.state === "uninitialized" ||
        runtime.state === "error" ||
        (runtime.state === "disabled" && policy.mode !== "host")
    ) {
        return {
            ...selected,
            availability: "unavailable",
            reason: "The selected shell runtime is unavailable. No automatic host fallback.",
        };
    }
    if (
        runtime.state === "enabled" &&
        policy.sandboxFingerprint &&
        policy.sandboxFingerprint !== runtime.sandboxFingerprint
    ) {
        return {
            ...selected,
            availability: "pending",
            reason: "Configuration changed. Prepare the replacement runtime at the next shell admission. New resource openings are not active yet; previously admitted commands retain their original policy.",
        };
    }
    if (policy.mode === "host")
        return {
            ...selected,
            availability: "ready",
            execution:
                "Run shell commands on the host without shell OS isolation. Host HOME, PATH, network and /tmp apply. Command permission checks remain independent.",
        };
    const effective: SandboxExecutionContext | undefined =
        runtime.state === "enabled"
            ? runtime.contexts?.["bash-general"]
            : undefined;
    return { ...selected, availability: "ready", effective };
}

export function registerSandboxModelContext(pi: ExtensionAPI): void {
    pi.on("before_agent_start", (event) => ({
        systemPrompt: stripLegacyShellContext(event.systemPrompt),
    }));
    pi.on("context", (event) => ({
        messages: updateShellContext(
            event.messages,
            "execution",
            JSON.stringify(readShellModelContext()),
        ),
    }));
}
