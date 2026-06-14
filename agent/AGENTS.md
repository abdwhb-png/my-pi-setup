<general_constraints>

- You must always provide factual and accurate information. If you are unsure about something, search for reliable sources before providing an answer.
- You do not guess when you can ask the user for clarification. If a request is ambiguous or missing critical details, use `ask_user_question` tool to ask the user specific questions to clarify before proceeding.
- Always use `context7` coupled with `deepwiki` when I need library/API documentation (including pi), code generation, setup or configuration steps without me having to explicitly ask.
- Prefer breaking down complex tasks into todo lists and executing them step by step, rather than trying to do everything in one go.
- Use the `factual-research` skill for factual research or delegate to researcher subagent when necessary.
- Firecrawl mcp is not available so use firecrawl-cli (some available skills: `firecrawl`, `firecrawl-crawl`, `firecrawl-scrape`, `firecrawl-search`)
- Use `safe_bash` instead of `bash` for any bash commands. `safe_bash` blocks dangerous patterns (rm -rf /, sudo, mkfs, shutdown, reboot, etc.) and is available as an installed extension.
  
</general_constraints>

<mandatory-lsp-usage>

**Derived from the `lsp-mcp-server` skill.** For the full reference with extended workflows, gotchas, and error codes, automatically refer to the skill.

# LSP Semantic Navigation Master Guide

## 1. Setup & Hard Rules
**BEFORE any code analysis, you MUST ensure the server is running:**
1. Run `lsp_server_status`.
2. If the relevant server is missing $\rightarrow$ run `lsp_start_server` immediately.
3. **Server ID Mapping**: `.ts/.tsx/.js/.jsx` $\rightarrow$ `typescript` | `.py` $\rightarrow$ `python` | `.rs` $\rightarrow$ `rust` | `.go` $\rightarrow$ `go` | `.cpp/.hpp/.c/.h` $\rightarrow$ `clangd`.

**Hard Rules for Tool Usage:**
- **LSP First**: Prefer LSP tools over text search for anything code-shaped.
- **Absolute Paths**: All file paths MUST be absolute. Relative paths are rejected by Zod validation.
- **1-Indexed**: All line/column numbers are 1-indexed (as shown in editors).
- **Precision**: Point the cursor at the symbol itself, not at whitespace, brackets, or commas.
- **Text Search**: Use `grep`/`Glob`/`Read` ONLY for strings, comments, config files, and docs.

## 2. Navigation Strategy (The "Truth" Hierarchy)

When searching for a symbol (function, class, variable), follow this hierarchy to avoid "0 results" failures:

### Phase A: Local Discovery (The "What is here?" phase)
- **Tool**: `lsp_workspace_symbols` or `lsp_find_symbol`.
- **Scope**: Only indexes symbols defined **within the local workspace source**.
- **Failure Case**: If this returns 0 results, the symbol is likely defined in a **dependency (node_modules)** or is a dynamic property. **DO NOT** assume the symbol doesn't exist.

### Phase B: Contextual Discovery (The "Where is it used?" phase)
- **Action**: If Phase A fails, use `grep_search` or `lsp_find_references` to find where the symbol is *used* in the local code.
- **Action**: Read the `import` statements of those files to identify the source library.

### Phase C: Library Resolution (The "Deep Dive" phase)
- **Tool**: `lsp_goto_definition` or `lsp_hover`.
- **Scope**: Works for **both local and library code**.
- **Action**: Call `lsp_goto_definition` on the symbol at its usage site. This is the only way to reach the source code inside `node_modules`.

## 3. Decision Tree: Pick the Right Tool

| If you want to...                  | Use this Tool              | Note                                    |
| :--------------------------------- | :------------------------- | :-------------------------------------- |
| Find a name but not where it lives | `lsp_find_symbol`          | Preferred for single matches.           |
| Find many matches for a name       | `lsp_workspace_symbols`    | Broad search across project.            |
| Find a definition at a position    | `lsp_goto_definition`      | **The gold standard** for library code. |
| Find the interface/class of a var  | `lsp_goto_type_definition` | Jump to the type.                       |
| Find all usages of a symbol        | `lsp_find_references`      | Semantic, not text-based.               |
| Get type info / documentation      | `lsp_hover`                | Best for API signatures.                |
| Find concrete implementations      | `lsp_find_implementations` | For interfaces/abstract classes.        |
| See who calls it / what it calls   | `lsp_call_hierarchy`       | Trace the execution flow.               |
| Explore class inheritance          | `lsp_type_hierarchy`       | Parents and children.                   |
| Get everything in one call         | `lsp_smart_search`         | Definition + Hover + Refs + more.       |
| Get a file's structure/outline     | `lsp_document_symbols`     | Fast structural overview.               |
| Get a module's public API          | `lsp_file_exports`         | Top-level exports with signatures.      |
| See file dependencies              | `lsp_file_imports`         | Imports/dependencies of a file.         |
| Find connected files               | `lsp_related_files`        | Imports and imported-by.                |
| Check for errors/warnings          | `lsp_diagnostics`          | Real-time lint/type errors.             |

## 4. Canonical Workflows

### A. "Find the definition of foo"
1. Try `lsp_find_symbol(name="foo")`.
2. If 0 results $\rightarrow$ `grep_search("foo")` to find a usage site in local code.
3. Use `lsp_goto_definition` at that usage site to jump to the source (even in `node_modules`).

### B. "Will renaming X break anything?"
1. Call `lsp_rename(..., dry_run: true)` (default — safe).
2. Review the `changes` map.
3. If correct, call again with `dry_run: false`.

### C. "Did my edit break anything?"
1. Touch the file with any LSP tool (this opens it in the server).
2. Call `lsp_diagnostics(file_path=...)`.
3. For project-wide scans: `lsp_index_files(files=[...])` $\rightarrow$ `lsp_workspace_diagnostics()`.

### D. "Apply a quick fix"
```json
lsp_code_actions(kinds: ["quickfix"])
```
Read the returned actions, then call again with `apply: true, action_index: N`.

### E. "What does this file expose?"
Prefer `lsp_file_exports` over reading the whole file for a quick public-API view.

## 5. Critical Gotchas

- **Workspace Diagnostics**: `lsp_workspace_diagnostics` only reflects **opened files**. You MUST use `lsp_index_files(files=[...])` to warm up the server first.
- **Related Files**: `lsp_related_files` `imported_by` only sees files already opened this session. For a language-correct "everything that imports X", use `lsp_find_references` on the export instead.
- **Call/Type Hierarchy**: These require a callable/class-like position. Pointing at a variable will throw `CAPABILITY_NOT_SUPPORTED`. Point at the function/class name itself.
- **Symbol Kinds**: Use LSP-standard capitalized names: `Class`, `Function`, `Method`, `Interface`, `Variable`, `Property`, `Field`, `Enum`, `Constructor`, `Constant`. Lowercase silently matches nothing.
- **Auto-Start**: The server auto-starts on first file touch. You usually don't need `lsp_start_server` unless explicitly missing.
- **File Size**: Files larger than 10 MB are rejected.

## 6. Graceful Fallback Policy

LSP is the primary and required method for code navigation. Fallback to `grep_search` or `read_file` is **FORBIDDEN** unless:
1. You have attempted to start the server.
2. The LSP tool returned an error, timed out, or provided no results *after* you tried both Local and Library resolution strategies.
3. You are searching for plain text, comments, or configuration values (non-code symbols).

**Before falling back, always check:**
- Is the cursor on the identifier (not on a space, dot, or bracket)?
- Did you pass an absolute path?
- Is the language server actually installed? (`lsp_server_status` will tell you.)
- For workspace-wide queries: are the files opened in the server yet?

## 7. Prohibited Patterns
- **NEVER** use `Grep` to find a function definition.
- **NEVER** assume a symbol doesn't exist just because `lsp_workspace_symbols` returned 0.
- **NEVER** read a 1000-line file to find a symbol when `lsp_document_symbols` can provide the outline.

</mandatory-lsp-usage>

<coding-guidelines>

## Working in typescript

- when adding a package to a project add it with an install command, instead of manually editing the package json
- run check/format/lint commands when your done making a change. if they don't exist, suggest making them for the project you're in
- avoid running `dev` or `build` commands. if you really need to, ask first

</coding-guidelines>

<test-driven-development>

## Test Framework

- **`bun test` is mandatory.** Use bun's native test runner (`bun:test` imports) for all testing — it's 10x faster startup and 2.5-8x faster execution than vitest. Never use manual console.log test harnesses.
- Import the module under test directly — **never copy-paste functions** into the test file. Testing copies of code instead of real imports is the most common silent failure pattern: the copy diverges from the source, and errors like missing dependencies or broken imports go undetected.
- If an import cannot be resolved by the test runner (e.g. pi extension packages requiring jiti), **mock it with `mock.module()`** — do not inline a copy. The goal is to exercise the real module and catch resolution errors at test time.

## Anti-Patterns (prohibited)

1. **Copy-pasting source functions into test files** — Tests must import the real module. Copies do not catch import errors, missing dependencies, or divergence.
2. **Skipping TDD because "the environment makes testing hard"** — If the env blocks imports, mock the blockers, don't bypass them.
3. **Testing pure helpers in isolation without testing the module that exports them** — The helpers are only useful if the consuming module loads correctly. Always have at least one test that imports the full module.
4. **Detaching methods from class instances** (`const f = obj.method; f()`) — In TypeScript, class methods lose `this` when detached. Always call methods directly (`obj.method()`) or use arrow-function class fields. Tests must explicitly verify this pattern if a public API returns a method reference.

## Post-edit verification (MANDATORY after every edit)

1. **Parse-check every edited file** — Run `node --check <file>` on every `.ts`/`.js` file modified. This catches stray characters, unterminated strings, and syntax errors that `bun test` won't see unless the file is imported by a test.
2. **LSP diagnostics** — Run `lsp_diagnostics` on every changed file. This catches type errors before tests even run.
3. **Run all tests** — At minimum the test files in the changed directory, ideally the full suite.

These 3 steps MUST execute in Phase 3 (Verification) after every code change. If a file has no test that imports it, that's a gap — add an import test.

## Red-Green-Refactor

- Always follow the `tdd` skill: RED (failing test) → GREEN (minimal code) → REFACTOR.
- **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.**
- Write one minimal test showing what should happen. Watch it fail for the right reason. Then write the minimal code to make it pass.

## Mocking pi extensions

When a module imports from pi packages that require jiti (e.g., `@plannotator/pi-extension`, `@earendil-works/pi-coding-agent`), use bun's `mock.module()` to stub them:

```ts
import { mock, describe, it, expect } from "bun:test";

mock.module("@plannotator/pi-extension/plannotator-browser.js", () => ({
  openPlanReviewBrowser: mock(),
  openMarkdownAnnotation: mock(),
  hasPlanBrowserHtml: mock().mockReturnValue(false),
}));

// ⚠️ mock.module() is NOT hoisted — use dynamic import after setting up the mock
const { validatePlanPath } = await import("./index.ts");
```

Key difference from vitest's `vi.mock()`: bun's `mock.module()` executes in order, not hoisted. Static `import` after `mock.module()` won't see the mock — you must use `await import(...)` after the mock setup.

This catches import errors, type mismatches, and structural issues while keeping tests fast and isolated from the pi runtime.

</test-driven-development>
  
<pi-intercom>

Coordinate with other local pi sessions on related codebases. Use `/skill:pi-intercom` for patterns.

**When:** Same codebase (parallel work), reference codebase (consulting patterns), related repos (shared libraries).

**Not when:** Unrelated codebases, trivial questions, or when you can proceed independently.

**Principle:** Prefer `send` for notifications; `ask` only when blocked waiting for input.

</pi-intercom>

## Important Notes
- Always follow `dependency-installation` skill instructions when installing new dependencies. Do not skip steps or make assumptions about the environment.
- You must not proceed to implementation unless explicitly asked to do so by the user. Always ask for confirmation before starting implementation.

## Additional Context
- [Context](./CONTEXT.md)