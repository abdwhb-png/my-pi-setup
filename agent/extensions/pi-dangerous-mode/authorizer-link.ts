import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    getPermissionsService,
    PERMISSIONS_READY_CHANNEL,
} from "@gotgenes/pi-permission-system";
import type { PermissionsReadyEvent } from "@gotgenes/pi-permission-system";
import { isDangerousEnabled } from "./runner-patch.ts";

const LINK_NAME = "pi-dangerous-mode";

/**
 * Registers the live Dangerous authority link. The permission service resolves
 * it only when its authorizer-chain configuration explicitly names this link.
 */
export function installAuthorizerLink(pi: ExtensionAPI): void {
    const disposers: Array<() => void> = [];

    pi.events.on(
        PERMISSIONS_READY_CHANNEL,
        (payload: unknown) => {
            const ready = payload as PermissionsReadyEvent;
            if (!ready?.sessionId) return;

            const service = getPermissionsService(ready.sessionId);
            if (!service) return;

            // permissions:ready fires at least once per session and may repeat
            // (v27+); registering again without disposing would throw.
            for (const dispose of disposers.splice(0)) dispose();
            const dispose = service.registerAuthorizer(
                LINK_NAME,
                async (_details, _query, log) => {
                    if (!isDangerousEnabled()) return { kind: "defer" };
                    log.debug("dangerous_mode.auto_allow", {});
                    return { kind: "allow" };
                },
            );
            if (typeof dispose === "function") disposers.push(dispose);
        },
    );

    pi.on("session_shutdown", () => {
        for (const dispose of disposers.splice(0)) dispose();
    });
}
