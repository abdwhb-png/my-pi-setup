import type { BashOperations } from "@earendil-works/pi-coding-agent";

import type { BashProcessSupervisor } from "../command-execution/exec.ts";
import { unknownExecution } from "../execution-provenance/index.ts";
import {
    createSandboxBashOperations,
    type SandboxBashOperationOptions,
} from "../sandbox-runtime/index.ts";
import { CapabilityError } from "../shell-capability-error.ts";
import {
    currentShellPolicy,
    requireForcedSandboxShellPolicy,
    requireShellPolicy,
    resolveForcedSandboxPolicyForExecution,
    resolveShellPolicyForExecution,
    trackShellOperation,
} from "./index.ts";

function createConfiguredSandboxOperations(
    policy: Awaited<ReturnType<typeof resolveShellPolicyForExecution>>,
    options: SandboxBashOperationOptions,
    forced = false,
): BashOperations {
    const observer: typeof options.onExecution = (value) =>
        options.onExecution?.({
            ...value,
            mode: "sandbox",
            shellProfile: policy.profile,
        });
    return createSandboxBashOperations({
        ...options,
        onExecution: observer,
        beforeDispatch: (fingerprint) => {
            const latest = forced
                ? requireForcedSandboxShellPolicy(policy.projectRoot)
                : requireShellPolicy(policy.projectRoot);
            if (
                latest.profile !== policy.profile ||
                (latest.sandboxFingerprint &&
                    latest.sandboxFingerprint !== fingerprint)
            ) {
                throw new CapabilityError(
                    "authorization-required",
                    "Shell policy changed. Refresh with /sandbox mode " +
                        (latest.requestedMode ?? latest.mode ?? "sandbox") +
                        ". The command was not executed.",
                );
            }
            options.beforeDispatch?.(fingerprint);
        },
    });
}

export function resolveForcedSandboxOperations(
    options: SandboxBashOperationOptions = {},
): BashOperations {
    return {
        exec: async (command, cwd, executionOptions) => {
            const policy = await resolveForcedSandboxPolicyForExecution(cwd);
            const operations = createConfiguredSandboxOperations(
                policy,
                options,
                true,
            );
            return trackShellOperation(policy, command, () =>
                operations.exec(command, cwd, executionOptions),
            );
        },
    };
}

export function resolveBashOperations(
    localSupervisor: BashProcessSupervisor,
    options: SandboxBashOperationOptions = {},
): BashOperations {
    return {
        exec: async (command, cwd, executionOptions) => {
            if ("hostCapability" in options) {
                throw new CapabilityError(
                    "migration-required",
                    "Legacy hostCapability was removed. Use a standard bash command and choose the execution mode explicitly.",
                );
            }
            let policy;
            try {
                policy = await resolveShellPolicyForExecution(cwd);
            } catch (error) {
                let currentPolicy;
                try {
                    currentPolicy = currentShellPolicy();
                } catch {
                    // Preserve the original policy refusal when resolution itself failed.
                }
                options.onExecution?.({
                    ...unknownExecution(),
                    ...(currentPolicy
                        ? {
                              mode:
                                  currentPolicy.mode === "host"
                                      ? ("host" as const)
                                      : ("sandbox" as const),
                              shellProfile: currentPolicy.profile,
                          }
                        : {}),
                    phase: "policy",
                    outcome: "blocked",
                });
                throw error;
            }
            const observer: typeof options.onExecution = (value) =>
                options.onExecution?.({
                    ...value,
                    mode: policy.mode === "host" ? "host" : "sandbox",
                    shellProfile: policy.profile,
                });
            const sandbox = createConfiguredSandboxOperations(policy, options);
            const operations =
                policy.mode === "host"
                    ? localSupervisor.createOperations({
                          // Do not rewrite a permission-checked command using project-controlled host code.
                          detached: true,
                          onExecution: observer,
                          stdin: options.stdin,
                      })
                    : sandbox;
            return trackShellOperation(policy, command, () =>
                operations.exec(command, cwd, executionOptions),
            );
        },
    };
}
