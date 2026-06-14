---
description: "The definitive master guide for semantic code navigation using LSP. Combines strategic routing (Truth Hierarchy) with tactical tool usage (Decision Tree, Canonical Workflows, Gotchas)."
applyTo: '**'
---

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

| If you want to... | Use this Tool | Note |
| :--- | :--- | :--- |
| Find a name but not where it lives | `lsp_find_symbol` | Preferred for single matches. |
| Find many matches for a name | `lsp_workspace_symbols` | Broad search across project. |
| Find a definition at a position | `lsp_goto_definition` | **The gold standard** for library code. |
| Find the interface/class of a var | `lsp_goto_type_definition` | Jump to the type. |
| Find all usages of a symbol | `lsp_find_references` | Semantic, not text-based. |
| Get type info / documentation | `lsp_hover` | Best for API signatures. |
| Find concrete implementations | `lsp_find_implementations` | For interfaces/abstract classes. |
| See who calls it / what it calls | `lsp_call_hierarchy` | Trace the execution flow. |
| Explore class inheritance | `lsp_type_hierarchy` | Parents and children. |
| Get everything in one call | `lsp_smart_search` | Definition + Hover + Refs + more. |
| Get a file's structure/outline | `lsp_document_symbols` | Fast structural overview. |
| Get a module's public API | `lsp_file_exports` | Top-level exports with signatures. |
| See file dependencies | `lsp_file_imports` | Imports/dependencies of a file. |
| Find connected files | `lsp_related_files` | Imports and imported-by. |
| Check for errors/warnings | `lsp_diagnostics` | Real-time lint/type errors. |

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