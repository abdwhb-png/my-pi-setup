import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { expandCapabilityPath } from "./authority.ts";

function canonicalPotentialPath(path: string): string {
    const suffix: string[] = [];
    let parent = path;
    while (!existsSync(parent)) {
        const next = dirname(parent);
        if (next === parent) return path;
        suffix.unshift(basename(parent));
        parent = next;
    }
    return join(realpathSync(parent), ...suffix);
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
