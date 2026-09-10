import { realpathSync } from "node:fs";
import { CapabilityError, type HostCapability } from "./authority.ts";
import type { ShellCapabilityResolution } from "./policy.ts";

interface ShellRuntime {
    owner: symbol;
    resolve(): ShellCapabilityResolution;
}
export interface ActiveShellOperation {
    id: number;
    projectRoot: string;
    profile: ShellCapabilityResolution["profile"];
    capability?: HostCapability;
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
): void {
    registry().runtime = { owner, resolve };
}
export function releaseShellRuntime(owner: symbol): void {
    if (registry().runtime?.owner === owner) delete registry().runtime;
}
export function currentShellPolicy(): ShellCapabilityResolution | undefined {
    return registry().runtime?.resolve();
}
export function requireShellPolicy(
    cwd: string,
    capability?: HostCapability,
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
    if (
        capability &&
        (policy.profile === "isolated" ||
            !policy.grants.integrations[capability])
    )
        throw new CapabilityError(
            "authorization-required",
            `Use /sandbox capabilities grant ${capability}. The command was not executed.`,
        );
    return policy;
}
export async function trackShellOperation<T>(
    policy: ShellCapabilityResolution,
    command: string,
    capability: HostCapability | undefined,
    run: () => Promise<T>,
): Promise<T> {
    const state = registry();
    const id = ++state.sequence;
    state.active.set(id, {
        id,
        command,
        profile: policy.profile,
        projectRoot: policy.projectRoot,
        capability,
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
        `Network: ${policy.profile === "host" ? "host network (shell sandbox restrictions do not apply)" : policy.grants.domains.concat(policy.grants.hostDomains).join(", ") || "denied"}`,
        `Temporary files: ${policy.profile === "host" || policy.grants.hostTmp ? "host /tmp" : "private /tmp; native file tools see a different /tmp"}`,
        `Host integrations: ${Object.keys(policy.grants.integrations).join(", ") || "none"}`,
        "hostCapability requests an existing local grant. Failure never authorizes host execution.",
        "Host integrations execute outside the shell sandbox with host network and /tmp. Command permissions and Safe Bash guards still apply.",
        ...(policy.diagnostic ? [policy.diagnostic] : []),
    ].join("\n");
}
