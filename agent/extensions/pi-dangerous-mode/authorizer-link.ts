import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getPermissionsService } from "@gotgenes/pi-permission-system";
import { evaluateAutopilotGuard } from "./guard-policy.ts";
import { isDangerousEnabled } from "./runner-patch.ts";
import {
    completeAutopilot,
    getMutableRuntimeState,
    isAutopilotEnabled,
} from "./runtime-state.ts";

const LINK_NAME = "pi-dangerous-mode";
const PERMISSIONS_READY_CHANNEL = "permissions:ready";

/**
 * Register a live-authority chain link with @gotgenes/pi-permission-system.
 *
 * While dangerous mode is enabled for the session, the link answers every
 * `ask` with `{ kind: "allow" }`; otherwise it defers so the normal prompt
 * path (next link or human terminal authorizer) stays reachable. The verdict
 * reads live session state on each ask, so /dangerous-mode off takes effect
 * immediately.
 *
 * Activation is opt-in: the operator must list "pi-dangerous-mode" in the
 * package's `authorizerChain` config. Without that entry the registered link
 * is never resolved and every ask prompts as usual (fail-safe).
 *
 * Re-registration per permissions:ready generation keeps /reload correct;
 * disposers run at session_shutdown.
 */
export function installAuthorizerLink(pi: ExtensionAPI): void {
    const disposers: Array<() => void> = [];

    pi.events.on(PERMISSIONS_READY_CHANNEL, () => {
        const service = getPermissionsService();
        if (!service) return;

        const dispose = service.registerAuthorizer(
            LINK_NAME,
            async (details, _query, log) => {
                if (!isDangerousEnabled()) return { kind: "defer" };

                if (isAutopilotEnabled()) {
                    const state = getMutableRuntimeState();
                    const toolName =
                        details.toolName ??
                        (details.command ? "bash" : "permission");
                    const values = [details.command, details.target].filter(
                        (value): value is string => typeof value === "string",
                    );
                    const guard =
                        values
                            .map((command) =>
                                evaluateAutopilotGuard(
                                    {
                                        toolName,
                                        input: { command },
                                    },
                                    state.config.autopilot,
                                ),
                            )
                            .find((result) => result !== undefined) ??
                        evaluateAutopilotGuard(
                            { toolName, input: {} },
                            state.config.autopilot,
                        );
                    if (guard) {
                        completeAutopilot({
                            outcome: "blocked",
                            reason: `Autopilot guard: ${guard.category}`,
                        });
                        log.review("autopilot.guard_blocked", {
                            category: guard.category,
                            toolName: guard.toolName,
                        });
                        return {
                            kind: "deny",
                            reason: `Autopilot guard blocked ${guard.category}. Choose a safe reversible path or finish with autopilot_complete outcome=blocked.`,
                        };
                    }
                }

                log.debug("dangerous_mode.auto_allow", {});
                return { kind: "allow" };
            },
        );
        if (typeof dispose === "function") disposers.push(dispose);
    });

    pi.on("session_shutdown", () => {
        for (const dispose of disposers.splice(0)) dispose();
    });
}
