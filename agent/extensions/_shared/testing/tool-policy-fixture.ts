import { afterEach } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSharedVisibilityBroker } from "../tool-groups/broker.ts";
import { getToolPolicy, type PolicyHost } from "../tool-policy/index.ts";

const cleanup: Array<() => void> = [];
let previousOwner: (() => void) | undefined;
afterEach(() => {
    for (const dispose of cleanup.splice(0).toReversed()) dispose();
});

type TestHook = (value: object, context?: object) => unknown;

/** Minimal synchronous/async event runner. Unlike Map.set, Pi retains every hook. */
export class TestHooks extends Map<string, TestHook> {
    private readonly callbacks = new Map<string, TestHook[]>();
    readonly sessionId = crypto.randomUUID();
    afterStart?: () => void;
    override set(event: string, handler: TestHook): this {
        const handlers = this.callbacks.get(event) ?? [];
        handlers.push(handler);
        this.callbacks.set(event, handlers);
        return super.set(event, (value, context = {}) => {
            const providedSessionManager =
                "sessionManager" in context &&
                typeof context.sessionManager === "object" &&
                context.sessionManager !== null
                    ? context.sessionManager
                    : {};
            const ctx = {
                ...context,
                sessionManager: {
                    getSessionId: () => this.sessionId,
                    getEntries: () => [],
                    ...providedSessionManager,
                },
            };
            let result: unknown;
            for (const callback of handlers) {
                result =
                    result instanceof Promise
                        ? result.then(() => callback(value, ctx))
                        : callback(value, ctx);
            }
            if (event === "session_start" && this.afterStart) {
                if (result instanceof Promise)
                    return result.then((resolvedValue: unknown) => {
                        this.afterStart!();
                        return resolvedValue;
                    });
                this.afterStart();
            }
            return result;
        });
    }
}

/** Mount the real calculator around unit-test external boundaries. */
export function mountPolicy(host: PolicyHost, hooks?: TestHooks) {
    previousOwner?.();
    const policy = getToolPolicy();
    const detach = policy.bind(host, { groups: {}, resolveMcp: () => [] });
    cleanup.push(detach);
    previousOwner = detach;
    if (hooks) hooks.afterStart = () => policy.start();
    else policy.start();
    return policy;
}

export function trackPolicyCleanup(dispose: () => void) {
    cleanup.push(dispose);
}

export function mountWorkflowPolicy(pi: ExtensionAPI) {
    const broker = getSharedVisibilityBroker();
    broker.resetSession();
    const policy = mountPolicy({
        registered: () => pi.getAllTools().map((tool) => tool.name),
        active: () => pi.getActiveTools(),
        apply: (names) => pi.setActiveTools(names),
    });
    policy.register("workflows", ({ registered }) =>
        broker.contribution(registered),
    );
    return policy;
}
