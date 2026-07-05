- "pi" always stand for pi agent harness, not Rasberry Pi or something else.
- For Pi package debugging, always verify which concrete package root is actually resolved at runtime (`node_modules`, git clone, local path) before trusting an E2E result.
- Never patch the global Bun installation to fix Pi package issues; prefer harness-level solutions such as Pi extensions, wrappers, explicit finalizers, and repo-managed symlinks.
- Hypa usage policy: use normal built-in tools (`read`, `grep`, `bash`, `safe_bash`, `ls`, `find`) by default; the local Edgee compressor service trims their `tool_result` output automatically. Use `hypa_*` only when you specifically want Hypa behavior (rewrite policy, context-aware reads/search, or MCP proxy features). Never route `hypa_*` outputs back through the Edgee compressor.

<user_preferences>

- The user can't see tool/bash output, always relay important results back in text.
- The user prefer bun as the pi agent runtime. Bun is only mandatory for the pi agent runtime, not for other repositories or projects. If the user is using a different runtime, you should adapt your actions accordingly.
- Don't automatically agree with what the user says. Be critical: you need to challenge him and be direct. 
- **Always make your responses clear & very concise**: Only give answers of the highest quality; avoid unnecessary chatter and get straight to the point.
  
</user_preferences>

<doing_research>

- Always prefer firecrawl mcp tools for web page scrapin. If the mcp is not available fallback to the firecrawl cli usage (available skills: `firecrawl`, `firecrawl-crawl`, `firecrawl-scrape`, `firecrawl-search`)!
- Sometimes basic web search is not enough, you need to couple it with firecral tools to get more accurate and up-to-date information.

</doing_research>

<mandatory_lsp_usage>

# LSP Semantic Navigation Master Guide

## 1. Setup & Hard Rules
**BEFORE any code analysis, you MUST ensure the server is running:**
1. Run `/lsp` to check status.
2. If the relevant server is missing -> use `/lsp-config` or wait for lazy startup.

**Hard Rules for Tool Usage:**
- **LSP First**: Prefer LSP tools over text search for anything code-shaped.
- **Absolute Paths**: All file paths MUST be absolute.
- **1-Indexed**: All line/column numbers are 1-indexed.
- **Precision**: Point the cursor at the symbol itself, not at whitespace or brackets.
- **Text Search**: Use `grep`/`Glob`/`Read` ONLY for strings, comments, and config files.

## 2. Navigation Strategy (The "Truth" Hierarchy)
When searching for a symbol, follow this hierarchy to avoid "0 results" failures:

### Phase A: Local Discovery
- **Tool**: `lsp_symbols` (search by name or list file symbols).
- **Scope**: Local workspace source.
- **Failure Case**: If 0 results, the symbol is likely in a dependency (node_modules).

### Phase B: Contextual Discovery
- **Action**: Use `grep_search` or `lsp_references` to find where the symbol is *used* in local code.
- **Action**: Read the `import` statements to identify the source library.

### Phase C: Library Resolution
- **Tool**: `lsp_definition` or `lsp_hover`.
- **Scope**: Works for both local and library code. Call `lsp_definition` at the usage site to reach `node_modules`.

## 3. Decision Tree: Pick the Right Tool

| If you want to...               | Use this Tool    | Note                                         |
| :------------------------------ | :--------------- | :------------------------------------------- |
| Find a name / List symbols      | `lsp_symbols`    | Broad search across project or file outline. |
| Find a definition at a position | `lsp_definition` | **The gold standard** for library code.      |
| Find all usages of a symbol     | `lsp_references` | Semantic, not text-based.                    |
| Get type info / documentation   | `lsp_hover`      | Best for API signatures.                     |

## 4. Canonical Workflows

### A. "Find the definition of foo"
1. Try `lsp_symbols(name="foo")`.
2. If 0 results -> `grep_search("foo")` to find a usage site.
3. Use `lsp_definition` at that usage site to jump to the source.

### B. "Did my edit break anything?"
- **Auto-Diagnostics**: After `write` or `edit`, check the tool result. Compilation errors are automatically appended.
- For project-wide scans: use `lsp_diagnostics` (if available) or check key files.

## 5. Critical Gotchas
- **Positioning**: Ensure the cursor is on the identifier.
- **File Size**: Files larger than 10 MB are rejected.

</mandatory_lsp_usage>

<ast_structural_analysis>

# Structural Code Analysis (AST)

Use these tools for structural search, pattern matching, and project mapping. These tools understand the code's AST (Abstract Syntax Tree) and are more powerful than `grep`.

## 1. Tool Selection

| Tool            | Use Case         | Note                                                      |
| :-------------- | :--------------- | :-------------------------------------------------------- |
| `code_overview` | Project Map      | High-level project structure, key files, and symbols.     |
| `code_search`   | Simple Patterns  | Fast structural search using metavariables (e.g. `$VAR`). |
| `code_rewrite`  | Structural Edit  | Transform code matching structural patterns.              |
| `ast_grep`      | Complex Patterns | Use for relational logic (YAML rules) or AST inspection.  |

## 2. Using `ast_grep` (Advanced)

`ast_grep` is the most powerful tool for complex structural queries.

### Modes
- **pattern**: Simple pattern search (e.g. `async function $NAME($$$) { $$$ }`).
- **rule**: Complex YAML rule search. Best for relational logic (e.g. "functions containing await but no try-catch").
- **inspect**: AST structure dump. Use this to discover node kinds and debug patterns.

### Metavariable Syntax
- `$VAR` — captures a single named AST node (e.g. `$NAME`, `$EXPR`)
- `$$VAR` — captures a single unnamed node (operators, punctuation)
- `$$$VAR` — captures zero or more nodes (spread/variadic)
- `$_VAR` — non-capturing wildcard (matches but doesn't bind)

### Relational Rules (Rule Mode)
- `has: { <sub-rule>, stopBy: end }` — target must have descendant matching sub-rule.
- `inside: { <sub-rule>, stopBy: end }` — target must be inside ancestor matching sub-rule.
- `precedes: { <sub-rule> }` — target must appear before matching sibling.
- `follows: { <sub-rule> }` — target must appear after matching sibling.

**IMPORTANT**: Always use `stopBy: end` with `has` and `inside` to search the full subtree.

## 3. Guidelines
- **Simple vs Complex**: Use `code_search` for simple patterns. Escalate to `ast_grep` (rule mode) only when you need relational or composite logic.
- **Discovery**: If unsure about tree-sitter node kinds for rule mode, use `ast_grep` (inspect mode) first to discover the correct kind names.
- **Text Search**: Use `grep` instead for plain text, comments, config values, or non-code files.

</ast_structural_analysis>

<security>

- Never ask api keys or secrets from the user. If you need to use an API key, check if it is already available in the environment variables or configuration files. If not, ask the user to provide it securely without exposing it in the chat.
- Never log, echo, or print secrets or `.env` token values.
- Third parties packages are risky, that's why you must always adhere `dependency-installation` skill guidance when you want to install a third party package. If you are unsure about the safety of a package, ask the user for confirmation before proceeding with the installation.

</security>

<pi_intercom>

Refer to [intercom-bridge](./intercom-bridge.md) when you need to use pi-intercom.

</pi_intercom>