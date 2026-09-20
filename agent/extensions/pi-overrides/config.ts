import {
    DEFAULT_CONFIG,
    type FileResolverConfig,
} from "../_shared/file-search/config.ts";

export {
    DEFAULT_CONFIG,
    loadFileResolverConfig,
    mergeFileResolverConfig,
    normalizeFileResolverConfig,
    type FdConfig,
    type FileResolverConfig,
    type LsConfig,
    type RgConfig,
} from "../_shared/file-search/config.ts";

let runtimeConfig: FileResolverConfig = DEFAULT_CONFIG;

export function getFileResolverConfig(): FileResolverConfig {
    return runtimeConfig;
}

export function setFileResolverConfig(config: FileResolverConfig): void {
    runtimeConfig = config;
}
