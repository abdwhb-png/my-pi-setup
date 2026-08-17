/**
 * Backend registry — selects and instantiates compression backends.
 *
 * Policy: Exactly one backend is selected per session, determined by the
 * resolved configuration. No inter-engine fallback. Invalid configs fail-open
 * to cap/archive without escaping errors.
 */

import type { ResolvedCompressorConfig } from "../config-runtime";
import { EdgeeBackend } from "./backends/edgee";
import type { EdgeeBackendConfig } from "./backends/edgee";
import { HeadroomBackend } from "./headroom";
import type { CompressionBackend } from "./types";

/**
 * Static registry that holds the selected backend instance.
 * Created once per session; if config is invalid, returns null and
 * compression gracefully falls back to cap/archive.
 */
export class CompressionBackendRegistry {
    private backend: CompressionBackend | null;

    constructor(private config: ResolvedCompressorConfig) {
        this.backend = this.selectBackend();
    }

    private selectBackend(): CompressionBackend | null {
        // Invalid config → no backend (fail-open to cap/archive)
        if (!this.config.valid) {
            return null;
        }

        const { backend, backendConfig } = this.config;

        if (backend === "headroom") {
            return new HeadroomBackend(backendConfig);
        }

        if (backend === "edgee") {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            const cfg = backendConfig as EdgeeBackendConfig;
            return new EdgeeBackend(cfg);
        }

        // Unreachable if config validation is sound
        return null;
    }

    /**
     * Get the selected backend, or null if config is invalid.
     * Caller must check for null and fail-open to cap/archive.
     */
    getBackend(): CompressionBackend | null {
        return this.backend;
    }

    /**
     * Get resolved config (includes diagnostics).
     */
    getConfig(): ResolvedCompressorConfig {
        return this.config;
    }
}
