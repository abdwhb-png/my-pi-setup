/**
 * Extension entry point for tools to save llm tokens consumption.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import caveman from './caveman.ts';
import localToolResultCompressor from './local-tool-result-compressor.ts';
import ponytail from './ponytail.ts';

export default function saveTokens(pi: ExtensionAPI) {
    localToolResultCompressor(pi);
    caveman(pi);
    ponytail(pi);
}
