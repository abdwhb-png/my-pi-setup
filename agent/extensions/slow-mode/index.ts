/**
 * Slow Mode Extension
 *
 * Overrides the built-in write and edit tools, letting the user review
 * proposed changes before they are applied.
 *
 * - Write: stages the new file in /tmp, shows content for review.
 * - Edit: stages old/new files in /tmp, shows inline diff for review.
 * - Diffs are rendered with delta (if available) for enhanced syntax highlighting.
 * - Ctrl+E opens the new file in $VISUAL/$EDITOR for editing (edit operations).
 * - Ctrl+O opens the diff in an external viewer (delta/vim/diff).
 * - After editing, the diff is regenerated and shown again for approval.
 * - Toggle with /slow-mode command (supports /slow-mode on|off|enable|disable).
 * - Status bar shows "slow ■" (warning color) when active.
 *
 * When content is edited:
 * - The actual write/edit operation uses the edited content
 * - A note is appended to the tool result indicating content was modified
 * - The collapsed snippet shows the original LLM proposal (not the edited version)
 *   This is intentional - it shows what the LLM wanted vs. what was actually applied
 *
 * In non-interactive mode (no UI) or RPC mode, slow mode is a no-op.
 */

import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, unlinkSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, basename, join, resolve, extname } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createWriteTool, createEditTool } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { createWidget } from "../_shared/fancy-footer.ts";
import { createUiColors } from "../_shared/ui-colors.ts";
import {
  resolvePath,
  generateUnifiedDiff,
  extractEditText,
  applyEdits,
  extractEditPatches,
} from "./slow-mode-core.ts";

export default function slowMode(pi: ExtensionAPI) {
  // Detect RPC mode — custom() returns undefined in RPC, so we must skip
  // interception entirely to avoid silently blocking all writes/edits.
  // See ANTI-PATTERNS §A2.
  const isRPC = process.argv.includes("--mode") && process.argv.includes("rpc");

  // State: whether slow mode is currently enabled
  let enabled = false;

  // Track tool calls where content was edited
  // Maps toolCallId -> { originalContent, editedContent }
  const editedCalls = new Map<string, { original: string; edited: string }>();

  // Staging directory: stores proposed file changes for review.
  // Lazily created on first use to avoid orphaned temp dirs on /reload
  // (which recreates the extension instance without firing session_shutdown).
  let _tmpDir: string | null = null;
  function tmpDir(): string {
    if (!_tmpDir) {
      // mkdtempSync for secure, unpredictable temp directory creation
      // to prevent symlink attacks and tmpdir races
      _tmpDir = mkdtempSync(join(tmpdir(), "pi-slow-mode-"));
    }
    return _tmpDir;
  }

  // Original built-in tool instances (re-created on session_start with correct cwd).
  // Used by the tool overrides to delegate actual file operations after review.
  let originalWrite = createWriteTool(process.cwd());
  let originalEdit = createEditTool(process.cwd());

  // Fancy-footer widget (falls back to setWidget if fancy-footer unavailable)
  // Uses ui-colors.ts for consistent theming across extensions.
  const w = createWidget(pi, {
    id: "slow-mode",
    label: "Slow Mode",
    description: "Shows whether slow mode is active.",
    row: 1,
    order: 8,
    align: "right",
    render: (ctx: any) => {
      if (!enabled) return null;
      const colors = createUiColors(ctx.theme);
      return colors.warning("slow ■");
    },
  });

  // Restore state on session start (survives /reload)
  // See ANTI-PATTERNS §A6 and PATTERNS §P15.
  pi.on("session_start", async (_event, ctx) => {
    // Re-create original tools with the session's cwd
    originalWrite = createWriteTool(ctx.cwd);
    originalEdit = createEditTool(ctx.cwd);

    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === "custom" && e.customType === "slow-mode") {
        enabled = (e.data as { enabled: boolean }).enabled;
        w.update(ctx, enabled ? "slow ■" : null);
        break;
      }
    }
  });

  // Clean up staging directory on session shutdown (only if it was created)
  pi.on("session_shutdown", async () => {
    if (_tmpDir) {
      try {
        rmSync(_tmpDir, { recursive: true });
      } catch {
        // Best-effort cleanup
      }
    }
  });

  ////----------------------------------------
  ///     Toggle command
  //------------------------------------------

  // Register /slow-mode command — toggle or explicitly set on/off.
  // Supports: /slow-mode, /slow-mode on, /slow-mode off, /slow-mode enable, /slow-mode disable
  pi.registerCommand("slow-mode", {
    description: "Toggle slow mode — review write/edit changes before applying",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const values = ["on", "enable", "off", "disable"];
      const items = values.map((v) => ({ value: v, label: v }));
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      // No-op in headless mode (no TUI available)
      if (!ctx.hasUI) {
        return;
      }

      // No-op in RPC mode — custom() returns undefined, blocking all tools
      if (isRPC) {
        ctx.ui.notify("Slow mode is unavailable in RPC mode", "warning");
        return;
      }

      // Parse explicit on/off argument (like sandbox extension)
      const arg = args.trim().toLowerCase();
      if (arg === "on" || arg === "enable") {
        enabled = true;
      } else if (arg === "off" || arg === "disable") {
        enabled = false;
      } else {
        // No argument or unrecognized — toggle current state
        enabled = !enabled;
      }

      w.update(ctx, enabled ? "slow ■" : null);

      // Persist state so it survives /reload
      pi.appendEntry("slow-mode", { enabled });

      if (enabled) {
        ctx.ui.notify("Slow mode enabled — write/edit changes require approval", "info");
      } else {
        ctx.ui.notify("Slow mode disabled", "info");
      }
    },
  });

  ////----------------------------------------
  ///     Tool overrides (C2 fix)
  //------------------------------------------

  // Override the built-in write tool — same name = override (PATTERNS §P4).
  // When slow mode is active, performs review before delegating to the
  // original tool. This replaces the previous tool_call interception +
  // input mutation approach (which relied on an undocumented contract).
  // Now content modification happens through the documented execute() interface.
  pi.registerTool({
    ...originalWrite,
    label: "write (slow mode)",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Pass through if slow mode is disabled, no UI, or RPC mode
      if (!enabled || isRPC || !ctx.hasUI) {
        return originalWrite.execute(toolCallId, params, signal, onUpdate);
      }

      const filePath = params.path;
      const content = params.content;
      if (!filePath || content == null) {
        return originalWrite.execute(toolCallId, params, signal, onUpdate);
      }

      // Perform the review — returns approved + potentially edited content
      const review = await reviewWrite(toolCallId, filePath, content, ctx);

      if (!review.approved) {
        // Rejection: throw to signal error (ANTI-PATTERNS §A3)
        throw new Error("User rejected the write in slow mode review.");
      }

      // If user edited the content, construct modified params (no input mutation)
      if (review.editedContent != null && review.editedContent !== content) {
        editedCalls.set(toolCallId, { original: content, edited: review.editedContent });
        ctx.ui.notify("Using edited content", "info");
        const modifiedParams = { ...params, content: review.editedContent };
        return originalWrite.execute(toolCallId, modifiedParams, signal, onUpdate);
      }

      // Approved without edits: delegate to original
      return originalWrite.execute(toolCallId, params, signal, onUpdate);
    },
  });

  // Override the built-in edit tool — same pattern as write above.
  pi.registerTool({
    ...originalEdit,
    label: "edit (slow mode)",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Pass through if slow mode is disabled, no UI, or RPC mode
      if (!enabled || isRPC || !ctx.hasUI) {
        return originalEdit.execute(toolCallId, params, signal, onUpdate);
      }

      const filePath = params.path;
      if (!filePath) {
        return originalEdit.execute(toolCallId, params, signal, onUpdate);
      }

      // Perform the review — returns approved + potentially edited content
      const review = await reviewEdit(toolCallId, params, ctx);

      if (!review.approved) {
        throw new Error("User rejected the edit in slow mode review.");
      }

      // If the user edited the content during review
      if (review.editedContent != null) {
        if (review.wroteDirectly) {
          // Multi-edit with real file: content was already written to disk.
          // Return a success result without delegating to the original tool.
          // `details: undefined` matches AgentToolResult with undefined details.
          editedCalls.set(toolCallId, { original: review.originalNewText!, edited: review.editedContent });
          return {
            content: [{ type: "text" as const, text: "Applied via slow mode review (content was edited externally)." }],
            details: undefined,
          };
        }
        // Single edit or fallback: delegate with modified newText
        if (review.editedContent !== review.originalNewText) {
          editedCalls.set(toolCallId, { original: review.originalNewText!, edited: review.editedContent });
          ctx.ui.notify("Using edited content", "info");
          // Construct modified params based on the edit format
          const modifiedParams = constructModifiedEditParams(params, review.editedContent);
          return originalEdit.execute(toolCallId, modifiedParams, signal, onUpdate);
        }
      }

      // Approved without edits: delegate to original
      return originalEdit.execute(toolCallId, params, signal, onUpdate);
    },
  });

  ////----------------------------------------
  ///     Tool result annotation
  //------------------------------------------

  // Hook into tool_result event — fires AFTER tool execution
  // Add a note when content was edited in slow mode
  pi.on("tool_result", async (event, ctx) => {
    if (!enabled || !ctx.hasUI) return;

    const edited = editedCalls.get(event.toolCallId);
    if (!edited) return;

    // Clean up the tracking entry
    editedCalls.delete(event.toolCallId);

    // Calculate diff stats
    const originalLines = edited.original.split('\n').length;
    const editedLines = edited.edited.split('\n').length;
    const lineDiff = editedLines - originalLines;
    const lineDiffText = lineDiff > 0 
      ? `+${lineDiff} lines` 
      : lineDiff < 0 
      ? `${lineDiff} lines` 
      : 'same line count';

    // Add a note to the result indicating content was edited
    const note = {
      type: "text" as const,
      text: `\n\n**Note:** Content was modified in slow mode review before writing (${lineDiffText}).`,
    };

    return {
      content: [...(event.content || []), note],
    };
  });

  ////----------------------------------------
  ///     Write & edit review
  //------------------------------------------

  /**
   * Result of a write review.
   */
  interface WriteReviewResult {
    approved: boolean;
    /** The content after user editing (null if user didn't edit or rejected) */
    editedContent: string | null;
  }

  /**
   * Review a write tool call — stages content, shows review UI, returns result.
   *
   * No longer mutates the input or returns block objects. The caller (tool
   * override) uses the returned content to construct modified params and
   * delegate to the original tool.
   */
  async function reviewWrite(
    toolCallId: string,
    filePath: string,
    content: string,
    ctx: ExtensionContext,
  ): Promise<WriteReviewResult> {
    // Resolve to relative path for staging
    const relPath = resolvePath(ctx.cwd, filePath);
    const stagePath = join(tmpDir(), relPath);

    // Write proposed content to staging directory
    ensureDir(dirname(stagePath));
    writeFileSync(stagePath, content, "utf-8");

    // Show review UI — user decides to approve/reject
    pi.events.emit("slow-mode:waiting", {});
    const result = await showReview(ctx, {
      operation: "WRITE",
      filePath: relPath,
      stagePath,
      body: content,
      allowEdit: true,
    });
    pi.events.emit("slow-mode:resolved", {});

    let editedContent: string | null = null;

    if (result === "approve") {
      // Read back the staged file in case user edited it
      try {
        const readBack = readFileSync(stagePath, "utf-8");
        if (readBack !== content) {
          editedContent = readBack;
        }
      } catch {
        // File might have been deleted — use original content
      }
    }

    // Clean up staged file after decision
    cleanup(stagePath);

    return { approved: result === "approve", editedContent };
  }

  /**
   * Result of an edit review.
   */
  interface EditReviewResult {
    approved: boolean;
    /** The new content after user editing (null if user didn't edit or rejected) */
    editedContent: string | null;
    /** The original newText (before user editing), for tracking */
    originalNewText: string | null;
    /** Whether the file was already written directly (multi-edit + external edit) */
    wroteDirectly: boolean;
  }

  /**
   * Review an edit tool call — stages old/new, shows diff, returns result.
   *
   * No longer mutates the input or returns block objects. The caller (tool
   * override) uses the returned content to construct modified params and
   * delegate to the original tool, or handles wroteDirectly by returning
   * a success result.
   */
  async function reviewEdit(
    toolCallId: string,
    params: { path: string; edits: Array<{ oldText: string; newText: string }> },
    ctx: ExtensionContext,
  ): Promise<EditReviewResult> {
    const filePath = params.path;
    const patches = extractEditPatches(params);
    if (!patches) return { approved: true, editedContent: null, originalNewText: null, wroteDirectly: false };

    const relPath = resolvePath(ctx.cwd, filePath);

    // For multi-edit, read the actual file and apply all edits for an accurate diff (M2 fix).
    // Falls back to concatenation if the file can't be read.
    let oldText: string;
    let newText: string;
    let usedRealFile = false;

    if (patches.length > 1) {
      try {
        const absolutePath = resolve(ctx.cwd, filePath);
        const fileContent = readFileSync(absolutePath, "utf-8");
        oldText = fileContent;
        newText = applyEdits(fileContent, patches);
        usedRealFile = true;
      } catch {
        const extracted = extractEditText(params);
        if (!extracted) return { approved: true, editedContent: null, originalNewText: null, wroteDirectly: false };
        oldText = extracted.oldText;
        newText = extracted.newText;
      }
    } else {
      const extracted = extractEditText(params);
      if (!extracted) return { approved: true, editedContent: null, originalNewText: null, wroteDirectly: false };
      oldText = extracted.oldText;
      newText = extracted.newText;
    }

    // Stage old and new files
    const base = basename(relPath);
    const ext = extname(base);
    const nameWithoutExt = base.slice(0, -ext.length || undefined);
    const ts = Date.now();
    const oldPath = join(tmpDir(), `${nameWithoutExt}-${ts}.old${ext}`);
    const newPath = join(tmpDir(), `${nameWithoutExt}-${ts}.new${ext}`);
    ensureDir(tmpDir());
    writeFileSync(oldPath, oldText, "utf-8");
    writeFileSync(newPath, newText, "utf-8");

    pi.events.emit("slow-mode:waiting", {});

    // Review loop: show diff → user can approve, reject, or edit → repeat
    let approved = false;

    reviewLoop:
    while (true) {
      const currentOldText = readFileSync(oldPath, "utf-8");
      const currentNewText = readFileSync(newPath, "utf-8");
      const diff = generateUnifiedDiff(relPath, currentOldText, currentNewText);
      const renderedDiff = renderWithDelta(diff);

      const decision = await showReview(ctx, {
        operation: "EDIT",
        filePath: relPath,
        body: renderedDiff,
        stagePath: newPath,
        oldPath,
        newPath,
        allowEdit: true,
      });

      switch (decision) {
        case "approve":
          approved = true;
          break reviewLoop;
        case "reject":
          approved = false;
          break reviewLoop;
        case "edit":
          openExternalFile(newPath);
          continue;
      }
    }

    let editedContent: string | null = null;
    let wroteDirectly = false;

    if (approved) {
      try {
        const editedNewText = readFileSync(newPath, "utf-8");
        if (editedNewText !== newText) {
          if (usedRealFile) {
            // Multi-edit with real file: write directly, don't delegate to original
            const absolutePath = resolve(ctx.cwd, filePath);
            writeFileSync(absolutePath, editedNewText, "utf-8");
            wroteDirectly = true;
          }
          editedContent = editedNewText;
        }
      } catch {
        // If we can't read the file, use original content
      }
    }

    pi.events.emit("slow-mode:resolved", {});
    cleanup(oldPath);
    cleanup(newPath);

    return { approved, editedContent, originalNewText: newText, wroteDirectly };
  }

  /**
   * Construct modified edit params with an updated newText value.
   *
   * Handles both the modern `edits[]` array format (single entry) and
   * the legacy `oldText`/`newText` top-level fields.
   */
  function constructModifiedEditParams(
    params: { path: string; edits: Array<{ oldText: string; newText: string }> },
    editedNewText: string,
  ): { path: string; edits: Array<{ oldText: string; newText: string }> } {
    // Single edit: replace the first (and only) edit entry's newText
    if (params.edits.length === 1) {
      return {
        path: params.path,
        edits: [{ oldText: params.edits[0].oldText, newText: editedNewText }],
      };
    }
    // Multi-edit fallback: replace all entries with a single full-content edit
    // (wroteDirectly case is handled before reaching here, so this is a safety net)
    return {
      path: params.path,
      edits: [{ oldText: params.edits.map((e) => e.oldText).join("\n"), newText: editedNewText }],
    };
  }

  ////----------------------------------------
  ///     Review UI
  //------------------------------------------

  /**
   * Result from the review UI: approve, reject, or edit (EDIT operations only)
   */
  type ReviewResult = "approve" | "reject" | "edit";

  /**
   * Options for the review UI component
   */
  interface ReviewOptions {
    operation: "WRITE" | "EDIT";   // Type of change being reviewed
    filePath: string;               // Relative path to the file
    body: string;                   // Content to display (file content or diff)
    stagePath?: string;             // Path to staged file (for writes and external editing)
    oldPath?: string;               // Staged old file (edits only)
    newPath?: string;               // Staged new file (edits only)
    allowEdit?: boolean;            // Allow editing: Ctrl+E for EDIT ops, content reload for WRITE ops
  }

  /**
   * Show interactive review UI for both write and edit operations.
   *
   * Displays the proposed change with scrollable preview and key bindings:
   * - Enter: approve change
   * - Esc: reject change
   * - Ctrl+C: reject (cancel review)
   * - Ctrl+E: edit the new file in $VISUAL/$EDITOR (EDIT operations, when allowEdit is true)
   * - Ctrl+O: open in external viewer/editor (delta/vim/diff for edits, $EDITOR for writes)
   * - k/↑: scroll up one line
   * - j/↓: scroll down one line
   * - u/PgUp: scroll up half page (15 lines)
   * - d/PgDn: scroll down half page (15 lines)
   * - gg: go to top
   * - G: go to bottom
   *
   * For WRITE operations with allowEdit, Ctrl+O opens the file in an editor and
   * reloads the content afterward for continued review.
   *
   * For EDIT operations with allowEdit, Ctrl+E returns "edit" so the caller can
   * open the editor and regenerate the diff.
   *
   * @returns Promise<ReviewResult> - "approve", "reject", or "edit"
   */
  async function showReview(
    ctx: ExtensionContext,
    opts: ReviewOptions,
  ): Promise<ReviewResult> {
    const { matchesKey, Key } = await import("@earendil-works/pi-tui");

    return ctx.ui.custom<ReviewResult>((tui, theme, _kb, done) => {
      // Scroll state
      let scrollOffset = 0;
      let cachedLines: string[] | undefined;

      // Current body content (may be updated after external edit for WRITE ops)
      let currentBody = opts.body;

      // Content split into lines for scrolling
      let bodyLines = currentBody.split("\n");
      const maxVisible = 30;  // Show up to 30 lines at once

      // Max scroll position (clamp to avoid scrolling past content)
      let maxScroll = Math.max(0, bodyLines.length - 5);

      // Track last 'g' press for gg binding
      let lastGPress = 0;

      // Render version counter for robust cache invalidation (L4)
      let renderVersion = 0;
      let cachedVersion = -1;

      /**
       * Clamp scroll offset to valid range
       */
      function clampScroll(offset: number) {
        scrollOffset = Math.max(0, Math.min(maxScroll, offset));
      }

      /**
       * Invalidate render cache and request re-render
       */
      function refresh() {
        renderVersion++;
        tui.requestRender();
      }

      /**
       * Open staged files in external viewer/editor
       * For edits: opens delta/vim diff
       * For writes: opens file in $VISUAL/$EDITOR
       *
       * For WRITE operations with allowEdit, reloads content after editing.
       */
      function openExternal() {
        try {
          if (opts.operation === "EDIT" && opts.oldPath && opts.newPath) {
            openExternalDiff(opts.oldPath, opts.newPath, opts.filePath);
          } else if (opts.stagePath) {
            openExternalFile(opts.stagePath);
          }

          // For WRITE operations with editing allowed, reload content after external edit
          if (opts.allowEdit && opts.operation === "WRITE" && opts.stagePath) {
            try {
              const editedContent = readFileSync(opts.stagePath, "utf-8");
              currentBody = editedContent;

              // Update bodyLines and scroll bounds
              bodyLines = currentBody.split("\n");
              maxScroll = Math.max(0, bodyLines.length - 5);
              scrollOffset = Math.min(scrollOffset, maxScroll);
            } catch {
              // If reload fails, keep showing original content
            }
          }
        } catch {
          // External viewer failed — stay in inline review
          // (e.g., viewer not found, user closed viewer)
        }
        refresh();
      }

      /**
       * Handle keyboard input
       */
      function handleInput(data: string) {
        // Approve change
        if (matchesKey(data, Key.enter)) {
          done("approve");
          return;
        }

        // Reject change (Esc or Ctrl+C)
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          done("reject");
          return;
        }

        // Edit: open just the new file in the user's editor (EDIT operations only)
        if (opts.allowEdit && opts.operation === "EDIT" && matchesKey(data, Key.ctrl("e"))) {
          done("edit");
          return;
        }

        // Open in external viewer
        if (matchesKey(data, Key.ctrl("o"))) {
          openExternal();
          return;
        }

        // Vim-style navigation: k or ↑ - scroll up one line
        if (data === "k" || matchesKey(data, Key.up)) {
          clampScroll(scrollOffset - 1);
          refresh();
          return;
        }

        // Vim-style navigation: j or ↓ - scroll down one line
        if (data === "j" || matchesKey(data, Key.down)) {
          clampScroll(scrollOffset + 1);
          refresh();
          return;
        }

        // Vim-style navigation: u or PgUp - scroll up half page (15 lines)
        if (data === "u" || matchesKey(data, Key.pageUp)) {
          clampScroll(scrollOffset - 15);
          refresh();
          return;
        }

        // Vim-style navigation: d or PgDn - scroll down half page (15 lines)
        if (data === "d" || matchesKey(data, Key.pageDown)) {
          clampScroll(scrollOffset + 15);
          refresh();
          return;
        }

        // Vim-style navigation: gg - go to top
        if (data === "g") {
          const now = Date.now();
          // Check if this is a double 'g' within 500ms
          if (now - lastGPress < 500) {
            scrollOffset = 0;
            refresh();
            lastGPress = 0; // Reset
          } else {
            lastGPress = now;
          }
          return;
        }

        // Vim-style navigation: G - go to bottom
        if (data === "G") {
          scrollOffset = maxScroll;
          refresh();
          return;
        }
      }

      /**
       * Render the review UI
       */
      function render(width: number): string[] {
        // Return cached lines if version matches (robust cache, L4)
        if (cachedLines && cachedVersion === renderVersion) return cachedLines;

        const lines: string[] = [];
        const add = (s: string) => lines.push(truncateToWidth(s, width));

        // Top separator
        add(theme.fg("accent", "─".repeat(width)));

        // Slow mode notice — makes it clear this dialog is from slow mode
        const colors = createUiColors(theme);
        add(colors.warning(" ⚠ SLOW MODE — review before applying"));

        // Operation label (NEW FILE or EDIT)
        const opLabel =
          opts.operation === "WRITE"
            ? theme.fg("warning", " NEW FILE")
            : theme.fg("accent", " EDIT (diff)");
        add(opLabel);

        // File path
        add(` ${theme.fg("accent", opts.filePath)}`);
        lines.push("");

        // Scrollable content/diff window
        const visible = bodyLines.slice(
          scrollOffset,
          scrollOffset + maxVisible,
        );

        // Check if the diff contains ANSI escape codes (from delta)
        const hasAnsiCodes = opts.operation === "EDIT" && /\x1b\[[0-9;]*m/.test(opts.body);

        for (const rawLine of visible) {
          // Expand tabs to 4 spaces for consistent rendering
          const line = rawLine.replace(/\t/g, "    ");
          if (opts.operation === "EDIT" && hasAnsiCodes) {
            // Delta has already colorized the diff, preserve ANSI codes
            add(` ${line}`);
          } else if (opts.operation === "EDIT") {
            // Fallback: Manual syntax highlighting for unified diff format
            if (line.startsWith("---") || line.startsWith("+++")) {
              // File headers — dim
              add(` ${theme.fg("dim", line)}`);
            } else if (line.startsWith("@@")) {
              // Hunk headers — accent
              add(` ${theme.fg("accent", line)}`);
            } else if (line.startsWith("+")) {
              // Added lines — green
              add(` ${theme.fg("success", line)}`);
            } else if (line.startsWith("-")) {
              // Removed lines — red
              add(` ${theme.fg("error", line)}`);
            } else {
              // Context lines — normal text
              add(` ${theme.fg("text", line)}`);
            }
          } else {
            // Write operation: no syntax highlighting, just plain text
            add(` ${theme.fg("text", line)}`);
          }
        }

        // Scroll indicator (show if content doesn't fit in window)
        if (bodyLines.length > maxVisible) {
          const total = bodyLines.length;
          const end = Math.min(scrollOffset + maxVisible, total);
          add(
            theme.fg(
              "dim",
              ` (lines ${scrollOffset + 1}–${end} of ${total} — ↑↓/PgUp/PgDn to scroll)`,
            ),
          );
        }

        lines.push("");

        // Key binding hints — differ based on operation type
        let hints = "Enter approve • Esc reject • Ctrl+C cancel";
        if (opts.allowEdit && opts.operation === "EDIT") {
          hints += " • Ctrl+E edit • Ctrl+O view diff";
        } else if (opts.allowEdit) {
          hints += " • Ctrl+O edit externally";
        } else {
          hints += " • Ctrl+O view externally";
        }
        hints += " • j/k u/d gg/G scroll";
        add(theme.fg("dim", ` ${hints}`));

        // Bottom separator
        add(theme.fg("accent", "─".repeat(width)));

        // Cache the rendered lines with current version
        cachedLines = lines;
        cachedVersion = renderVersion;
        return lines;
      }

      // Return TUI component interface
      return {
        render,
        invalidate: () => {
          cachedLines = undefined;
          cachedVersion = -1;
        },
        handleInput,
      };
    });
  }

  ////----------------------------------------
  ///     External viewers
  //------------------------------------------

  /**
   * Open old/new files in an external diff viewer
   *
   * Discovery order:
   * 1. delta (best terminal diff experience)
   * 2. nvim -d (if nvim available)
   * 3. vim -d (if vim available)
   * 4. diff (fallback to plain diff)
   *
   * If no diff tool found, falls back to opening just the new file.
   *
   * @param oldPath - Path to staged old version
   * @param newPath - Path to staged new version
   * @param label - File label used to replace temp paths in delta diff headers
   *   for syntax detection
   */
  function openExternalDiff(oldPath: string, newPath: string, label: string) {
    const diffTool = findDiffTool();

    // No diff tool found — fall back to opening just the new file
    if (!diffTool) {
      openExternalFile(newPath);
      return;
    }

    const { cmd, args } = diffTool;

    // Configure tool-specific arguments
    if (cmd === "delta") {
      // delta: use diff and pipe to delta for proper syntax highlighting
      // Generate diff with original filename so delta can detect file type
      try {
        const diff = execFileSync("diff", ["-u", oldPath, newPath], {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        // diff returns empty if files are identical (shouldn't happen, but handle it)
        execFileSync(cmd, ["--paging", "always", "--side-by-side"], {
          input: diff,
          stdio: ["pipe", "inherit", "inherit"],
        });
      } catch (e: any) {
        // diff exits with 1 when files differ, which is expected
        if (e.stdout) {
          // Replace temp paths with original filename in diff headers for syntax detection
          let diff = e.stdout as string;
          diff = diff.replace(/^--- .*$/m, `--- a/${label}`);
          diff = diff.replace(/^\+\+\+ .*$/m, `+++ b/${label}`);
          
          execFileSync(cmd, ["--paging", "always", "--side-by-side"], {
            input: diff,
            stdio: ["pipe", "inherit", "inherit"],
          });
        } else {
          // Fallback to direct file comparison
          args.push("--paging", "always", "--side-by-side", oldPath, newPath);
          execFileSync(cmd, args, { stdio: "inherit" });
        }
      }
    } else if (cmd === "nvim" || cmd === "vim") {
      // vim/nvim: open in diff mode
      args.push("-d", oldPath, newPath);
      execFileSync(cmd, args, { stdio: "inherit" });
    } else {
      // Generic diff tool: assume it takes two file arguments
      args.push(oldPath, newPath);
      execFileSync(cmd, args, { stdio: "inherit" });
    }
  }

  /**
   * Open a single file in the user's preferred editor
   *
   * Uses $VISUAL, $EDITOR, or falls back to 'less' for viewing.
   */
  function openExternalFile(filePath: string) {
    const editor = process.env.VISUAL || process.env.EDITOR || "less";
    execFileSync(editor, [filePath], { stdio: "inherit" });
  }

  /**
   * Check if a command exists in PATH using `command -v`.
   *
   * Uses `command -v` (POSIX shell builtin) instead of `which` for
   * portability — `which` is absent on Alpine, NixOS, and some minimal
   * container images.
   */
  function commandExists(cmd: string): boolean {
    try {
      // command -v is a POSIX shell builtin — run via sh -c
      execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Find an available diff tool on the system
   *
   * @returns { cmd, args } if found, null otherwise
   */
  function findDiffTool(): { cmd: string; args: string[] } | null {
    // Prefer delta for nice terminal diff, then vimdiff, then plain diff
    const candidates = ["delta", "nvim", "vim", "diff"];

    for (const cmd of candidates) {
      if (commandExists(cmd)) {
        return { cmd, args: [] };
      }
    }

    // No diff tool found
    return null;
  }

  ////----------------------------------------
  ///     Delta diff rendering
  //------------------------------------------
  // Cache delta availability check
  let deltaAvailable: boolean | null = null;

  /**
   * Check if delta is available on the system.
   * Result is cached to avoid repeated process spawns.
   */
  function hasDelta(): boolean {
    if (deltaAvailable !== null) {
      return deltaAvailable;
    }
    deltaAvailable = commandExists("delta");
    return deltaAvailable;
  }

  /**
   * Render a unified diff with delta syntax highlighting.
   * 
   * Pipes the diff through `delta --color-only` via stdin to produce
   * ANSI-colored output. No shell interpolation — uses execFileSync with
   * an args array and stdin pipe for safety.
   * Falls back to the original diff if delta is unavailable or fails.
   *
   * @param unifiedDiff - Standard unified diff string
   * @returns ANSI-colored diff if delta is available, otherwise the original diff
   */
  function renderWithDelta(unifiedDiff: string): string {
    if (!hasDelta()) {
      return unifiedDiff;
    }

    try {
      // Pipe diff to delta via stdin — no temp file, no shell interpolation
      const result = execFileSync(
        "delta",
        ["--no-gitconfig", "--color-only", "--tabs", "4"],
        {
          input: unifiedDiff,
          encoding: "utf-8",
          timeout: 5000,
        },
      );
      return result;
    } catch {
      // Delta failed, return original diff
      return unifiedDiff;
    }
  }

  ////----------------------------------------
  ///     Helpers
  //------------------------------------------

  /**
   * Ensure a directory exists, creating parent directories as needed
   */
  function ensureDir(dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  /**
   * Delete a file, ignoring errors
   * (Used for cleaning up staged files after review)
   */
  function cleanup(path: string) {
    try {
      unlinkSync(path);
    } catch {
      // Ignore — tmp cleanup is best-effort
      // File may not exist or may be in use
    }
  }
}