import { matchesGlob, resolve } from "node:path";
import { DOCKER_OPERATIONS } from "../runtime/contracts.ts";
import type { PiSandboxConfig } from "../runtime/policies.ts";
import { expandShellPathEntry } from "../runtime/shell-baseline.ts";
import { domainIsWithin } from "./policy.ts";

function contains(root: string, target: string): boolean {
    return (
        root === target ||
        target.startsWith(root.endsWith("/") ? root : root + "/")
    );
}
function paths(values: string[], cwd: string): string[] {
    return values.map((value) => resolve(cwd, expandShellPathEntry(value)));
}
function removed(
    previous: string[],
    next: string[],
    covered = (old: string, current: string) => old === current,
): boolean {
    return previous.some(
        (old) => !next.some((current) => covered(old, current)),
    );
}
function newRelevantDeny(
    previous: string[],
    next: string[],
    grants: string[],
    cwd: string,
): boolean {
    return next.some(
        (deny) =>
            !previous.includes(deny) &&
            grants.some((grant) => {
                const root = resolve(cwd, expandShellPathEntry(deny));
                const prefix =
                    root.split(/[*?[\]{}]/, 1)[0].replace(/\/$/, "") || "/";
                return (
                    contains(grant, prefix) ||
                    contains(prefix, grant) ||
                    matchesGlob(grant, root)
                );
            }),
    );
}

/** Compare resource authority, not command outcomes or the selected display label. */
export function sandboxAccessRemoved(
    previous: PiSandboxConfig,
    next: PiSandboxConfig,
    cwd = process.cwd(),
): boolean {
    const oldRead = paths(
        [...previous.filesystem.allowRead, ...previous.filesystem.allowWrite],
        cwd,
    );
    const newRead = paths(
        [...next.filesystem.allowRead, ...next.filesystem.allowWrite],
        cwd,
    );
    const oldWrite = paths(previous.filesystem.allowWrite, cwd),
        newWrite = paths(next.filesystem.allowWrite, cwd);
    if (
        removed(oldRead, newRead, (old, current) => contains(current, old)) ||
        removed(oldWrite, newWrite, (old, current) => contains(current, old)) ||
        newRelevantDeny(
            previous.filesystem.denyRead,
            next.filesystem.denyRead,
            oldRead,
            cwd,
        ) ||
        newRelevantDeny(
            previous.filesystem.denyWrite,
            next.filesystem.denyWrite,
            oldWrite,
            cwd,
        )
    )
        return true;
    if (previous.tmpNamespace === "host" && next.tmpNamespace !== "host")
        return true;
    for (const field of ["allowedDomains", "allowedHostDomains"] as const)
        if (
            removed(
                previous.network[field],
                next.network[field],
                domainIsWithin,
            )
        )
            return true;
    if (
        next.network.deniedDomains.some(
            (deny) =>
                !previous.network.deniedDomains.includes(deny) &&
                [
                    ...previous.network.allowedDomains,
                    ...previous.network.allowedHostDomains,
                ].some(
                    (grant) =>
                        domainIsWithin(grant, deny) ||
                        domainIsWithin(deny, grant),
                ),
        )
    )
        return true;
    if (previous.network.allowLocalBinding && !next.network.allowLocalBinding)
        return true;
    const oldVariables = [
        ...previous.environment.allowedVariables,
        ...Object.keys(previous.environment.variables),
    ].filter((name) => !previous.environment.deniedVariables.includes(name));
    const newVariables = [
        ...next.environment.allowedVariables,
        ...Object.keys(next.environment.variables),
    ].filter((name) => !next.environment.deniedVariables.includes(name));
    if (removed(oldVariables, newVariables)) return true;
    const oldResources = previous.resources ?? {
            unixSockets: [],
            tcpPublications: [],
        },
        newResources = next.resources ?? {
            unixSockets: [],
            tcpPublications: [],
        };
    if (
        removed(oldResources.unixSockets, newResources.unixSockets) ||
        removed(
            oldResources.tcpPublications.map((item) => JSON.stringify(item)),
            newResources.tcpPublications.map((item) => JSON.stringify(item)),
        )
    )
        return true;
    if (previous.docker.mode !== "disabled") {
        if (
            next.docker.mode === "disabled" ||
            previous.docker.endpoint !== next.docker.endpoint
        )
            return true;
        if (previous.docker.mode === "full") return next.docker.mode !== "full";
        if (next.docker.mode === "targeted") {
            const targets = next.docker.targets;
            return previous.docker.targets.some((old) => {
                const current = targets.find(
                    (item) =>
                        JSON.stringify(item.selector) ===
                        JSON.stringify(old.selector),
                );
                return (
                    !current ||
                    (old.allowUnsafeTarget && !current.allowUnsafeTarget) ||
                    removed(
                        old.operations ?? [...DOCKER_OPERATIONS],
                        current.operations ?? [...DOCKER_OPERATIONS],
                    )
                );
            });
        }
    }
    return false;
}
