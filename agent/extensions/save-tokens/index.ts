/**
 * Extension entry point for tools to save llm tokens consumption.
 *
 * Pipeline order (critical — registration determines handler chain ordering):
 *   1. Telemetry BEFORE — raw tool_result observer (pre-compression)
 *   2. Local tool-result compressor — compresses tool output
 *   3. Caveman — terse output mode
 *   4. Ponytail — lazy senior dev mode
 *   5. Telemetry AFTER — final tool_result observer (post-compression) + lifecycle
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import caveman from './caveman.ts';
import localToolResultCompressor from './local-tool-result-compressor.ts';
import ponytail from './ponytail.ts';
import { createSaveTokensTelemetry } from './telemetry/controller.ts';
import { registerTelemetryCommands } from './telemetry/commands.ts';

export default function saveTokens(pi: ExtensionAPI) {
    const telemetry = createSaveTokensTelemetry(pi);

    // 1. Pre-compression raw observers
    telemetry.before();

    // 2. Compression pipeline
    localToolResultCompressor(pi);
    caveman(pi);
    ponytail(pi);

    // 5. Post-compression final observers + lifecycle + mode scan
    telemetry.after();

    // 6. Register telemetry commands (after pipeline so context is established)
    registerTelemetryCommands(pi, telemetry);
}
