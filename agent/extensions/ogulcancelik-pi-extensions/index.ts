/**
 * ogulcancelik-pi-agent-extensions — curated extensions from ogulcancelik/pi-agent-extensions
 *
 * Combines multiple extensions into a single auto-discoverable module:
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import modelThinking from "./model-thinking.ts";
import piHerdr from "./pi-herdr.ts";

export default function ogulcancelikExtensions(pi: ExtensionAPI) {
  modelThinking(pi);
  piHerdr(pi);
}