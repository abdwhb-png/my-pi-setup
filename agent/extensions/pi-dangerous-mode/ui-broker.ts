import {
    installExtensionUiBroker,
    registerExtensionUiPromptGuard,
    type ExtensionUiBrokerConstructors,
    type ExtensionUiPromptKind,
} from "../_shared/extension-ui-broker.ts";
import { setUiBrokerCompatibility } from "./runtime-state.ts";
import type { AutopilotTelemetryEvent } from "./telemetry.ts";

export type AutopilotPromptKind = ExtensionUiPromptKind;

const AUTOPILOT_GUARD_OWNER = "pi-dangerous-mode.autopilot";
const BLOCKED_MESSAGE =
    "Human UI suppressed by Autopilot. Choose a safe non-interactive path and do not repeat the same prompt.";

export class AutopilotPromptBlockedError extends Error {
    readonly code = "AUTOPILOT_PROMPT_BLOCKED";

    constructor(
        readonly kind: AutopilotPromptKind,
        summary: string,
    ) {
        super(`[AUTOPILOT_PROMPT_BLOCKED] ${summary}`);
        this.name = "AutopilotPromptBlockedError";
    }
}

export interface UiBrokerDeps {
    isEnabled(): boolean;
    isAgentActive(): boolean;
    onBlocked(
        event: AutopilotTelemetryEvent & { event: "prompt_blocked" },
    ): void;
}

let unregisterGuard: (() => void) | undefined;

function assertPromptAllowed(
    kind: AutopilotPromptKind,
    deps: UiBrokerDeps,
): void {
    const agentActive = deps.isAgentActive();
    if (!deps.isEnabled()) return;
    if (kind === "custom" && !agentActive) return;

    deps.onBlocked({ event: "prompt_blocked", kind, agentActive });
    throw new AutopilotPromptBlockedError(kind, BLOCKED_MESSAGE);
}

export function installUiBrokerPatches(
    deps: UiBrokerDeps,
    constructors: ExtensionUiBrokerConstructors = {},
): boolean {
    unregisterGuard = registerExtensionUiPromptGuard(
        AUTOPILOT_GUARD_OWNER,
        (kind) => assertPromptAllowed(kind, deps),
    );
    const compatible = installExtensionUiBroker(constructors);
    setUiBrokerCompatibility(compatible);
    return compatible;
}

export function unregisterUiBrokerGuard(): void {
    unregisterGuard?.();
    unregisterGuard = undefined;
}
