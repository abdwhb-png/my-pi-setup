/**
 * rytswd-pi-agent-extensions — curated extensions from rytswd/pi-agent-extensions
 *
 * Combines multiple extensions into a single auto-discoverable module:
 * - notify: desktop notification when agent finishes
 * - slow-mode: review write/edit changes before applying
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import notify from "./notify.ts";

export default function rytswdExtensions(pi: ExtensionAPI) {
  notify(pi);
}