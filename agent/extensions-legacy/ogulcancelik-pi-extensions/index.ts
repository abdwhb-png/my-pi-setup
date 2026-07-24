/**
 * ogulcancelik-pi-agent-extensions — curated extensions from ogulcancelik/pi-agent-extensions
 *
 * Combines multiple extensions into a single auto-discoverable module:
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import modelAgents from './model-agents.ts';

export default function ogulcancelikExtensions(pi: ExtensionAPI) {
    modelAgents(pi);
}
