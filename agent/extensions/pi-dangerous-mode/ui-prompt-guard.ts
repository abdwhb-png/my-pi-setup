import * as Pi from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setUiPromptGuardCompatibility } from "./runtime-state.ts";

const BLOCKED_REASON =
    "Human UI suppressed by Unattended. Choose only a safe, reversible path supported by current context. Do not repeat this prompt. If no such path exists, end normally with the concrete blocker.";

export interface UiPromptGuardDeps {
    isEnabled(): boolean;
    isAgentActive(): boolean;
}

export interface UiPromptRuntime {
    UIPromptBlockedError?: typeof Pi.UIPromptBlockedError;
}

export function installUiPromptGuard(
    pi: ExtensionAPI,
    deps: UiPromptGuardDeps,
    runtime: UiPromptRuntime = Pi,
): boolean {
    const compatible = typeof runtime.UIPromptBlockedError === "function";
    setUiPromptGuardCompatibility(compatible);
    if (!compatible) return false;

    pi.on("ui_prompt_before", (event) => {
        if (!deps.isEnabled()) return undefined;
        if (event.kind === "custom" && !deps.isAgentActive()) return undefined;

        return { block: true, reason: BLOCKED_REASON };
    });
    return true;
}
