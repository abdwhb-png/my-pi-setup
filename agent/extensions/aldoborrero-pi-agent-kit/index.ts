/**
 * aldoborrero-pi-agent-kit — curated extensions from aldoborrero/pi-agent-kit
 *
 * Combines multiple extensions into a single auto-discoverable module:
 * - btw: desktop notification when agent finishes
 * - context: review write/edit changes before applying
 * - footer: add a footer to the agent's output
 * - until: wait for a condition to be met before proceeding
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import astGrep from "./ast-grep.ts";
import btw from "./btw.ts";
import context from "./context.ts";
import footer from "./footer.ts";
import until from "./until.ts";

export default function aldoborreroExtensions(pi: ExtensionAPI) {
  astGrep(pi);
  btw(pi);
  context(pi);
  footer(pi);
  until(pi);
}