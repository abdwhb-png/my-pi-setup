import { describe, expect, it } from "bun:test";

import { DEFAULT_CONFIG } from "../_shared/file-search/config.ts";
import { getFileResolverConfig, setFileResolverConfig } from "./config.ts";

describe("pi-overrides file-resolver runtime config", () => {
    it("starts from the shared default and stores the active session config", () => {
        expect(getFileResolverConfig()).toEqual(DEFAULT_CONFIG);
        const custom = {
            ...DEFAULT_CONFIG,
            fd: { ...DEFAULT_CONFIG.fd, respectGitignore: false },
        };
        setFileResolverConfig(custom);
        expect(getFileResolverConfig()).toBe(custom);
        setFileResolverConfig(DEFAULT_CONFIG);
    });
});
