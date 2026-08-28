/**
 * Addons for the pi-roles package/extension.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import atlasPiSubagents from "./atlas-pi-subagents.ts";
import planAutoSwitch from "./plan-auto-switch.ts";
import registerPlanSubmissionGuard from "./plan-submission-guard.ts";
import promptRoleSwitch from "./prompt-role-switch.ts";
import roleSubagents from "./role-subagents.ts";

export default function aldoborreroExtensions(pi: ExtensionAPI) {
    atlasPiSubagents(pi);
    planAutoSwitch(pi);
    registerPlanSubmissionGuard(pi);
    promptRoleSwitch(pi);
    roleSubagents(pi);
}
