import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getPermissionsService } from "@gotgenes/pi-permission-system";
import { isDangerousEnabled } from "./runner-patch.ts";

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
            async (_details, _query, log) => {
                if (!isDangerousEnabled()) return { kind: "defer" };
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
