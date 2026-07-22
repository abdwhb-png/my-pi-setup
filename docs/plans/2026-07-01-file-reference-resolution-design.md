# Plan: File Reference Resolution Fix

**Date**: 2026-07-01
**Status**: Draft
**File**: `~/.pi/agent/extensions/pi-file-resolver.ts`

## Problem

When user types `@filename` in pi prompt, pi's TUI autocomplete inserts a **relative path** (relative to CWD). When LLM later reads the file, it resolves relative to its working directory — which may differ from original CWD. Result: file not found or wrong file read.

**Example**: User opens pi in `~/.pi`, references `@plan-fork-customization.md` (lives in `~/.pi/pi-prompts/`). Autocomplete inserts `@pi-prompts/plan-fork-customization.md`. LLM later switches to `~/projects/pi-integrations/` → resolves to wrong path.

**Root cause**: `getFuzzyFileSuggestions` in `packages/tui/src/autocomplete.ts` constructs `displayPath` relative to `fdBaseDir`. `buildCompletionValue` wraps with `@` prefix → result is relative path ambiguous outside original CWD.

## Solution: Two-Part Extension

### Part A — Autocomplete Wrapper

Wrap `CombinedAutocompleteProvider` via `ctx.ui.addAutocompleteProvider`. Transform all `@` autocomplete results from relative to absolute paths.

**How**: Intercept `getSuggestions` return value. For items with `@` prefix, parse the path, if not already absolute → `path.join(cwd, parsedPath)`. Same transform in `applyCompletion`.

**Result**: `@pi-prompts/plan-fork.md` becomes `@~/.pi/pi-prompts/plan-fork.md`. LLM always reads correct file regardless of context switches.

### Part B — Preprocessor Hook

Hooks `before_agent_start`. Builds background file index across search roots. On each turn, scans prompt for unresolved `@bareword` references and resolves to absolute paths using in-memory fuzzy matching.

**Why**: Catches manually-typed `@filename` (no autocomplete), pasted references, edge cases.

**Performance**: Codex-style indexed search. `fd` walks once in background (non-blocking). In-memory `fuzzyFilter` on each turn — sub-ms. Cache starts empty, fills progressively.

### What This Does NOT Do

- Does NOT modify core pi source — pure extension
- Does NOT inject file content (unlike `pi-file-reference`) — only resolves paths
- Does NOT add search directories beyond configured roots
- Does NOT handle symlink resolution (path.join works on symlinks, read tool handles actual resolution)

## Architecture

```
┌─ Extension: pi-file-resolver ─────────────────────────────┐
│                                                            │
│  setup(ctx):                                               │
│                                                            │
│    // ── Part A: Autocomplete wrapper ──                   │
│    ctx.ui.addAutocompleteProvider(current => ({            │
│      getSuggestions: delegate → transform @paths → abs    │
│      applyCompletion: transform @paths → abs → delegate   │
│    }))                                                     │
│                                                            │
│    // ── Part B: Preprocessor ──                           │
│    const cache = { files: [] as string[] }                 │
│                                                            │
│    // Background index (session start)                     │
│    buildIndexBackground(cache, roots) // fire-and-forget   │
│                                                            │
│    ctx.on("before_agent_start", async (event) => {         │
│      buildIndexBackground(cache, roots) // ensure started  │
│      const refs = findUnresolvedAtRefs(event.prompt)       │
│      if (!refs.length) return                              │
│      for (const ref of refs) {                             │
│        const match = fuzzyFilter(                          │
│          cache.files, ref.name, basename                   │
│        )                                                   │
│        if (match.length)                                   │
│          event.prompt = event.prompt.replace(              │
│            ref.raw, `@${match[0]}`                         │
│          )                                                 │
│      }                                                     │
│    })                                                      │
│                                                            │
│  Search roots: [cwd, agentDir,                             │
│    ~/.pi/prompts, ~/.pi/skills,                            │
│    ~/.pi/agent/extensions]                                 │
└────────────────────────────────────────────────────────────┘
```

## Implementation Details

### Part A: `parseAtValue` / `rebuildAtValue`

```typescript
interface ParsedAtValue {
  path: string;
  isQuoted: boolean;
  isDirectory: boolean;
}

function parseAtValue(value: string): ParsedAtValue {
  // "@path/to/file" → { path: "path/to/file", isQuoted: false, isDirectory: false }
  // "@"/path with spaces"" → { path: "path with spaces", isQuoted: true, ... }
  // "@/absolute/path" → { path: "/absolute/path", isQuoted: false, ... }
  // "@relative/path/" → { path: "relative/path/", isDirectory: true }
  let raw = value.startsWith("@") ? value.slice(1) : value;
  let isQuoted = false;

  if (raw.startsWith('"') && raw.endsWith('"')) {
    isQuoted = true;
    raw = raw.slice(1, -1);
  }

  const isDirectory = raw.endsWith("/");
  return { path: isDirectory ? raw.slice(0, -1) : raw, isQuoted, isDirectory };
}

function rebuildAtValue(path: string, parsed: ParsedAtValue): string {
  const display = parsed.isDirectory ? `${path}/` : path;
  if (parsed.isQuoted) return `@"${display}"`;
  return `@${display}`;
}
```

### Part B: `findUnresolvedAtRefs`

```typescript
function findUnresolvedAtRefs(text: string): Array<{ raw: string; name: string }> {
  const refs: Array<{ raw: string; name: string }> = [];
  const regex = /(?:^|\s)@([^\s@]+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const name = match[1];
    // Already absolute? Skip.
    if (name.startsWith("/") || name.startsWith("~/")) continue;
    // Has directory separator? Already scoped. Skip.
    if (name.includes("/")) continue;
    refs.push({ raw: match[0].trim(), name });
  }
  return refs;
}
```

### Background indexing

```typescript
let cachePromise: Promise<void> | null = null;

function buildIndexBackground(cache: { files: string[] }, roots: string[], fdPath: string): void {
  if (cachePromise) return; // already running or completed
  cachePromise = (async () => {
    const results: string[] = [];
    for (const root of roots) {
      try {
        const entries = await walkDirectoryWithFd(
          root,
          fdPath,
          "",
          10000,
          new AbortController().signal,
        );
        for (const entry of entries) {
          results.push(join(root, entry.path));
        }
      } catch {
        /* root not found, skip */
      }
    }
    // Deduplicate by canonical path
    cache.files = [
      ...new Set(
        results.map((p) => {
          try {
            return realpathSync(p);
          } catch {
            return p;
          }
        }),
      ),
    ];
    cachePromise = null;
  })();
}
```

Uses same `walkDirectoryWithFd` from autocomplete.ts. For the extension, we vendor a copy or import from pi-tui if exposed.

## Search Roots

```
cwd          — current working directory (primary)
agentDir     — ~/.pi/agent/
~/.pi/prompts/    — prompt templates
~/.pi/skills/     — skills directory
~/.pi/agent/extensions/ — extension source files
```

Roots are deduplicated via path canonicalization.

## Testing

**File**: `~/.pi/agent/extensions/pi-file-resolver.test.ts`

**Framework**: `bun:test` (preferred per project conventions)

**Mock strategy**: Mock `@earendil-works/pi-tui` and pi extension environment. Mock `fd` spawn via `mock.module("child_process")`. Use temp directories.

| #   | Test                                          | Validates                     |
| --- | --------------------------------------------- | ----------------------------- |
| 1   | `@file-in-cwd.md` → absolute path             | Relative → absolute transform |
| 2   | `@nested/deep/file.ts` → absolute             | Nested paths preserved        |
| 3   | `@"/path with spaces/file.md"` → absolute     | Quoted paths with spaces      |
| 4   | `@/already/absolute` → unchanged              | Absolute passthrough          |
| 5   | `@nonexistent` → no match, leaves as-is       | Graceful failure              |
| 6   | `@prompt-file.md` in ~/.pi/prompts/ → found   | Multi-root search             |
| 7   | Background index fills after delay            | Async cache population        |
| 8   | `findUnresolvedAtRefs` skips already-resolved | No double-processing          |
| 9   | `parseAtValue` → `rebuildAtValue` round-trip  | Format preservation           |
| 10  | Autocomplete + preprocessor integrate cleanly | Components don't conflict     |

## Edge Cases

- **Symlinks**: `fd --follow` handles. `path.join` works on symlink targets. `read` tool resolves actual file.
- **`.gitignore`**: `fd` respects by default. No change needed.
- **Unicode paths**: `fd` handles UTF-8. `path.join` preserves unicode.
- **10k+ files**: `fd` scales well. `fuzzyFilter` is O(n) per query — test with 10k cache entries.
- **Race condition**: Cache may be empty when first prompt fires. `fuzzyFilter` returns empty → refs left unchanged → LLM tries own tools. Acceptable degradation.

## Non-Goals (v2+)

- File change watching / cache invalidation
- Configurable search roots via settings.json
- Content injection (like pi-file-reference)
- `.gitignore` override for search roots
- `@filename:line` syntax (anchor fragments)

## References

- Codex file search: `codex-rs/file-search/src/lib.rs` — nucleo + ignore::WalkBuilder
- Codex mention codec: `codex-rs/tui/src/mention_codec.rs` — `[@name](path)` encoding
- Pi autocomplete source: `packages/tui/src/autocomplete.ts` — `CombinedAutocompleteProvider`
- Pi fuzzy matching: `packages/tui/src/fuzzy.ts` — `fuzzyFilter`, `fuzzyMatch`
- Pi paths utility: `packages/coding-agent/src/utils/paths.ts` — `resolvePath`
- Pi extension API: `packages/tui/README.md` — `ctx.ui.addAutocompleteProvider`
- Pi hooks: `packages/agent/src/harness/agent-harness.ts` — `before_agent_start`
