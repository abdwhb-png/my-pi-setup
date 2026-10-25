import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { RoleToolPolicyPayload } from "../pi-roles/index.ts";
import { resolveToolAliases } from "../tool-groups/resolver.ts";
import type {
    ToolGroupDiagnostic,
    ToolGroupsConfig,
} from "../tool-groups/types.ts";

export interface PolicyView {
    readonly role: RoleToolPolicyPayload | undefined;
    readonly registered: ReadonlyArray<
        Pick<ToolInfo, "name" | "exposure" | "namespace">
    >;
}

/** Grants are explicit entry actions; defaults never widen an explicit role. */
export interface ToolPolicyContribution {
    defaults?: readonly string[];
    grants?: readonly string[];
    deny?: readonly string[];
}
export type PolicyContributor = (view: PolicyView) => ToolPolicyContribution;
export interface PolicyHost {
    registered(): Array<Pick<ToolInfo, "name" | "exposure" | "namespace">>;
    active(): string[];
    apply(names: string[]): void;
}
export interface PolicyConfiguration {
    onSessionStart?: () => void;
    groups: ToolGroupsConfig["groups"];
    requested?: readonly string[];
    childAllowed?: readonly string[];
    resolveMcp: (reference: string) => string[];
}
export interface PolicySnapshot {
    names: string[];
    activeNames: string[];
    diagnostics: ToolGroupDiagnostic[];
    excluded: Record<string, string>;
    sources: string[];
    revision: number;
    externalDrift: { added: string[]; removed: string[] } | undefined;
}

export function calculateToolPolicy(
    view: PolicyView,
    baseline: readonly string[],
    config: PolicyConfiguration,
    contributions: ReadonlyArray<readonly [string, ToolPolicyContribution]>,
    activatedDeferred: readonly string[] = [],
): Omit<PolicySnapshot, "revision" | "externalDrift"> {
    const diagnostics: ToolGroupDiagnostic[] = [];
    const excluded: Record<string, string> = {};
    const resolve = (refs: readonly string[]) => {
        const result = resolveToolAliases(
            [...refs],
            view.registered.map((tool) => tool.name),
            config.groups,
            config.resolveMcp,
        );
        diagnostics.push(...result.diagnostics);
        return result.names;
    };
    const base =
        view.role?.mode === "set"
            ? view.role.toolNames
            : view.role?.mode === "all"
              ? view.registered.map((tool) => tool.name)
              : [
                    ...baseline,
                    ...view.registered
                        .filter(
                            (tool) =>
                                tool.exposure === "codemode" ||
                                tool.exposure === "deferred",
                        )
                        .map((tool) => tool.name),
                ];
    let names = resolve(base);
    for (const [, contribution] of contributions) {
        if (view.role?.mode !== "set")
            names.push(...resolve(contribution.defaults ?? []));
        names.push(...resolve(contribution.grants ?? []));
    }
    names = [...new Set(names)];
    const limit = (allowed: Set<string>, reason: string) => {
        names = names.filter((name) => {
            if (allowed.has(name)) return true;
            excluded[name] = reason;
            return false;
        });
    };
    if (config.requested)
        limit(new Set(resolve(config.requested)), "CLI tool policy");
    if (config.childAllowed)
        limit(new Set(config.childAllowed), "child tool policy");
    for (const [source, contribution] of contributions) {
        const denied = new Set(resolve(contribution.deny ?? []));
        names = names.filter((name) => {
            if (!denied.has(name)) return true;
            excluded[name] = source;
            return false;
        });
    }
    const exposures = new Map(
        view.registered.map((tool) => [tool.name, tool.exposure]),
    );
    names = names.filter((name) => {
        if (exposures.get(name) !== "hidden") return true;
        excluded[name] = "hidden exposure";
        return false;
    });
    // A tool group is a configuration placeholder, never an executable tool.
    return {
        names: names.filter((n) => !n.startsWith("@")),
        activeNames: names.filter(
            (name) =>
                !name.startsWith("@") &&
                (exposures.get(name) === "direct" ||
                    exposures.get(name) === "model-only" ||
                    activatedDeferred.includes(name)),
        ),
        diagnostics,
        excluded,
        sources: contributions.map(([source]) => source),
    };
}

/** One process-local coordinator. Only the host adapter may write Pi's tools. */
export function createToolPolicyCoordinator() {
    let role: RoleToolPolicyPayload | undefined;
    let host: PolicyHost | undefined;
    let configuration: PolicyConfiguration | undefined;
    let baseline: string[] = [];
    let sessionId: string | undefined;
    let ready = false;
    let evaluating = false;
    let applying = false;
    let dirty = false;
    let signature: string | undefined;
    let revision = 0;
    let snapshot: PolicySnapshot | undefined;
    const contributors = new Map<
        string,
        { token: symbol; evaluate: PolicyContributor }
    >();

    const assertMutable = () => {
        if (evaluating)
            throw new Error(
                "Tool-policy contributors must be pure; mutation during evaluation is forbidden",
            );
    };
    function observe(): PolicySnapshot | undefined {
        if (!snapshot || !host) return undefined;
        const current = snapshot;
        const active = host.active();
        const added = active.filter(
            (name) => !current.activeNames.includes(name),
        );
        const removed = current.activeNames.filter(
            (name) => !active.includes(name),
        );
        return structuredClone({
            ...current,
            externalDrift:
                added.length || removed.length ? { added, removed } : undefined,
        });
    }
    function refresh(force = false): PolicySnapshot | undefined {
        assertMutable();
        if (!host || !configuration || !ready) return snapshot;
        if (applying) {
            dirty = true;
            return snapshot;
        }
        let passes = 0;
        do {
            if (++passes > 32)
                throw new Error("Tool-policy invalidation did not converge");
            dirty = false;
            const registered = Object.freeze(
                host.registered().map(({ name, exposure, namespace }) =>
                    Object.freeze({
                        name,
                        exposure,
                        namespace: namespace && Object.freeze({ ...namespace }),
                    }),
                ),
            );
            const roleView = role && structuredClone(role);
            if (roleView) {
                Object.freeze(roleView.toolNames);
                Object.freeze(roleView);
            }
            const view = Object.freeze({ role: roleView, registered });
            let contributions: Array<readonly [string, ToolPolicyContribution]>;
            evaluating = true;
            try {
                contributions = [...contributors.entries()]
                    .toSorted(([a], [b]) => a.localeCompare(b))
                    .map(
                        ([source, value]) =>
                            [source, value.evaluate(view)] as const,
                    );
            } finally {
                evaluating = false;
            }
            const active = host.active();
            const activatedDeferred = registered
                .filter(
                    (tool) =>
                        (tool.exposure === "deferred" ||
                            tool.exposure === "codemode") &&
                        active.includes(tool.name),
                )
                .map((tool) => tool.name);
            const nextSignature = JSON.stringify([
                activatedDeferred,
                role,
                registered,
                configuration.groups,
                configuration.requested,
                configuration.childAllowed,
                contributions,
            ]);
            if (!force && signature === nextSignature && snapshot) {
                return observe();
            }
            const result = calculateToolPolicy(
                view,
                baseline,
                configuration,
                contributions,
                activatedDeferred,
            );
            signature = nextSignature;
            snapshot = {
                ...result,
                revision: ++revision,
                externalDrift: undefined,
            };
            if (
                active.length !== result.activeNames.length ||
                active.some((n, i) => n !== result.activeNames[i])
            ) {
                applying = true;
                try {
                    host.apply([...result.activeNames]);
                } finally {
                    applying = false;
                }
            }
            force = dirty;
        } while (dirty);
        return snapshot && structuredClone(snapshot);
    }
    return {
        beginSession(id: string) {
            assertMutable();
            if (sessionId === id) return;
            sessionId = id;
            contributors.clear();
            role = undefined;
            signature = undefined;
            snapshot = undefined;
            baseline = [];
            ready = false;
            configuration?.onSessionStart?.();
        },
        bind(nextHost: PolicyHost, config: PolicyConfiguration) {
            assertMutable();
            if (host && !ready)
                throw new Error("A tool-policy runtime owner is already bound");
            // A new loader generation may follow SDK dispose (which does not emit
            // session_shutdown). Invalidate every old registration before startup.
            contributors.clear();
            role = undefined;
            signature = undefined;
            snapshot = undefined;
            sessionId = undefined;
            ready = false;
            host = nextHost;
            configuration = config;
            return () => {
                if (host !== nextHost) return;
                host = undefined;
                configuration = undefined;
                ready = false;
                role = undefined;
                signature = undefined;
                snapshot = undefined;
                sessionId = undefined;
                contributors.clear();
            };
        },
        start() {
            assertMutable();
            if (!host)
                throw new Error("Tool-policy runtime owner is not bound");
            if (!ready) baseline = host.active();
            ready = true;
            return refresh(true);
        },
        setRole(next: RoleToolPolicyPayload) {
            assertMutable();
            role = structuredClone(next);
            return refresh();
        },
        register(source: string, evaluate: PolicyContributor) {
            assertMutable();
            if (!source.trim())
                throw new Error("Tool-policy source is required");
            const token = Symbol(source);
            contributors.set(source, { token, evaluate });
            const current = () => {
                assertMutable();
                if (contributors.get(source)?.token !== token)
                    throw new Error(
                        `Stale tool-policy contribution: ${source}`,
                    );
            };
            return {
                assertCurrent() {
                    current();
                },
                refresh() {
                    current();
                    return refresh();
                },
                replace(next: PolicyContributor) {
                    current();
                    contributors.set(source, { token, evaluate: next });
                    return refresh();
                },
                dispose() {
                    assertMutable();
                    if (contributors.get(source)?.token !== token) return;
                    contributors.delete(source);
                    refresh();
                },
            };
        },
        refresh,
        getRole() {
            return role && structuredClone(role);
        },
        inspect() {
            return observe();
        },
    };
}

const KEY = Symbol.for("pi.tool-policy.coordinator.v1");
type Registry = typeof globalThis & {
    [KEY]?: ReturnType<typeof createToolPolicyCoordinator>;
};
export function getToolPolicy() {
    const root = globalThis as Registry;
    return (root[KEY] ??= createToolPolicyCoordinator());
}

/** Register at factory time. No Pi runtime reads occur until session_start. */
export function registerToolPolicyContribution(
    pi: ExtensionAPI,
    source: string,
    evaluate: PolicyContributor,
) {
    const coordinator = getToolPolicy();
    let registration: ReturnType<typeof coordinator.register> | undefined;
    pi.on("session_start", (_event, ctx) => {
        coordinator.beginSession(ctx.sessionManager.getSessionId());
        registration?.dispose();
        registration = coordinator.register(source, evaluate);
    });
    pi.on("session_shutdown", () => {
        registration?.dispose();
        registration = undefined;
    });
    return {
        captureGuard() {
            if (!registration)
                throw new Error(
                    `Tool-policy source ${source} has no active session`,
                );
            const current = registration;
            return () => current.assertCurrent();
        },
        captureRefresh() {
            if (!registration)
                throw new Error(
                    `Tool-policy source ${source} has no active session`,
                );
            const current = registration;
            return () => current.refresh();
        },
        refresh() {
            if (!registration)
                throw new Error(
                    `Tool-policy source ${source} has no active session`,
                );
            return registration.refresh();
        },
        dispose() {
            registration?.dispose();
            registration = undefined;
        },
    };
}
