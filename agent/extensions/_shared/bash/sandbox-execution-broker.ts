import type { BashOperations } from "@earendil-works/pi-coding-agent";

import type { CreateBashOperationsOptions } from "./exec";

export type SandboxExecutionState =
    | "uninitialized"
    | "enabled"
    | "disabled"
    | "error";

export interface SharedBashOperationsOptions {
    stdin?: string;
    rewriteCommand?: CreateBashOperationsOptions["rewriteCommand"];
}

interface PublishedSandboxExecutionState {
    state: SandboxExecutionState;
    createOperations?: (options: SharedBashOperationsOptions) => BashOperations;
    error?: string;
}

interface SandboxExecutionBrokerRegistry {
    owner?: symbol;
    publication: PublishedSandboxExecutionState;
}

const BROKER_KEY = Symbol.for("pi.sandbox-bash-execution.v1");

function registry(): SandboxExecutionBrokerRegistry {
    const globals = globalThis as typeof globalThis & {
        [BROKER_KEY]?: SandboxExecutionBrokerRegistry;
    };
    globals[BROKER_KEY] ??= { publication: { state: "uninitialized" } };
    return globals[BROKER_KEY];
}

export function claimSandboxExecutionBroker(owner: symbol): void {
    const current = registry();
    current.owner = owner;
    current.publication = { state: "uninitialized" };
}

export function publishSandboxExecutionState(
    owner: symbol,
    publication: PublishedSandboxExecutionState,
): boolean {
    const current = registry();
    if (current.owner !== owner) return false;
    current.publication = publication;
    return true;
}

export function releaseSandboxExecutionBroker(owner: symbol): boolean {
    const current = registry();
    if (current.owner !== owner) return false;
    current.owner = undefined;
    current.publication = { state: "uninitialized" };
    return true;
}

export function getSandboxExecutionState(): SandboxExecutionState {
    return registry().publication.state;
}

function unavailableOperations(reason: string): BashOperations {
    return {
        async exec() {
            throw new Error(`Sandbox execution unavailable: ${reason}`);
        },
    };
}

export function createSharedBashOperations(
    options: SharedBashOperationsOptions = {},
): BashOperations {
    const publication = registry().publication;
    if (
        (publication.state === "enabled" || publication.state === "disabled") &&
        publication.createOperations
    ) {
        return publication.createOperations(options);
    }

    const reason =
        publication.state === "error"
            ? (publication.error ?? "initialization failed")
            : publication.state;
    return unavailableOperations(reason);
}
