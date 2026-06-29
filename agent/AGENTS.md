<general_constraints>

- You must always provide factual and accurate information. If you are unsure about something, search for reliable sources before providing an answer.
- You do not guess when you can ask the user for clarification. If a request is ambiguous or missing critical details, use `ask_user_question` tool to ask the user specific questions to clarify before proceeding.
- Always use `context7` coupled with `deepwiki` when I need library/API documentation (including pi), code generation, setup or configuration steps without me having to explicitly ask.
- Prefer breaking down complex tasks into todo lists and executing them step by step, rather than trying to do everything in one go.
- Use the `factual-research` skill for factual research or delegate to researcher subagent when necessary.
- Firecrawl mcp is not available so use firecrawl-cli (some available skills: `firecrawl`, `firecrawl-crawl`, `firecrawl-scrape`, `firecrawl-search`). Firecrawl-cli being a cli tool it must be used with bash!
- Use `safe_bash` instead of `bash` for any bash commands. `safe_bash` blocks dangerous patterns (rm -rf /, sudo, mkfs, shutdown, reboot, etc.) and is available as an installed extension.
  
</general_constraints>

<pi-intercom>

Coordinate with other local pi sessions on related codebases. Use `/skill:pi-intercom` for patterns.

**When:** Same codebase (parallel work), reference codebase (consulting patterns), related repos (shared libraries).

**Not when:** Unrelated codebases, trivial questions, or when you can proceed independently.

**Principle:** Prefer `send` for notifications; `ask` only when blocked waiting for input.

</pi-intercom>

# Coding Instructions

## Working in typescript

- when adding a package to a project add it with an install command, instead of manually editing the package json
- run check/format/lint commands when your done making a change. if they don't exist, suggest making them for the project you're in
- avoid running `dev` or `build` commands. if you really need to, ask first

## TDD

**Test Driven Development (TDD) is mandatory for any code changes.** Follow the TDD cycle: Write a failing test → Write minimal code to pass the test → Refactor → Run the test suite to confirm all tests pass (follow `tdd` skill).

### Red-Green-Refactor

- Always follow the `tdd` skill: RED (failing test) → GREEN (minimal code) → REFACTOR.
- **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.**
- Write one minimal test showing what should happen. Watch it fail for the right reason. Then write the minimal code to make it pass.

## Post-edit verification (MANDATORY after every edit)

1. **Parse-check every edited file** — Run `node --check <file>` on every `.ts`/`.js` file modified. This catches stray characters, unterminated strings, and syntax errors that `bun test` won't see unless the file is imported by a test.
2. **LSP diagnostics** — Run `lsp_diagnostics` on every changed file. This catches type errors before tests even run.
3. **Run all tests** — At minimum the test files in the changed directory, ideally the full suite.

These 3 steps MUST execute in Phase 3 (Verification) after every code change. If a file has no test that imports it, that's a gap — add an import test.

### Anti-Patterns (prohibited)

1. **Copy-pasting source functions into test files** — Tests must import the real module. Copies do not catch import errors, missing dependencies, or divergence.
2. **Skipping TDD because "the environment makes testing hard"** — If the env blocks imports, mock the blockers, don't bypass them.
3. **Testing pure helpers in isolation without testing the module that exports them** — The helpers are only useful if the consuming module loads correctly. Always have at least one test that imports the full module.
4. **Detaching methods from class instances** (`const f = obj.method; f()`) — In TypeScript, class methods lose `this` when detached. Always call methods directly (`obj.method()`) or use arrow-function class fields. Tests must explicitly verify this pattern if a public API returns a method reference.


<mandatory-lsp-usage>

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

</mandatory-lsp-usage>

<ast-structural-analysis>

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

</ast-structural-analysis>
  

## Important Notes
- Always follow `dependency-installation` skill instructions when installing new dependencies. Do not skip steps or make assumptions about the environment.
- You must not proceed to implementation unless explicitly asked to do so by the user. Always ask for confirmation before starting implementation.

## Additional Context
- [Context](./CONTEXT.md)
