import type { BashOperations } from "@earendil-works/pi-coding-agent";

import { ExecutionDeadline } from "../command-execution/deadline.ts";
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
            timingsMs: { ...options.deadline?.timingsMs, ...value.timingsMs },
        });
    let admittedFingerprint: string | undefined;
    return createSandboxBashOperations({
        ...options,
        onExecution: observer,
        preparedPolicy: policy,
        beforeDispatch: (fingerprint) => {
            admittedFingerprint = fingerprint;
            options.beforeDispatch?.(fingerprint);
        },
        beforeSpawn: () => {
            const latest = forced
                ? requireForcedSandboxShellPolicy(policy.projectRoot)
                : requireShellPolicy(policy.projectRoot);
            if (
                latest.profile !== policy.profile ||
                (latest.sandboxFingerprint &&
                    latest.sandboxFingerprint !== admittedFingerprint)
            ) {
                throw new CapabilityError(
                    "authorization-required",
                    "Shell policy changed. Refresh with /sandbox mode " +
                        (latest.requestedMode ?? latest.mode ?? "sandbox") +
                        ". The command was not executed.",
                );
            }
            options.beforeSpawn?.();
        },
    });
}

export function resolveForcedSandboxOperations(
    options: SandboxBashOperationOptions = {},
): BashOperations {
    return {
        exec: async (command, cwd, executionOptions) => {
            const deadline = new ExecutionDeadline(
                executionOptions.timeout,
                executionOptions.signal,
            );
            try {
                const policy = await deadline
                    .measure("preparation", () =>
                        resolveForcedSandboxPolicyForExecution(cwd, deadline),
                    )
                    .catch((error) => {
                        if (deadline.signal.aborted)
                            options.onExecution?.({
                                ...unknownExecution(),
                                mode: "sandbox",
                                phase: "policy",
                                outcome:
                                    deadline.interruptionOutcome ?? "aborted",
                                timingsMs: { ...deadline.timingsMs },
                            });
                        throw error;
                    });
                const operations = createConfiguredSandboxOperations(
                    policy,
                    { ...options, deadline },
                    true,
                );
                return await trackShellOperation(policy, command, () =>
                    operations.exec(command, cwd, executionOptions),
                );
            } finally {
                deadline.dispose();
            }
        },
    };
}

export function resolveBashOperations(
    localSupervisor: BashProcessSupervisor,
    options: SandboxBashOperationOptions = {},
): BashOperations {
    return {
        exec: async (command, cwd, executionOptions) => {
            const deadline = new ExecutionDeadline(
                executionOptions.timeout,
                executionOptions.signal,
            );
            try {
                if ("hostCapability" in options) {
                    throw new CapabilityError(
                        "migration-required",
                        "Legacy hostCapability was removed. Use a standard bash command and choose the execution mode explicitly.",
                    );
                }
                let policy;
                try {
                    policy = await deadline.measure("preparation", () =>
                        resolveShellPolicyForExecution(cwd, deadline),
                    );
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
                        outcome: deadline.signal.aborted
                            ? (deadline.interruptionOutcome ?? "aborted")
                            : "blocked",
                        timingsMs: { ...deadline.timingsMs },
                    });
                    throw error;
                }
                const observer: typeof options.onExecution = (value) =>
                    options.onExecution?.({
                        ...value,
                        mode: policy.mode === "host" ? "host" : "sandbox",
                        shellProfile: policy.profile,
                        timingsMs: {
                            ...deadline.timingsMs,
                            ...value.timingsMs,
                        },
                    });
                const sandbox = createConfiguredSandboxOperations(policy, {
                    ...options,
                    deadline,
                });
                const operations =
                    policy.mode === "host"
                        ? localSupervisor.createOperations({
                              // Do not rewrite a permission-checked command using project-controlled host code.
                              detached: true,
                              deadline,
                              beforeSpawn: () => {
                                  const latest = requireShellPolicy(cwd);
                                  if (
                                      latest.mode !== "host" ||
                                      latest.profile !== policy.profile
                                  )
                                      throw new CapabilityError(
                                          "authorization-required",
                                          "Shell policy changed. The command was not executed.",
                                      );
                                  options.beforeSpawn?.();
                              },
                              onExecution: observer,
                              stdin: options.stdin,
                          })
                        : sandbox;
                deadline.check();
                // Operations own cancellation and cleanup; await their final provenance before returning.
                return await trackShellOperation(policy, command, () =>
                    operations.exec(command, cwd, executionOptions),
                );
            } finally {
                deadline.dispose();
            }
        },
    };
}
