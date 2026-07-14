/**
 * aldoborrero-pi-agent-kit — curated extensions from aldoborrero/pi-agent-kit
 *
 * Combines multiple extensions into a single auto-discoverable module:
 * - btw: desktop notification when agent finishes
 * - context: review write/edit changes before applying
 * - until: wait for a condition to be met before proceeding
 *
 * Note: the old footer extension was migrated to ../session-status-bar/
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import btw from './btw.ts';
import until from './until.ts';

export default function aldoborreroExtensions(pi: ExtensionAPI) {
    btw(pi);
    until(pi);
}
