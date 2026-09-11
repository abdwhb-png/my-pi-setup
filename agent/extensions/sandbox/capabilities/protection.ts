import {
    existsSync,
    lstatSync,
    readlinkSync,
    realpathSync,
    statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalPotentialPath, expandCapabilityPath } from "./authority.ts";

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
