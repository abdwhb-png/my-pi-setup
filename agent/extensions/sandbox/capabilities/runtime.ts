import { realpathSync } from "node:fs";
import { CapabilityError } from "./authority.ts";
import type { ShellCapabilityResolution } from "./policy.ts";

interface ShellRuntime {
    owner: symbol;
    resolve(): ShellCapabilityResolution;
    prepare?(cwd: string): Promise<void>;
    resolveForcedSandbox?(): ShellCapabilityResolution;
    prepareForcedSandbox?(cwd: string): Promise<void>;
}
export interface ActiveShellOperation {
    id: number;
    projectRoot: string;
    profile: ShellCapabilityResolution["profile"];
    command: string;
}
interface Registry {
    runtime?: ShellRuntime;
    active: Map<number, ActiveShellOperation>;
    sequence: number;
}
const KEY = Symbol.for("pi.shell-capabilities.v1");
function registry(): Registry {
    const globals = globalThis as typeof globalThis & { [KEY]?: Registry };
    return (globals[KEY] ??= { active: new Map(), sequence: 0 });
}
export function publishShellRuntime(
    owner: symbol,
    resolve: ShellRuntime["resolve"],
    prepare?: ShellRuntime["prepare"],
    resolveForcedSandbox?: ShellRuntime["resolveForcedSandbox"],
    prepareForcedSandbox?: ShellRuntime["prepareForcedSandbox"],
): void {
    registry().runtime = {
        owner,
        resolve,
        prepare,
        resolveForcedSandbox,
        prepareForcedSandbox,
    };
}
export function releaseShellRuntime(owner: symbol): void {
    if (registry().runtime?.owner === owner) delete registry().runtime;
}
export function currentShellPolicy(): ShellCapabilityResolution | undefined {
    return registry().runtime?.resolve();
}
export function requireShellPolicy(
    cwd: string,
): ShellCapabilityResolution {
    const policy = currentShellPolicy();
    if (!policy)
        throw new CapabilityError(
            "authorization-required",
            "Shell policy is not initialized",
        );
    const actual = realpathSync(cwd);
    if (
        actual !== policy.projectRoot &&
        !actual.startsWith(`${policy.projectRoot}/`)
    )
        throw new CapabilityError(
            "authorization-required",
            "This project has no local grant",
        );
    if (policy.state !== "ready")
        throw new CapabilityError(
            policy.state,
            policy.diagnostic ?? "Shell execution is blocked",
        );
    return policy;
}
/** Refresh an active runtime before admitting a new Bash operation. */
export async function resolveShellPolicyForExecution(
    cwd: string,
): Promise<ShellCapabilityResolution> {
    const runtime = registry().runtime;
    if (!runtime) return requireShellPolicy(cwd);
    await runtime.prepare?.(cwd);
    const current = registry().runtime;
    if (
        current === undefined ||
        current !== runtime ||
        current.owner !== runtime.owner
    )
        throw new CapabilityError(
            "authorization-required",
            "Shell runtime changed during policy preparation. The command was not executed.",
        );
    return requireShellPolicy(cwd);
}

/** Resolve an explicit !s request without changing the selected session mode. */
export async function resolveForcedSandboxPolicyForExecution(
    cwd: string,
): Promise<ShellCapabilityResolution> {
    const runtime = registry().runtime;
    if (!runtime) return requireShellPolicy(cwd);
    await (runtime.prepareForcedSandbox ?? runtime.prepare)?.(cwd);
    const current = registry().runtime;
    if (!current || current !== runtime || current.owner !== runtime.owner) {
        throw new CapabilityError(
            "authorization-required",
            "Shell runtime changed during policy preparation. The command was not executed.",
        );
    }
    const policy = runtime.resolveForcedSandbox?.() ?? runtime.resolve();
    if (policy.mode !== "sandbox") {
        throw new CapabilityError(
            "authorization-required",
            "Sandbox execution is unavailable for this session.",
        );
    }
    const actual = realpathSync(cwd);
    if (actual !== policy.projectRoot && !actual.startsWith(`${policy.projectRoot}/`)) {
        throw new CapabilityError("authorization-required", "This project has no local grant");
    }
    if (policy.state !== "ready") {
        throw new CapabilityError(policy.state, policy.diagnostic ?? "Shell execution is blocked");
    }
    return policy;
}

export function requireForcedSandboxShellPolicy(
    cwd: string,
): ShellCapabilityResolution {
    const runtime = registry().runtime;
    const policy = runtime?.resolveForcedSandbox?.() ?? runtime?.resolve();
    if (!policy || policy.mode !== "sandbox") {
        throw new CapabilityError("authorization-required", "Sandbox execution is unavailable for this session.");
    }
    const actual = realpathSync(cwd);
    if (actual !== policy.projectRoot && !actual.startsWith(`${policy.projectRoot}/`)) {
        throw new CapabilityError("authorization-required", "This project has no local grant");
    }
    if (policy.state !== "ready") throw new CapabilityError(policy.state, policy.diagnostic ?? "Shell execution is blocked");
    return policy;
}
export async function trackShellOperation<T>(
    policy: ShellCapabilityResolution,
    command: string,
    run: () => Promise<T>,
): Promise<T> {
    const state = registry();
    const id = ++state.sequence;
    state.active.set(id, {
        id,
        command,
        profile: policy.profile,
        projectRoot: policy.projectRoot,
    });
    try {
        return await run();
    } finally {
        state.active.delete(id);
    }
}
export function activeShellOperations(): ActiveShellOperation[] {
    return [...registry().active.values()].map((value) => ({ ...value }));
}
export function formatShellPolicy(policy: ShellCapabilityResolution): string {
    return [
        `Shell profile: ${policy.profile} (requested: ${policy.requestedProfile}; ${policy.state})`,
        "Scope: shell only. Native file tools, extensions and MCP tools run on the host outside this shell boundary.",
        `Mode: ${policy.mode}`,
        `Network: ${policy.mode === "host" ? "host network (shell sandbox restrictions do not apply)" : policy.grants.domains.concat(policy.grants.hostDomains).join(", ") || "denied"}`,
        `Temporary files: ${policy.mode === "host" || policy.grants.hostTmp ? "host /tmp" : "private /tmp; native file tools see a different /tmp"}`,
        "Legacy hostCapability parameters are rejected. Select Sandbox or host mode explicitly.",
        ...(policy.diagnostic ? [policy.diagnostic] : []),
    ].join("\n");
}
