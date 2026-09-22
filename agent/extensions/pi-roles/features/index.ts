/**
 * Integrated features for the pi-roles extension.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import atlasPiSubagents from "./atlas-pi-subagents.ts";
import planAutoSwitch from "./plan-auto-switch.ts";
import promptRoleSwitch from "./prompt-role-switch.ts";
import roleSubagents from "./role-subagents.ts";
import sessionPlanPersistenceGuard from "./session-plan-persistence-guard.ts";

export default function registerRoleFeatures(pi: ExtensionAPI): void {
    atlasPiSubagents(pi);
    planAutoSwitch(pi);
    promptRoleSwitch(pi);
    roleSubagents(pi);
    sessionPlanPersistenceGuard(pi);
}
