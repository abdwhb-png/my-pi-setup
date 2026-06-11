---
description: "Instructions for using LSP tools for code navigation and analysis. Enforce LSP usage for definitions, references, symbols, and diagnostics instead of grep/glob/read."
applyTo: '**/*.{ts,tsx,js,jsx,py,go,java,rs}'  # Adjust file patterns as needed
---
## LSP Server - REQUIRED FIRST STEP

**BEFORE any code analysis, navigation, or codebase exploration, you MUST:**

1. Run `lsp_server_status` to check running servers
2. If the relevant language server is NOT running → run `lsp_start_server` immediately
3. ONLY AFTER the LSP server is running, proceed with analysis

This is a hard requirement, not a preference. Do NOT skip this step.

## LSP Tool Requirements

When LSP MCP tools are available, you MUST use them instead of alternatives:

| Task                      | REQUIRED Tool                                | FORBIDDEN Alternatives    |
| ------------------------- | -------------------------------------------- | ------------------------- |
| Find where X is defined   | `lsp_goto_definition`                        | Grep, Read, Glob          |
| Find where X is used      | `lsp_find_references`                        | Grep                      |
| Find symbol by name       | `lsp_workspace_symbols` or `lsp_find_symbol` | Glob, Grep                |
| Understand file structure | `lsp_document_symbols`                       | Read entire file          |
| Get type information      | `lsp_hover`                                  | Reading source code       |
| Find implementations      | `lsp_find_implementations`                   | Grep                      |
| Understand module API     | `lsp_file_exports`                           | Read entire file          |
| Check for errors          | `lsp_diagnostics`                            | Running compiler manually |
| See file dependencies     | `lsp_file_imports` or `lsp_related_files`    | Grep for imports          |

## Prohibited Patterns

When LSP is available, NEVER do these:

- NEVER use `Grep` to find function/class/symbol definitions
- NEVER use `Grep` to find where a symbol is referenced
- NEVER use `Glob` to find files containing a symbol name
- NEVER use `Read` to scan through a file looking for definitions
- NEVER use `Bash` with grep/rg/find for code navigation

These tools are still appropriate for:
- Searching for text/strings (not code symbols)
- Reading configuration files
- Reading documentation files
- File operations unrelated to code navigation

## LSP Tool Quick Reference

- `lsp_server_status` -> Check what's running 
- `lsp_start_server` -> Start a language server
- `lsp_stop_server` -> Stop a language server
- `lsp_goto_definition` -> Jump to where symbol is defined
- `lsp_goto_type_definition` -> Jump to type definition
- `lsp_find_references` -> Find all usages of a symbol
- `lsp_find_implementations` -> Find concrete implementations
- `lsp_workspace_symbols` -> Search symbols across project
- `lsp_document_symbols` -> Get outline of a file
- `lsp_document_highlights` -> Every occurrence in this file (read/write classified)
- `lsp_hover` -> Get type/docs for symbol
- `lsp_signature_help` -> Get function parameter hints
- `lsp_inlay_hints` -> Inferred types + parameter names over a range
- `lsp_completions` -> Get code completions
- `lsp_diagnostics` -> Get errors/warnings for a file
- `lsp_workspace_diagnostics` -> Get errors/warnings across opened files
- `lsp_index_files` -> Warm up: batch-open files for workspace diagnostics
- `lsp_file_exports` -> Get public API of a module
- `lsp_file_imports` -> Get imports/dependencies of a file (regex, JS/TS)
- `lsp_related_files` -> Find connected files (imports/imported by)
- `lsp_folding_ranges` -> Foldable regions (functions, blocks, imports)
- `lsp_selection_range` -> Semantic enclosing ranges (stmt/block/fn)
- `lsp_rename` -> Rename symbol across codebase
- `lsp_code_actions` -> Get/apply quick fixes and refactorings
- `lsp_call_hierarchy` -> See callers and callees
- `lsp_type_hierarchy` -> See type inheritance
- `lsp_format_document` -> Format code
- `lsp_smart_search` -> Combined: definition + refs + hover
- `lsp_find_symbol` -> Find symbol by name (optionally scoped to a file)