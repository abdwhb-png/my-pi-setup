import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname, basename, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { expandHomePath } from "../_shared/home-path.ts";
import {
    type FileResolverConfig,
    loadFileResolverConfig,
    getFileResolverConfig,
    setFileResolverConfig,
} from "./config.ts";

// ---------------------------------------------------------------------------
// Public interface — exported for testing
// ---------------------------------------------------------------------------

export interface ParsedAtValue {
    path: string;
    isQuoted: boolean;
    isDirectory: boolean;
}

/**
 * Parse an @-prefixed autocomplete value into its components.
 */
export function parseAtValue(value: string): ParsedAtValue {
    let raw = value.startsWith("@") ? value.slice(1) : value;
    let isQuoted = false;

    if (raw.startsWith('"') && raw.endsWith('"')) {
        isQuoted = true;
        raw = raw.slice(1, -1);
    }

    const isDirectory = raw.endsWith("/");
    return { path: raw, isQuoted, isDirectory };
}

/**
 * Rebuild an @-prefixed autocomplete value from an absolute path and parsed metadata.
 */
export function rebuildAtValue(path: string, parsed: ParsedAtValue): string {
    const needsSlash = parsed.isDirectory && !path.endsWith("/");
    const display = needsSlash ? `${path}/` : path;
    if (parsed.isQuoted) return `@"${display}"`;
    return `@${display}`;
}

/**
 * Find unresolved bare @references in text.
 * Only matches `@bareword` (no `/`, no `~`, not already absolute).
 */
export function findUnresolvedAtRefs(
    text: string,
): Array<{ raw: string; name: string }> {
    const refs: Array<{ raw: string; name: string }> = [];
    const regex = /(?:^|\s)@([^\s@]+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
        const name = match[1];
        if (name.startsWith("/") || name.startsWith("~/")) continue;
        if (name.includes("/")) continue;
        refs.push({ raw: match[0].trim(), name });
    }
    return refs;
}

/**
 * Transform an @-prefixed autocomplete value from relative → absolute path.
 * Absolute and ~/ paths are left untouched.
 */
export function transformAtValue(value: string, cwd: string): string {
    const parsed = parseAtValue(value);
    const { path } = parsed;

    if (path.startsWith("/") || path.startsWith("~")) {
        return rebuildAtValue(path, parsed);
    }

    const absolute = resolve(cwd, path);
    return rebuildAtValue(absolute, parsed);
}

/**
 * Compute the Levenshtein (edit) distance between two strings.
 * Case-insensitive. Returns the minimum number of single-character
 * edits (insertions, deletions, substitutions) to transform a into b.
 */
export function levenshteinDistance(a: string, b: string): number {
    const s = a.toLowerCase();
    const t = b.toLowerCase();

    if (s.length === 0) return t.length;
    if (t.length === 0) return s.length;

    // Use two rows for O(min(m,n)) space
    let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
    let curr = new Array<number>(t.length + 1);

    for (let i = 0; i < s.length; i++) {
        curr[0] = i + 1;
        for (let j = 0; j < t.length; j++) {
            const cost = s[i] === t[j] ? 0 : 1;
            curr[j + 1] = Math.min(
                curr[j] + 1, // insertion
                prev[j + 1] + 1, // deletion
                prev[j] + cost, // substitution
            );
        }
        // Swap rows
        [prev, curr] = [curr, prev];
    }

    return prev[t.length];
}

/**
 * Match files by basename using Levenshtein distance as fallback.
 * Only returns files whose basename is within threshold edit distance.
 * Results sorted by ascending distance (best match first).
 */
export function fuzzyMatchBasename(files: string[], query: string): string[] {
    if (!query || files.length === 0) return [];

    const threshold = Math.max(2, Math.floor(query.length / 2));
    const scored: Array<{ file: string; distance: number }> = [];

    for (const file of files) {
        const basename = file.split("/").pop() ?? "";
        const distance = levenshteinDistance(basename, query);
        if (distance <= threshold) {
            scored.push({ file, distance });
        }
    }

    scored.sort((a, b) => a.distance - b.distance);
    return scored.map((entry) => entry.file);
}

/**
 * Enrich autocomplete items with cache-only files when git-ignore is disabled.
 * Only effective when `config.fd.respectGitignore` is false and cache is ready.
 *
 * Matching strategy:
 * - Bare name (no `/`): exact basename match first. If exact matches exist,
 *   use only those (no .bak, no fuzzy noise). If no exact match, fall back to
 *   fuzzy basename match (so partial @config still finds config.json).
 * - Path query (has `/`): fuzzy match on full path.
 *
 * No basename dedup — all matches are shown (disambiguated by description).
 * Dedup is by full path only (skips files already in built-in items).
 * Results ordered: CWD first, then additionalDirectories, then other roots.
 * Capped at 20 extra entries.
 */
export function enrichAutocompleteWithCache(
    prefix: string,
    items: Array<{ value: string; label: string; description?: string }>,
    cache: { files: string[]; ready: boolean },
    config: FileResolverConfig,
    options?: { forceExternal?: boolean; cwd?: string },
): Array<{ value: string; label: string; description?: string }> {
    if (!prefix.startsWith("@")) return items;
    if (!options?.forceExternal && config.fd.respectGitignore) return items;
    if (!cache.ready) return items;

    const parsed = parseAtValue(prefix);
    if (!parsed.path) return items;

    const query = parsed.path.replace(/\/+$/, "");
    const isBareName = !query.includes("/");

    let extraFiles: string[];
    if (isBareName) {
        const lowerQuery = query.toLowerCase();
        // Exact basename match first
        const exact = cache.files.filter((f) => {
            const base = f.split("/").pop() ?? "";
            return base.toLowerCase() === lowerQuery;
        });
        // Use exact if found, else fuzzy basename fallback
        extraFiles =
            exact.length > 0
                ? exact
                : fuzzyFilter(
                      cache.files,
                      query,
                      (f) => f.split("/").pop() ?? "",
                  );
    } else {
        extraFiles = fuzzyFilter(cache.files, query, (f) => f);
    }
    if (extraFiles.length === 0) return items;

    // Order: CWD first, then additionalDirectories, then other roots.
    const cwd = options?.cwd;
    const addlDirs = config.additionalDirectories;
    if (cwd) {
        extraFiles = extraFiles.toSorted((a, b) => {
            return tierOf(a, cwd, addlDirs) - tierOf(b, cwd, addlDirs);
        });
    }

    // Dedup by full path (skip files already in built-in items).
    const existingPaths = new Set(items.map((i) => i.description));
    const seen = new Set<string>();
    const result = [...items];

    for (const file of extraFiles) {
        if (seen.has(file)) continue;
        seen.add(file);

        // For files under CWD, show relative paths so they dedup
        // against base provider items (which use relative paths)
        // and produce @relative/path instead of @/absolute/path.
        const displayPath =
            cwd && file.startsWith(cwd + "/")
                ? relative(cwd, file)
                : file;

        // Skip if this relative path already exists in base items
        if (existingPaths.has(displayPath)) continue;

        const basename = file.split("/").pop() ?? "";
        result.push({
            value: `@${displayPath}`,
            label: basename,
            description: displayPath,
        });

        if (result.length - items.length >= 20) break;
    }

    return result;
}

/**
 * Sort tier: 0 = under CWD, 1 = under additionalDirectories, 2 = other.
 */
function tierOf(
    path: string,
    cwd: string,
    additionalDirectories: readonly string[],
): number {
    if (path.startsWith(cwd)) return 0;
    for (const d of additionalDirectories) {
        if (path.startsWith(d)) return 1;
    }
    return 2;
}

/**
 * Real-time fd file search for absolute paths outside indexed roots.
 * Used as fallback when autocomplete cache has no matches for @/absolute/path.
 *
 * Expands ~/ prefixes, extracts directory + basename, runs fd on the directory,
 * then fuzzy-filters results by basename.
 */
export async function realtimeFdSearch(
    absolutePath: string,
    signal: AbortSignal,
    config: FileResolverConfig,
    maxResults = 50,
    _walker?: (
        baseDir: string,
        maxResults: number,
        signal: AbortSignal,
        config: FileResolverConfig,
    ) => Promise<string[]>,
): Promise<Array<{ value: string; label: string; description?: string }>> {
    const walker = _walker ?? walkDirFd;
    // Expand ~/ if needed
    let searchPath = absolutePath;
    if (searchPath.startsWith("~")) {
        searchPath = join(
            HOME,
            searchPath.slice(searchPath[1] === "/" ? 2 : 1),
        );
    }

    const dir = searchPath.endsWith("/") ? searchPath : dirname(searchPath);
    const query = searchPath.endsWith("/") ? "" : basename(searchPath);

    let files: string[];
    try {
        files = await walker(dir, 500, signal, config);
        if (signal.aborted) return [];
    } catch {
        return [];
    }

    if (files.length === 0) return [];

    // Fuzzy filter by basename when query is present
    let matched = files;
    if (query && query !== "." && query !== "/") {
        matched = fuzzyFilter(files, query, (f) => f.split("/").pop() ?? "");
    }

    return matched.slice(0, maxResults).map((f) => ({
        value: `@${f}`,
        label: f.split("/").pop() ?? f,
        description: f,
    }));
}

/**
 * Real-time fd search for bare @name queries (no slashes).
 * Runs fd with the config flags (including --no-ignore-vcs when
 * respectGitignore is false) and passes the bare name as search
 * pattern so fd-level filtering finds gitignored files.
 */
export async function realtimeBareNameSearch(
    query: string,
    cwd: string,
    signal: AbortSignal,
    config: FileResolverConfig,
): Promise<Array<{ value: string; label: string; description?: string }>> {
    if (!query || signal.aborted) return [];

    const args = [...buildFdArgs(cwd, 50, config), query];

    return new Promise((resolve) => {
        const child = spawn(FD_PATH, args, {
            stdio: ["ignore", "pipe", "pipe"],
            signal,
        });

        let stdout = "";
        child.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });

        child.on("error", () => resolve([]));
        child.on("close", (code) => {
            if (signal.aborted || code !== 0 || !stdout) {
                resolve([]);
                return;
            }

            const lines = stdout.trim().split("\n").filter(Boolean);
            const matches = fuzzyFilter(
                lines,
                query,
                (line) => line.split("/").pop() ?? "",
            );

            resolve(
                matches.slice(0, 20).map((f) => ({
                    value: `@${join(cwd, f)}`,
                    label: f.split("/").pop() ?? f,
                    description: join(cwd, f),
                })),
            );
        });
    });
}

// ---------------------------------------------------------------------------
// Search roots
// ---------------------------------------------------------------------------

const HOME = homedir();
const AGENT_DIR = join(HOME, ".pi", "agent");
const FD_PATH = join(AGENT_DIR, "bin", "fd");
const EXTENSIONS_DIR = join(AGENT_DIR, "extensions");
const PI_PROMPTS_DIR = join(HOME, ".pi", "pi-prompts");
const PI_DOCS_DIR = join(HOME, ".pi", "docs");

/**
 * Get the list of search roots for background indexing.
 * Roots are deduplicated. Optionally includes user-configured additional directories.
 */
export function getSearchRoots(
    cwd: string,
    additionalDirectories?: string[],
): string[] {
    const roots: string[] = [
        cwd,
        AGENT_DIR,
        EXTENSIONS_DIR,
        PI_PROMPTS_DIR,
        PI_DOCS_DIR,
        ...(additionalDirectories ?? []).map((d) => expandHomePath(d)),
    ];
    const seen = new Set<string>();
    return roots.filter((r) => {
        const key = r.replace(/\/+$/, "");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// ---------------------------------------------------------------------------
// Background file index
// ---------------------------------------------------------------------------

interface FileCache {
    files: string[];
    ready: boolean;
    running: boolean;
}

function buildFdArgs(
    baseDir: string,
    maxResults: number,
    config: FileResolverConfig,
): string[] {
    const args: string[] = [
        "--base-directory",
        baseDir,
        "--max-results",
        String(maxResults),
    ];

    // --type flags
    for (const t of config.fd.types) {
        args.push("--type", t);
    }

    if (config.fd.followSymlinks) args.push("--follow");
    if (config.fd.includeHidden) args.push("--hidden");
    if (!config.fd.respectGitignore) args.push("--no-ignore-vcs");

    // --exclude patterns (each generates 3 levels: dir, dir/*, dir/**)
    for (const pattern of config.fd.excludePatterns) {
        if (!pattern) continue;
        args.push("--exclude", pattern);
        args.push("--exclude", `${pattern}/*`);
        args.push("--exclude", `${pattern}/**`);
    }

    return args;
}

async function walkDirFd(
    baseDir: string,
    maxResults: number,
    signal: AbortSignal,
    config: FileResolverConfig,
): Promise<string[]> {
    return new Promise<string[]>((resolve) => {
        const args = buildFdArgs(baseDir, maxResults, config);

        const child = spawn(FD_PATH, args, {
            stdio: ["ignore", "pipe", "pipe"],
            signal,
        });

        let stdout = "";
        const finish = (results: string[]) => {
            resolve(results);
        };

        child.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });

        child.on("error", () => finish([]));
        child.on("close", (code) => {
            if (signal.aborted || code !== 0 || !stdout) {
                finish([]);
                return;
            }
            const lines = stdout.trim().split("\n").filter(Boolean);
            const results: string[] = [];
            for (const line of lines) {
                const normalized = line.replace(/\/$/, "");
                if (
                    normalized === ".git" ||
                    normalized.startsWith(".git/") ||
                    normalized.includes("/.git/")
                ) {
                    continue;
                }
                results.push(join(baseDir, normalized));
            }
            finish(results);
        });
    });
}

function buildIndexBackground(
    cache: FileCache,
    roots: string[],
    config: FileResolverConfig,
): void {
    if (cache.running || cache.ready) return;
    cache.running = true;
    (async () => {
        const allFiles: string[] = [];
        const controller = new AbortController();
        indexAbortController = controller;
        // Index both files and directories so directory names are searchable
        const indexConfig = {
            ...config,
            fd: { ...config.fd, types: ["f", "d"] as Array<"f" | "d"> },
        };
        // Index root dirs first so they appear before their children
        // (e.g. @pi-integrations → /home/.../pi-integrations, @.pi → cwd)
        allFiles.push(...roots);
        for (const root of roots) {
            try {
                const entries = await walkDirFd(
                    root,
                    10000,
                    controller.signal,
                    indexConfig,
                );
                allFiles.push(...entries);

                // Early ready: unlock autocomplete as soon as the first root
                // returns files (~26ms for CWD), so enrichAutocompleteWithCache
                // and before_agent_start resolution work immediately.
                // Remaining roots continue in background and update cache.files
                // after completion.
                if (!cache.ready && entries.length > 0) {
                    cache.files = [
                        ...new Set(
                            allFiles.map((p) => {
                                try {
                                    return realpathSync(p);
                                } catch {
                                    return p;
                                }
                            }),
                        ),
                    ];
                    cache.ready = true;
                }
            } catch {}
        }
        // Final update with all roots — same dedup logic, safe no-op if
        // early ready already set (cache.files reference is replaced with
        // the fuller set; JS is single-threaded so reads see consistent state).
        cache.files = [
            ...new Set(
                allFiles.map((p) => {
                    try {
                        return realpathSync(p);
                    } catch {
                        return p;
                    }
                }),
            ),
        ];
        if (!cache.ready) {
            cache.ready = true;
        }
        cache.running = false;
    })().catch(() => {
        cache.running = false;
    });
}

// ---------------------------------------------------------------------------
// Module-level state (session-scoped, replaced on each session_start)
// ---------------------------------------------------------------------------

/** Guard against duplicate autocomplete provider registration. */
let autocompleteRegistered = false;

/** Current CWD, refreshed each session_start. Used by autocomplete wrapper. */
let sessionCwd = "";

/** Per-session file cache. Replaced on session_start, cleared on session_shutdown. */
let currentCache: FileCache = { files: [], ready: false, running: false };
let currentRoots: string[] = [];

/** AbortController for in-flight fd indexing. Aborted on session_shutdown. */
let indexAbortController: AbortController | null = null;

/** AbortController for in-flight real-time fd search. Cancelled on each new keystroke. */
let realtimeFdController: AbortController | null = null;

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
    // --- Part A: Autocomplete wrapper (registered ONCE) -----------------------

    pi.on("session_start", (_event, ctx) => {
        // Refresh CWD every session so /new ~/other-project/ uses right CWD
        sessionCwd = ctx.cwd;
        setFileResolverConfig(loadFileResolverConfig(ctx.cwd));

        if (!autocompleteRegistered) {
            ctx.ui.addAutocompleteProvider((current) => ({
                ...current,
                triggerCharacters: current.triggerCharacters,
                async getSuggestions(lines, cursorLine, cursorCol, options) {
                    const result = await current.getSuggestions(
                        lines,
                        cursorLine,
                        cursorCol,
                        options,
                    );

                    // Extract @ prefix from text, even if pi-tui returned null
                    const currentLine = lines[cursorLine] ?? "";
                    const textBeforeCursor = currentLine.slice(0, cursorCol);
                    const atMatch = textBeforeCursor.match(/@(\S*)$/);
                    const prefix =
                        result?.prefix ?? (atMatch ? atMatch[0] : undefined);

                    if (!prefix || !prefix.startsWith("@")) return result;

                    const parsed = parseAtValue(prefix);
                    const isExternalPath =
                        parsed.path.startsWith("/") ||
                        parsed.path.startsWith("~/");

                    // Inject cache-only files when git-ignore is disabled
                    // Force external bypass for absolute/~/ paths outside CWD
                    const enrichedItems = enrichAutocompleteWithCache(
                        prefix,
                        result?.items ?? [],
                        currentCache,
                        getFileResolverConfig(),
                        { forceExternal: isExternalPath, cwd: sessionCwd },
                    );

                    if (enrichedItems.length === 0) {
                        const config = getFileResolverConfig();
                        if (!config.enableRealtimeFallback) return null;

                        if (realtimeFdController) {
                            realtimeFdController.abort();
                        }
                        realtimeFdController = new AbortController();

                        if (isExternalPath) {
                            // @/absolute/path or @~/path: realtime on the
                            // specific parent directory, then fuzzy-filter.
                            const realtimeItems = await realtimeFdSearch(
                                parsed.path,
                                realtimeFdController.signal,
                                config,
                            );
                            if (realtimeItems.length > 0) {
                                return {
                                    prefix,
                                    items: realtimeItems.map((item) => ({
                                        ...item,
                                        value: transformAtValue(
                                            item.value,
                                            sessionCwd,
                                        ),
                                    })),
                                };
                            }
                        } else if (parsed.path && !parsed.path.includes("/")) {
                            // @barename: fd with --no-ignore-vcs + query.
                            // Catches gitignored files when cache is still
                            // building.
                            const realtimeItems = await realtimeBareNameSearch(
                                parsed.path,
                                sessionCwd,
                                realtimeFdController.signal,
                                config,
                            );
                            if (realtimeItems.length > 0) {
                                return {
                                    prefix,
                                    items: realtimeItems.map((item) => ({
                                        ...item,
                                        value: transformAtValue(
                                            item.value,
                                            sessionCwd,
                                        ),
                                    })),
                                };
                            }
                        }
                        return null;
                    }

                    return {
                        prefix,
                        items: enrichedItems.map((item) => ({
                            ...item,
                            value: transformAtValue(item.value, sessionCwd),
                        })),
                    };
                },
                applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
                    const transformedItem = prefix.startsWith("@")
                        ? {
                              ...item,
                              value: transformAtValue(item.value, sessionCwd),
                          }
                        : item;
                    return current.applyCompletion(
                        lines,
                        cursorLine,
                        cursorCol,
                        transformedItem,
                        prefix,
                    );
                },
            }));

            autocompleteRegistered = true;
        }

        // Abort any previous indexing still running
        if (indexAbortController) {
            indexAbortController.abort();
            indexAbortController = null;
        }

        // --- Part B: Preprocessor state (per-session) ---------------------------

        currentCache = { files: [], ready: false, running: false };
        currentRoots = getSearchRoots(
            ctx.cwd,
            getFileResolverConfig().additionalDirectories,
        );
        buildIndexBackground(
            currentCache,
            currentRoots,
            getFileResolverConfig(),
        );
    });

    // Clear cache on session end
    pi.on("session_shutdown", async () => {
        if (indexAbortController) {
            indexAbortController.abort();
            indexAbortController = null;
        }
        if (realtimeFdController) {
            realtimeFdController.abort();
            realtimeFdController = null;
        }
        currentCache = { files: [], ready: false, running: false };
        currentRoots = [];
    });

    // --- Part B: Preprocessor (top-level, fires once per turn) ---------------

    pi.on("before_agent_start", async (event) => {
        // Ensure background indexing has started
        buildIndexBackground(
            currentCache,
            currentRoots,
            getFileResolverConfig(),
        );

        const refs = findUnresolvedAtRefs(event.prompt);
        if (refs.length === 0) return;

        // Skip if cache still building M-bM-^@M-^T next turn will have it
        if (!currentCache.ready) return;

        const resolutions: string[] = [];
        let anyResolved = false;

        for (const ref of refs) {
            // Try exact sequential fuzzy match first (current behaviour)
            let matches = fuzzyFilter(currentCache.files, ref.name, (p) => {
                const base = p.split("/").pop() ?? "";
                return base;
            });

            // Fallback: typo-tolerant Levenshtein match on basename
            if (matches.length === 0) {
                matches = fuzzyMatchBasename(currentCache.files, ref.name);
            }

            if (matches.length > 0) {
                anyResolved = true;
                resolutions.push(`${ref.raw} → ${matches[0]}`);
            }
        }

        if (!anyResolved) return;

        return {
            message: {
                customType: "file-resolver",
                content: `Resolved: ${resolutions.join("; ")}`,
                display: false,
            },
        };
    });
}
