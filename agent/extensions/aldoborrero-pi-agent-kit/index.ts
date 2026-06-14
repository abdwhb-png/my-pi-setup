/**
 * aldoborrero-pi-agent-kit — curated extensions from aldoborrero/pi-agent-kit
 *
 * Combines multiple extensions into a single auto-discoverable module:
 * - btw: desktop notification when agent finishes
 * - context: review write/edit changes before applying
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import btw from "./btw.ts";
import context from "./context.ts";
import footer from "./footer.ts";

export default function aldoborreroExtensions(pi: ExtensionAPI) {
  btw(pi);
  context(pi);
  footer(pi);
}