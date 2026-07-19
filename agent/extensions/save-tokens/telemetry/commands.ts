/**
 * Pi slash-command registration for save-tokens telemetry.
 *
 * Registers three commands consumed by the Pi runtime:
 *   /save-tokens-experiment <tag> [value]   — set experiment tag
 *   /save-tokens-stats [filters]            — scan, filter, aggregate, display summary
 *   /save-tokens-export [filters]           — write JSON/CSV export file
 *
 * All commands catch errors internally and notify via ctx.ui.notify(..., 'error')
 * so they never crash the agent loop.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { mkdir, open, chmod, rm } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { loadTelemetryConfig } from "../config";
import {
    scanTelemetryArchive,
    filterAndAnnotate,
    aggregateGroups,
    exportJson,
    exportCsv,
    type FilterOptions,
    type AnalyticsResult,
} from "./analytics";
import type { TelemetryController } from "./controller";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Conservative ASCII allowlist for experiment tags: letters, digits, dot, dash, underscore. */
export const TAG_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Maximum length for experiment tags. */
export const MAX_TAG_LENGTH = 128;

/** Valid keys for parseArgs. Any key not in this set is rejected. */
const VALID_KEYS = new Set([
    "from",
    "to",
    "tag",
    "provider",
    "model",
    "project",
    "thinking",
    "caveman",
    "ponytail",
    "format",
    "out",
]);

/** Allowed format values. */
const VALID_FORMATS = new Set(["json", "csv"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedArgs {
    from?: string;
    to?: string;
    tag?: string;
    provider?: string;
    model?: string;
    project?: string;
    thinking?: string;
    caveman?: string;
    ponytail?: string;
    format?: string;
    out?: string;
}

export interface ParseResultOk {
    ok: true;
    parsed: ParsedArgs;
    error?: undefined;
}

export interface ParseResultErr {
    ok: false;
    error: string;
    parsed?: undefined;
}

export type ParseResult = ParseResultOk | ParseResultErr;

// ---------------------------------------------------------------------------
// parseArgs — key=value parser
// ---------------------------------------------------------------------------

/**
 * Parse a string of `key=value` pairs into a structured object.
 *
 * Rules:
 * - Keys are trimmed; unknown keys rejected with an error message.
 * - Duplicate keys rejected.
 * - Empty values (key= with nothing after =) rejected.
 * - Bare words (no =) rejected.
 * - Whitespace around key=value pairs is trimmed.
 */
export function parseArgs(raw: string): ParseResult {
    const parsed: ParsedArgs = {};
    const seen = new Set<string>();

    // Normalize whitespace around "=": "key = value" → "key=value"
    // This preserves "=" characters within values (e.g. out=/path/file=name.csv)
    const normalized = raw.replace(/\s*=\s*/g, "=");

    const trimmed = normalized.trim();
    if (trimmed === "") {
        return { ok: true, parsed: {} };
    }

    // Split into key=value tokens on remaining whitespace
    const tokens = trimmed.split(/\s+/).filter(Boolean);

    for (const token of tokens) {
        const eqIdx = token.indexOf("=");
        if (eqIdx === -1) {
            return { ok: false, error: `Missing "=" in argument: "${token}". Use key=value syntax.` };
        }

        const key = token.slice(0, eqIdx);
        const value = token.slice(eqIdx + 1);

        if (key === "") {
            return { ok: false, error: `Empty key before "=" in: "${token}"` };
        }

        if (value === "") {
            return { ok: false, error: `Empty value for key "${key}". Provide a value after "=".` };
        }

        if (!VALID_KEYS.has(key)) {
            return {
                ok: false,
                error: `Unknown key: "${key}". Valid keys: ${Array.from(VALID_KEYS).sort().join(", ")}`,
            };
        }

        if (seen.has(key)) {
            return { ok: false, error: `Duplicate key: "${key}". Each key may only appear once.` };
        }
        seen.add(key);

        (parsed as Record<string, string>)[key] = value;
    }

    return { ok: true, parsed };
}

// ---------------------------------------------------------------------------
// validateTag
// ---------------------------------------------------------------------------

/**
 * Validate a tag string against the conservative ASCII allowlist and length limit.
 *
 * Returns true if the tag is valid for use as an experiment tag.
 */
export function validateTag(tag: string): boolean {
    if (tag.length === 0) return false;
    if (tag.length > MAX_TAG_LENGTH) return false;
    return TAG_PATTERN.test(tag);
}

// ---------------------------------------------------------------------------
// buildFilterOptions — convert parsed args to analytics FilterOptions
// ---------------------------------------------------------------------------

function buildFilterOptions(parsed: ParsedArgs): FilterOptions {
    return {
        provider: parsed.provider,
        model: parsed.model,
        project: parsed.project,
        thinkingLevel: parsed.thinking,
        caveman: parsed.caveman,
        ponytail: parsed.ponytail,
        experimentTag: parsed.tag,
    };
}

// ---------------------------------------------------------------------------
// formatSummary — render aggregate rows as a compact text summary
// ---------------------------------------------------------------------------

function formatSummary(result: AnalyticsResult): string {
    const lines: string[] = [];
    lines.push("");  // blank line before table for readability
    lines.push("=== Save-Tokens Telemetry Summary ===");

    // Query info
    const filters: string[] = [];
    if (result.query.from) filters.push(`from=${result.query.from}`);
    if (result.query.to) filters.push(`to=${result.query.to}`);
    if (result.query.experimentTag) filters.push(`tag=${result.query.experimentTag}`);
    if (result.query.provider) filters.push(`provider=${result.query.provider}`);
    if (result.query.model) filters.push(`model=${result.query.model}`);
    if (result.query.project) filters.push(`project=${result.query.project}`);
    if (result.query.thinkingLevel) filters.push(`thinking=${result.query.thinkingLevel}`);
    if (result.query.caveman) filters.push(`caveman=${result.query.caveman}`);
    if (result.query.ponytail) filters.push(`ponytail=${result.query.ponytail}`);
    const filterStr = filters.length > 0 ? filters.join(" ") : "none";
    lines.push(`Filters: ${filterStr}`);

    // Diagnostics
    const d = result.diagnostics;
    lines.push(`Scanned: ${d.totalSessionsScanned} sessions, ${d.totalEventsScanned} events in ${d.totalFilesScanned} files`);

    // Group rows
    const headers = ["Group", "Sessions", "Runs", "Turns", "Tools", "Errors", "Tokens", "Cost", "Compression"];

    // Compute column widths
    const colWidths = headers.map((h) => h.length);
    const rows: string[][] = [];

    for (const row of result.rows) {
        const label = row.groupKey.replace(/^observed_/, "").replace(/_/g, " ");
        const cells = [
            label,
            String(row.sessionCount),
            String(row.runCount),
            String(row.turnCount),
            String(row.toolCallCount),
            String(row.toolErrorCount),
            row.totalTokens.toLocaleString(),
            `$${row.cost.toFixed(4)}`,
            `${row.observedCompression.savingsPct.toFixed(1)}%`,
        ];
        rows.push(cells);
        for (let i = 0; i < cells.length; i++) {
            colWidths[i] = Math.max(colWidths[i]!, cells[i]!.length);
        }
    }

    // Format header
    const padHeader = headers.map((h, i) => h.padEnd(colWidths[i]!)).join(" | ");
    lines.push("");
    lines.push(padHeader);
    lines.push(colWidths.map((w) => "-".repeat(w)).join("-+-"));

    // Format rows
    for (const row of rows) {
        const padded = row.map((c, i) => c.padEnd(colWidths[i]!)).join(" | ");
        lines.push(padded);
    }

    lines.push("");
    lines.push("Note: groups represent observed correlation, not causation.");
    lines.push("      Compression savings = global saved/original ratio.");

    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// resolveExportPath — resolve the output file path
// ---------------------------------------------------------------------------

function resolveExportPath(
    telemetryRoot: string,
    explicitPath: string | undefined,
    format: string,
    cwd: string,
    now?: Date,
): { path: string; isExplicit: boolean } {
    const ext = format === "csv" ? ".csv" : ".json";

    if (explicitPath) {
        // Expand ~ and ~/... to homedir; do not expand ~other
        let expanded = explicitPath;
        if (expanded === "~") {
            expanded = homedir();
        } else if (expanded.startsWith("~/")) {
            expanded = join(homedir(), expanded.slice(2));
        }
        // Resolve relative paths from ctx.cwd; absolute (including expanded ~) stay as-is
        const resolved = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
        return { path: resolved, isExplicit: true };
    }

    // Default: <telemetryRoot>/exports/YYYY-MM-DDTHHmmssZ.<ext>
    const clock = now ?? new Date();
    const stamp = clock.toISOString().replace(/[:.]/g, "-"); // safe for filenames
    const exportsDir = join(telemetryRoot, "exports");
    const filename = `telemetry-export-${stamp}${ext}`;
    return { path: join(exportsDir, filename), isExplicit: false };
}

// ---------------------------------------------------------------------------
// makeExportDirs — create export directory with 0700 (only newly created dirs)
// ---------------------------------------------------------------------------

async function makeExportDirs(exportPath: string): Promise<void> {
    const { dirname } = await import("node:path");
    const dir = dirname(exportPath);

    // Check if directory already exists BEFORE mkdir.
    // We only chmod directories that we actually create, never pre-existing
    // parent dirs (e.g., /tmp must not become 0700 when out=/tmp/foo.json).
    let existed = false;
    try {
        const { stat } = await import("node:fs/promises");
        const st = await stat(dir);
        existed = st.isDirectory();
    } catch {
        // stat failed — directory doesn't exist, will be created
    }

    await mkdir(dir, { recursive: true });

    // Only chmod the target directory if we just created it.
    // Pre-existing dirs keep their original permissions.
    if (!existed) {
        await chmod(dir, 0o700);
    }
}

// ---------------------------------------------------------------------------
// writeExportFile — write with 0600, exclusive create for explicit paths
// ---------------------------------------------------------------------------

async function writeExportFile(
    exportPath: string,
    content: string,
    isExplicit: boolean,
): Promise<string> {
    await makeExportDirs(exportPath);

    if (isExplicit) {
        return writeExplicitFile(exportPath, content);
    }

    // Default path: find a unique suffix if file exists
    let finalPath = exportPath;
    let suffix = 1;
    while (true) {
        try {
            return await writeOneFile(finalPath, content);
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
                // Build a new name with suffix
                const dotIdx = exportPath.lastIndexOf(".");
                if (dotIdx === -1) {
                    finalPath = `${exportPath}-${suffix}`;
                } else {
                    finalPath = `${exportPath.slice(0, dotIdx)}-${suffix}${exportPath.slice(dotIdx)}`;
                }
                suffix++;
                continue;
            }
            throw err;
        }
    }
}

async function writeExplicitFile(exportPath: string, content: string): Promise<string> {
    let fh: Awaited<ReturnType<typeof open>> | null = null;
    let created = false;
    try {
        fh = await open(exportPath, "wx", 0o600);
        created = true;
        await fh.writeFile(content, "utf-8");
        await fh.close();
        fh = null;
        await chmod(exportPath, 0o600);
        return exportPath;
    } catch (err: unknown) {
        if (fh) {
            try { await fh.close(); } catch { /* best-effort */ }
        }
        if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
            // EEXIST before handle creation: never touch the pre-existing file
            throw new Error(
                `Export file already exists: "${exportPath}". Remove it or use a different path.`,
            );
        }
        // Cleanup partial file only if THIS invocation created it (write/chmod failure)
        if (created) {
            try { await rm(exportPath, { force: true }); } catch { /* best-effort */ }
        }
        throw err;
    }
}

async function writeOneFile(exportPath: string, content: string): Promise<string> {
    let fh: Awaited<ReturnType<typeof open>> | null = null;
    let created = false;
    try {
        fh = await open(exportPath, "wx", 0o600);
        created = true;
        await fh.writeFile(content, "utf-8");
        await fh.close();
        fh = null;
        await chmod(exportPath, 0o600);
        return exportPath;
    } catch (err: unknown) {
        if (fh) {
            try { await fh.close(); } catch { /* best-effort */ }
        }
        // Only remove the file if THIS invocation created it (open succeeded).
        // On EEXIST before handle creation (created=false), never touch the pre-existing file.
        if (created) {
            try { await rm(exportPath, { force: true }); } catch { /* best-effort */ }
        }
        throw err;
    }
}

// ---------------------------------------------------------------------------
// Command handler factory — stats
// ---------------------------------------------------------------------------

function createStatsHandler(telemetry: TelemetryController) {
    return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        try {
            const parsed = parseArgs(args);
            if (!parsed.ok) {
                ctx.ui.notify(`save-tokens-stats: ${parsed.error}`, "error");
                return;
            }

            const config = loadTelemetryConfig();
            const root = config.directory;
            if (!root) {
                ctx.ui.notify("save-tokens-stats: telemetry directory not configured", "error");
                return;
            }

            const filterOptions = buildFilterOptions(parsed.parsed);

            // Scan
            const scanResult = await scanTelemetryArchive({
                root,
                from: parsed.parsed.from,
                to: parsed.parsed.to,
            });

            // Filter + annotate
            const { annotated } = filterAndAnnotate(scanResult.records, filterOptions);

            // Aggregate
            const { rows } = aggregateGroups(annotated);

            // Build result with query metadata
            const result: AnalyticsResult = {
                query: {
                    root,
                    from: parsed.parsed.from,
                    to: parsed.parsed.to,
                    ...filterOptions,
                },
                diagnostics: scanResult.diagnostics,
                rows,
            };

            const summary = formatSummary(result);
            ctx.ui.notify(summary, "info");
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            try { ctx.ui.notify(`save-tokens-stats error: ${message}`, "error"); } catch { /* double-fault — suppress */ }
        }
    };
}

// ---------------------------------------------------------------------------
// Command handler factory — export
// ---------------------------------------------------------------------------

function createExportHandler(telemetry: TelemetryController) {
    return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        try {
            const parsed = parseArgs(args);
            if (!parsed.ok) {
                ctx.ui.notify(`save-tokens-export: ${parsed.error}`, "error");
                return;
            }

            const p = parsed.parsed;
            const format = p.format ?? "json";

            if (!VALID_FORMATS.has(format)) {
                ctx.ui.notify(
                    `save-tokens-export: invalid format "${format}". Use "json" or "csv".`,
                    "error",
                );
                return;
            }

            const config = loadTelemetryConfig();
            const root = config.directory;
            if (!root) {
                ctx.ui.notify("save-tokens-export: telemetry directory not configured", "error");
                return;
            }

            const filterOptions = buildFilterOptions(p);

            // Scan
            const scanResult = await scanTelemetryArchive({
                root,
                from: p.from,
                to: p.to,
            });

            // Filter + annotate
            const { annotated } = filterAndAnnotate(scanResult.records, filterOptions);

            // Aggregate
            const { rows } = aggregateGroups(annotated);

            // Build result
            const result: AnalyticsResult = {
                query: {
                    root,
                    from: p.from,
                    to: p.to,
                    ...filterOptions,
                },
                diagnostics: scanResult.diagnostics,
                rows,
            };

            // Export
            const exportContent = format === "csv" ? exportCsv(result) : exportJson(result);
            const resolved = resolveExportPath(root, p.out, format, ctx.cwd);

            const writtenPath = await writeExportFile(
                resolved.path,
                exportContent,
                resolved.isExplicit,
            );

            ctx.ui.notify(
                `save-tokens-export: written ${format.toUpperCase()} to ${writtenPath}`,
                "info",
            );
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            try { ctx.ui.notify(`save-tokens-export error: ${message}`, "error"); } catch { /* double-fault — suppress */ }
        }
    };
}

// ---------------------------------------------------------------------------
// Command handler factory — experiment
// ---------------------------------------------------------------------------

function createExperimentHandler(telemetry: TelemetryController) {
    return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        try {
            const trimmed = args.trim();

            if (trimmed === "") {
                ctx.ui.notify("save-tokens-experiment: tag required. Usage: /save-tokens-experiment <tag> [value]", "error");
                return;
            }

            // Split on whitespace: first token is tag, rest (joined) is optional value
            const spaceIdx = trimmed.search(/\s/);
            const tagStr = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
            const valueStr = spaceIdx === -1 ? undefined : trimmed.slice(spaceIdx + 1).trim();

            if (!validateTag(tagStr)) {
                ctx.ui.notify(
                    `save-tokens-experiment: invalid tag "${tagStr}". Tags must be ASCII [A-Za-z0-9._-], max ${MAX_TAG_LENGTH} chars.`,
                    "error",
                );
                return;
            }

            // Parse optional value: try boolean, then number, then string
            let value: string | number | boolean | undefined;
            if (valueStr !== undefined && valueStr !== "") {
                if (valueStr === "true") value = true;
                else if (valueStr === "false") value = false;
                else {
                    const num = Number(valueStr);
                    value = Number.isFinite(num) && valueStr.trim() !== "" ? num : valueStr;
                }
            }

            const persisted = await telemetry.tag(tagStr, value);
            if (!persisted) {
                ctx.ui.notify(
                    "save-tokens-experiment: tag not persisted — telemetry may be disabled or no active session.",
                    "error",
                );
                return;
            }

            const displayValue = value !== undefined ? ` = ${JSON.stringify(value)}` : "";
            ctx.ui.notify(`save-tokens-experiment: tag set → "${tagStr}"${displayValue}`, "info");
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            try { ctx.ui.notify(`save-tokens-experiment error: ${message}`, "error"); } catch { /* double-fault — suppress */ }
        }
    };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register save-tokens telemetry slash commands on the Pi extension API.
 *
 * Registers three commands:
 * - `save-tokens-experiment` — set experiment tag for current session
 * - `save-tokens-stats`      — scan, filter, aggregate, display summary
 * - `save-tokens-export`     — write JSON/CSV export file
 */
export { resolveExportPath, writeExportFile };

export function registerTelemetryCommands(
    pi: ExtensionAPI,
    telemetry: TelemetryController,
): void {
    pi.registerCommand("save-tokens-experiment", {
        description: "Set experiment tag for current telemetry session",
        handler: createExperimentHandler(telemetry),
    });

    pi.registerCommand("save-tokens-stats", {
        description: "Show save-tokens telemetry summary (observation only)",
        handler: createStatsHandler(telemetry),
    });

    pi.registerCommand("save-tokens-export", {
        description: "Export save-tokens telemetry as JSON or CSV",
        handler: createExportHandler(telemetry),
    });
}
