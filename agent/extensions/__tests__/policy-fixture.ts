import { afterEach } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSharedVisibilityBroker } from "../_shared/tool-groups/broker.ts";
import {
    getToolPolicy,
    type PolicyHost,
} from "../_shared/tool-policy/index.ts";

const cleanup: Array<() => void> = [];
let previousOwner: (() => void) | undefined;
afterEach(() => {
    for (const dispose of cleanup.splice(0).reverse()) dispose();
});

/** Minimal synchronous/async event runner. Unlike Map.set, Pi retains every hook. */
export class TestHooks extends Map<string, (...args: any[]) => any> {
    private readonly callbacks = new Map<
        string,
        Array<(...args: any[]) => any>
    >();
    readonly sessionId = crypto.randomUUID();
    afterStart?: () => void;
    override set(event: string, handler: (...args: any[]) => any): this {
        const handlers = this.callbacks.get(event) ?? [];
        handlers.push(handler);
        this.callbacks.set(event, handlers);
        return super.set(event, (value = {}, context = {}) => {
            const ctx = {
                ...context,
                sessionManager: {
                    getSessionId: () => this.sessionId,
                    getEntries: () => [],
                    ...context.sessionManager,
                },
            };
            let result: any;
            for (const callback of handlers) {
                result =
                    result instanceof Promise
                        ? result.then(() => callback(value, ctx))
                        : callback(value, ctx);
            }
            if (event === "session_start" && this.afterStart) {
                if (result instanceof Promise)
                    return result.then((value) => {
                        this.afterStart!();
                        return value;
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
        registered: () => pi.getAllTools().map((t) => t.name),
        active: () => pi.getActiveTools(),
        apply: (names) => pi.setActiveTools(names),
    });
    policy.register("workflows", ({ registered }) =>
        broker.contribution(registered),
    );
    return policy;
}
