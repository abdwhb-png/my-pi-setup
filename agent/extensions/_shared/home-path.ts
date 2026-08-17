import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Expand the portable home notation used in persisted Pi configuration. */
export function expandHomePath(path: string, home = homedir()): string {
    if (path === "~") return home;
    if (path.startsWith("~/")) return resolve(home, path.slice(2));
    return path;
}

/** Convert an absolute path below the current home to the portable `~/` form. */
export function toPortableHomePath(path: string, home = homedir()): string {
    if (!isAbsolute(path)) return path;
    const resolvedHome = resolve(home);
    const resolvedPath = resolve(path);
    if (resolvedPath === resolvedHome) return "~";
    const pathFromHome = relative(resolvedHome, resolvedPath);
    if (
        !pathFromHome ||
        pathFromHome === ".." ||
        pathFromHome.startsWith(`..${sep}`) ||
        isAbsolute(pathFromHome)
    ) {
        return path;
    }
    return `~/${pathFromHome.split(sep).join("/")}`;
}

/** Resolve user input into an absolute path before filesystem or child-process I/O. */
export function resolveRuntimePath(
    path: string,
    cwd: string,
    home = homedir(),
): string {
    const expanded = expandHomePath(path, home);
    return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}
