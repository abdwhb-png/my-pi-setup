import {
    installExtensionUiBroker,
    registerExtensionUiPromptGuard,
    type ExtensionUiBrokerConstructors,
    type ExtensionUiPromptKind,
} from "../_shared/extension-ui-broker.ts";
import { setUiBrokerCompatibility } from "./runtime-state.ts";

export type UnattendedPromptKind = ExtensionUiPromptKind;

const UNATTENDED_GUARD_OWNER = "pi-dangerous-mode.unattended";
const BLOCKED_MESSAGE =
    "Human UI suppressed by Unattended. Choose only a safe, reversible path supported by current context. Do not repeat this prompt. If no such path exists, end normally with the concrete blocker.";

export class UnattendedPromptBlockedError extends Error {
    readonly code = "UNATTENDED_PROMPT_BLOCKED";

    constructor(
        readonly kind: UnattendedPromptKind,
        summary: string,
    ) {
        super(`[UNATTENDED_PROMPT_BLOCKED] ${summary}`);
        this.name = "UnattendedPromptBlockedError";
    }
}

export interface UiBrokerDeps {
    isEnabled(): boolean;
    isAgentActive(): boolean;
}

let unregisterGuard: (() => void) | undefined;

function assertPromptAllowed(
    kind: UnattendedPromptKind,
    deps: UiBrokerDeps,
): void {
    if (!deps.isEnabled()) return;
    if (kind === "custom" && !deps.isAgentActive()) return;

    throw new UnattendedPromptBlockedError(kind, BLOCKED_MESSAGE);
}

export function installUiBrokerPatches(
    deps: UiBrokerDeps,
    constructors: ExtensionUiBrokerConstructors = {},
): boolean {
    unregisterGuard = registerExtensionUiPromptGuard(
        UNATTENDED_GUARD_OWNER,
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
