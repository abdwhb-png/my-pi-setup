import { readdir as fsReaddir, readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import nodePath from "node:path";
import { Container, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { appendCompressionFooter } from "../_shared/compression-render";
import { getActivePolicy } from "../_shared/audit-mode/audit-state";
import piFileResolver from "./pi-file-resolver";
import { handleReadOnDirectory, handleLsOnFile } from "./path-redirect";

// ─── Audit-aware ls operations ───────────────────────────────────────────────

/**
 * Audit-aware readdir: filters dotfiles unless the active audit policy enables
 * listing.showHidden. Reads live policy at call time so profile changes take
 * effect immediately without re-registering the tool.
 */
export const auditAwareLsOperations = {
  exists: async (absolutePath: string): Promise<boolean> => {
    try {
      await fsStat(absolutePath);
      return true;
    } catch {
      return false;
    }
  },
  stat: fsStat,
  readdir: async (absolutePath: string): Promise<string[]> => {
    const entries = await fsReaddir(absolutePath);
    if (getActivePolicy()["listing.showHidden"]) {
      return entries;
    }
    // Standard mode: hide dotfiles
    return entries.filter((e) => !e.startsWith("."));
  },
};

// ─── Audit-aware find operations ─────────────────────────────────────────────

/**
 * Path to the fd binary bundled by pi-coding-agent (resolved lazily).
 * Pi downloads fd to agent/bin/fd when the built-in find tool is first used.
 * We reuse the same binary so behaviour is aligned with the default find tool.
 *
 * NOTE (FD_BIN brittleness): This path is derived from import.meta.url at
 * module load time. If pi changes where it places the fd binary (e.g. via
 * an upgrade or a different platform layout), this will silently break find.
 * Tests that call glob() directly will catch the breakage early.
 */
const FD_BIN = nodePath.join(
  nodePath.dirname(new URL(import.meta.url).pathname),
  "../../bin/fd",
);

/**
 * Audit-aware glob: delegates to fd, adding --no-ignore when the active audit
 * policy has find.ignoreGitignore=true. Reads live policy at call time.
 *
 * NOTE: The factory API exposes `operations.glob` as the only hook point for
 * overriding find behaviour. When a custom glob is provided the factory uses it
 * exclusively; fd is not spawned at all. Consequently this implementation
 * reimplements the fd invocation in full so that it can inject --no-ignore.
 */
export const auditAwareFindOperations = {
  exists: async (absolutePath: string): Promise<boolean> => {
    try {
      await fsStat(absolutePath);
      return true;
    } catch {
      return false;
    }
  },
  glob: async (
    pattern: string,
    cwd: string,
    options: { ignore: string[]; limit: number },
  ): Promise<string[]> => {
    const ignoreGitignore = getActivePolicy()["find.ignoreGitignore"];

    const args: string[] = [
      "--glob",
      "--color=never",
      "--hidden",
      "--no-require-git",
      "--max-results",
      String(options.limit),
    ];

    if (ignoreGitignore) {
      // Bypass .gitignore so audit sees everything on disk.
      args.push("--no-ignore");
    }

    // Mirror the factory's --full-path logic for path-containing patterns.
    let effectivePattern = pattern;
    if (pattern.includes("/")) {
      args.push("--full-path");
      if (!pattern.startsWith("**")) {
        effectivePattern = `**/${pattern}`;
      }
    }

    args.push(effectivePattern, cwd);

    return new Promise<string[]>((resolve, reject) => {
      const child = spawn(FD_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
      if (!child.stdout || !child.stderr) {
        reject(new Error("Failed to open stdio for fd"));
        return;
      }
      const stdout = child.stdout;
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const rl = createInterface({ input: stdout as NodeJS.ReadableStream });
      const results: string[] = [];
      let stderr = "";

      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += typeof chunk === "string" ? chunk : chunk.toString();
      });

      rl.on("line", (line: string) => {
        if (line.trim()) results.push(line.trim());
      });

      child.on("error", (err: Error) => reject(new Error(`Failed to run fd: ${err.message}`)));

      child.on("close", (code: number | null) => {
        rl.close();
        if (code !== 0 && results.length === 0) {
          reject(new Error(stderr.trim() || `fd exited with code ${code}`));
          return;
        }
        resolve(results);
      });
    });
  },
};

// ─── Compression render helper ────────────────────────────────────────────────

function renderTextResultWithCompression(
  component: Text,
  details: object | undefined,
  theme: Theme,
  isPartial: boolean,
): Component {
  if (!isPartial) {
    const container = new Container();
    container.addChild(component);
    appendCompressionFooter(container, details, theme);
    if (container.children.length > 1) return container;
  }
  return component;
}

/**
 * Factory that builds the repeated renderResult wrapper used by all four tools.
 * Each tool gets its own per-call-id Text map; this factory closes over it.
 *
 * Casts through the tool def's own renderResult type via `Parameters<>` so the
 * returned closure picks up the precise signature from the factory, which lets
 * `registerTool(...)` accept it without manual casts.
 *
 * --- Lint rationale (intentional, do not "fix") ---
 * - `any` / `unknown` / `as never`:  pi's `ToolDefinition.renderResult` is
 *   generic over TDetails which defaults to `unknown`.  Neither `any` nor
 *   `unknown` can be eliminated here without losing the generic bridge or
 *   importing a non-exported pi type (`ToolRenderContext`).  The `as never`
 *   casts are the stable escape hatch — any "fix" breaks typecheck.
 * See `agent/AGENTS.md` → "Lint warnings from package boundary code".
 */
// oxlint-disable-next-line typescript/no-explicit-any, typescript/no-unsafe-type-assertion
function makeRenderResult<F extends (...args: any[]) => Component>(
  textByCallId: Map<string, Text>,
  toolDef: { renderResult?: F },
): F {
  const wrap = (
    result: { details?: object },
    options: { isPartial: boolean },
    theme: Theme,
    context: { toolCallId: string },
  ) => {
    let text = textByCallId.get(context.toolCallId);
    if (!text) {
      text = new Text("", 0, 0);
      textByCallId.set(context.toolCallId, text);
    }
    const baseContext = { ...context, lastComponent: text };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    toolDef.renderResult!(result as never, options as never, theme, baseContext as never);
    return renderTextResultWithCompression(text, result.details, theme, options.isPartial);
  };
  // oxlint-disable-next-line typescript/no-restricted-types, typescript/no-unsafe-type-assertion
  return wrap as unknown as F;
}

// ─── LLM-disambiguation docs ─────────────────────────────────────────────────
//
// Lighter LLMs repeatedly confuse JSON-Schema field `description` (which
// annotates each `pattern`/`path` prop on pi's tool schemas) for an actual
// argument. They emit { "description": "pattern: php" } instead of
// { "pattern": "php" } and loop forever on validation errors.
//
// Pi's contract: do NOT silently repair args. Steer the LLM via the three
// official doc channels that ship with every ToolDefinition:
//   - `description`     → tool's own doc, sent in the tool spec
//   - `promptSnippet`   → "Available tools" line in the system prompt
//   - `promptGuidelines`→ appended to the Guidelines section every turn
// Repeating the disambiguation across all three channels is deliberate —
// light models need the same rule in multiple places before it sticks.

const GREP_DISAMBIGUATION = {
  description:
    "Search file contents (ripgrep). Arguments: " +
    "{ pattern: string, path?: string, glob?: string, ignoreCase?: boolean, " +
    "literal?: boolean, context?: number, limit?: number }. " +
    "REQUIRED: pass the regex/text to search for in the `pattern` argument. " +
    "Do NOT use `description` as an argument — it is JSON-Schema metadata that " +
    "annotates the `pattern` field, not itself a parameter. " +
    "Correct call shape = { \"pattern\": \"foo\", \"path\": \"./src\" }.",
  promptSnippet:
    "Search file contents for the regex/text in `pattern` (NOT `description`). Respects .gitignore.",
  promptGuidelines: [
    "grep: pass the search text in the `pattern` argument. `description` is schema metadata, not a parameter.",
    "grep: correct shape = { \"pattern\": \"foo\", \"path\": \"./src\" }. Do not emit { \"description\": ... }.",
  ],
};

const FIND_DISAMBIGUATION = {
  description:
    "Find files by glob pattern (fd). Arguments: " +
    "{ pattern: string, path?: string, limit?: number }. " +
    "REQUIRED: pass the glob expression in the `pattern` argument. " +
    "Do NOT use `description` as an argument — it is JSON-Schema metadata that " +
    "annotates the `pattern` field. " +
    "Correct call shape = { \"pattern\": \"**/*.ts\", \"path\": \"./src\" }.",
  promptSnippet:
    "Find files matching a glob in `pattern` (NOT `description`). Respects .gitignore.",
  promptGuidelines: [
    "find: pass the glob expression in the `pattern` argument. `description` is schema metadata, not a parameter.",
    "find: correct shape = { \"pattern\": \"**/*.ts\", \"path\": \"./src\" }. Do not emit { \"description\": ... }.",
  ],
};

const LS_DISAMBIGUATION = {
  promptGuidelines: [
    "ls: pass the directory to list in the `path` argument (optional). No other arguments expected.",
  ],
};

const READ_DISAMBIGUATION = {
  promptGuidelines: [
    "read: pass the file to read in the `path` argument (required). Optional: `offset`, `limit` (1-indexed line numbers).",
  ],
};

// ─── Extension entry point ────────────────────────────────────────────────────

export default function piOverrides(pi: ExtensionAPI): void {
  // --- Register piFileResolver
  piFileResolver(pi);

  pi.on("session_start", async (_event, ctx) => {
    const readDef = createReadToolDefinition(ctx.cwd);
    // grep: factory only exposes isDirectory/readFile helpers — no hook to
    // inject --no-ignore into rg. Use default factory; grep.ignoreGitignore
    // enforcement is blocked by the factory API (see BLOCKERS below).
    const grepDef = createGrepToolDefinition(ctx.cwd);
    // ls: audit-aware operations filter dotfiles per active policy at call time.
    const lsDef = createLsToolDefinition(ctx.cwd, { operations: auditAwareLsOperations });
    // find: audit-aware operations inject --no-ignore per active policy at call time.
    const findDef = createFindToolDefinition(ctx.cwd, { operations: auditAwareFindOperations });

    // --- wrap read.execute: redirect directories to ls-like output ---
    const cwd = ctx.cwd;
    // oxlint-disable-next-line typescript/unbound-method -- plain fn, no this
    const originalReadExecute = readDef.execute;
    readDef.execute = async (toolCallId, params, signal, onUpdate, extCtx) => {
      const absPath = nodePath.resolve(cwd, params.path);
      try {
        const s = await fsStat(absPath);
        if (s.isDirectory()) {
          // oxlint-ignore-next-line typescript/unbound-method -- arrow fn, this is lexically bound
          return handleReadOnDirectory(absPath, auditAwareLsOperations.readdir);
        }
      } catch {
        // path doesn't exist or no perms — let original handle
      }
      return originalReadExecute(toolCallId, params, signal, onUpdate, extCtx);
    };

    // --- wrap ls.execute: redirect files to stat+preview ---
    // oxlint-disable-next-line typescript/unbound-method -- plain fn, no this
    const originalLsExecute = lsDef.execute;
    lsDef.execute = async (toolCallId, params, signal, onUpdate, extCtx) => {
      const absPath = nodePath.resolve(cwd, params.path ?? cwd);
      try {
        const s = await fsStat(absPath);
        if (!s.isDirectory()) {
          // oxlint-ignore-next-line typescript/unbound-method -- standalone functions, no this
          return handleLsOnFile(absPath, fsReadFile, fsStat);
        }
      } catch {
        // path doesn't exist or no perms — let original handle
      }
      return originalLsExecute(toolCallId, params, signal, onUpdate, extCtx);
    };

    const readTextByCallId = new Map<string, Text>();
    const grepTextByCallId = new Map<string, Text>();
    const lsTextByCallId = new Map<string, Text>();
    const findTextByCallId = new Map<string, Text>();

    pi.registerTool({
      ...readDef,
      promptGuidelines: READ_DISAMBIGUATION.promptGuidelines,
      renderResult: makeRenderResult(readTextByCallId, readDef),
    });
    pi.registerTool({
      ...grepDef,
      ...GREP_DISAMBIGUATION,
      renderResult: makeRenderResult(grepTextByCallId, grepDef),
    });
    pi.registerTool({
      ...lsDef,
      ...LS_DISAMBIGUATION,
      renderResult: makeRenderResult(lsTextByCallId, lsDef),
    });
    pi.registerTool({
      ...findDef,
      ...FIND_DISAMBIGUATION,
      renderResult: makeRenderResult(findTextByCallId, findDef),
    });

    // Augment default active toolset with native grep/find/ls.
    // Pi core defaults to ["read", "bash", "edit", "write"] — add the
    // read-only built-ins so the LLM can use them directly instead of
    // shelling out via bash. This augments rather than replaces so it
    // composes safely with pi-roles inherit semantics.
    const current = pi.getActiveTools();
    const added = ["grep", "find", "ls"].filter(t => !current.includes(t));
    const newTools = [...new Set([...current, ...added])];
    pi.setActiveTools(newTools);
    if (ctx.hasUI && added.length > 0) {
      ctx.ui.notify(`🛠️ Updated active tools: ${newTools.join(", ")}`, "info");
    }
  });
}

// ─── BLOCKERS ─────────────────────────────────────────────────────────────────
//
// grep.ignoreGitignore — NOT IMPLEMENTED
//
//   Evidence: dist/core/tools/grep.d.ts — GrepToolOptions only exposes:
//     operations?: { isDirectory(path): bool; readFile(path): string }
//   These are post-hoc file-read helpers for context lines. The rg invocation
//   (which includes/excludes --no-ignore) is baked into execute() with no hook.
//   File: node_modules/@earendil-works/pi-coding-agent/dist/core/tools/grep.js
//   Line 136: const args = ["--json", "--line-number", "--color=never", "--hidden"];
//   There is no callback or options flag to inject --no-ignore.
//
//   To implement grep.ignoreGitignore, the upstream factory would need either:
//   - A GrepToolOptions.ignoreGitignore boolean, or
//   - An operations.search(pattern, path, opts) hook that replaces rg spawning.
//   Until then, grep respects .gitignore in all audit profiles.
