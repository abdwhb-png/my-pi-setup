/**
 * Extension entry point for tools to save llm tokens consumption.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import localToolResultCompressor from "./local-tool-result-compressor.ts";
import caveman from "./caveman.ts";

export default function saveTokens(pi: ExtensionAPI) {
  localToolResultCompressor(pi);
  caveman(pi);
}