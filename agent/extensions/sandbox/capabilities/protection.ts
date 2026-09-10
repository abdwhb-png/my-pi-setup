import {
    existsSync,
    lstatSync,
    readlinkSync,
    realpathSync,
    statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { expandCapabilityPath } from "./authority.ts";

export function canonicalPotentialPath(
    path: string,
    remainingLinks = 40,
): string {
    if (remainingLinks < 0)
        throw new Error("Cannot resolve a symbolic-link cycle");
    const suffix: string[] = [];
    let parent = path;
    while (true) {
        let metadata;
        try {
            metadata = lstatSync(parent);
        } catch (error) {
            if (
                !(error instanceof Error) ||
                !("code" in error) ||
                (error.code !== "ENOENT" && error.code !== "ENOTDIR")
            )
                throw error;
            const next = dirname(parent);
            if (next === parent) throw error;
            suffix.unshift(basename(parent));
            parent = next;
            continue;
        }
        // lstat observes dangling links. existsSync would mistake them for a
        // nonexistent ordinary path and authorize their eventual external target.
        const canonical = metadata.isSymbolicLink()
            ? canonicalPotentialPath(
                  resolve(dirname(parent), readlinkSync(parent)),
                  remainingLinks - 1,
              )
            : realpathSync(parent);
        return join(canonical, ...suffix);
    }
}
export function protectsCapabilityAuthority(
    path: string,
    cwd: string,
    authorityPath: string,
): boolean {
    const target = canonicalPotentialPath(
        path.startsWith("~") ? expandCapabilityPath(path) : resolve(cwd, path),
    );
    const authority = canonicalPotentialPath(authorityPath);
    if (
        target === authority ||
        target.startsWith(`${authority}.`) ||
        authority.startsWith(`${target}/`)
    )
        return true;
    if (existsSync(target) && existsSync(authority)) {
        const candidate = statSync(target);
        const protectedFile = statSync(authority);
        return (
            candidate.dev === protectedFile.dev &&
            candidate.ino === protectedFile.ino
        );
    }
    return false;
}
