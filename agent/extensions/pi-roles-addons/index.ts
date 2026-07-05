/**
 * Addons for the pi-roles package/extension.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import planAutoSwitch from "./plan-auto-switch.ts";
import promptRoleSwitch from "./prompt-role-switch.ts";
import roleWidget from "./role-widget.ts";

export default function aldoborreroExtensions(pi: ExtensionAPI) {
  planAutoSwitch(pi);
  promptRoleSwitch(pi);
  roleWidget(pi);
}