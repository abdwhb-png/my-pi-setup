import { existsSync } from "node:fs";
import { resolve } from "node:path";

const EXTENSIONS_ROOT = resolve(import.meta.dir, "../..");
const EXTENSION_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Resolve only a public Pi extension entrypoint, never an implementation file. */
export function publicExtensionEntrypoint(name: string): string {
    if (!EXTENSION_NAME.test(name))
        throw new Error(`Invalid extension name: ${name}`);
    const candidates = [
        resolve(EXTENSIONS_ROOT, `${name}.ts`),
        resolve(EXTENSIONS_ROOT, name, "index.ts"),
    ];
    const matches = candidates.filter(existsSync);
    if (matches.length !== 1)
        throw new Error(
            `Expected one public entrypoint for ${name}, found ${matches.length}`,
        );
    return matches[0];
}

export function publicExtensionEntrypoints(...names: string[]): string[] {
    return names.map(publicExtensionEntrypoint);
}
