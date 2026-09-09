import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerPiRolesCore from "./core/index.ts";
import registerRoleFeatures from "./features/index.ts";

export default function piRoles(pi: ExtensionAPI): void {
    registerPiRolesCore(pi);
    registerRoleFeatures(pi);
}
