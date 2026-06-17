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

# LSP Semantic Navigation with pi-lsp-extension

The pi-lsp-extension provides native LSP (Language Server Protocol) tools for code intelligence. LSP servers start lazily on first use.

**Hard Rules:**
- **LSP First**: Prefer LSP tools over text search for anything code-shaped.
- **Absolute Paths**: All file paths MUST be absolute.
- **1-Indexed**: All line/column numbers are 1-indexed.
- **Text Search**: Use `grep_search`/`read_file` ONLY for strings, comments, config files, and docs.
- **Auto-diagnostics**: After `write`/`edit`, errors are auto-appended — no need for a separate diagnostics call.

## Tool Reference

| If you want to...                         | Use this Tool               | Notes                                                       |
| :---------------------------------------- | :-------------------------- | :---------------------------------------------------------- |
| Find a symbol by name across workspace    | `lsp_find_symbol`           | Takes just a `query` string, no file path needed            |
| List symbols in a file / search workspace | `lsp_symbols`               | Pass `path` for file symbols, `query` for workspace search  |
| Find a definition at a position           | `lsp_definition`            | Use `query` param instead of line/character for convenience |
| Find the type/interface of a var          | `lsp_goto_type_definition`  | `query` param supported                                     |
| Find all usages of a symbol               | `lsp_references`            | `includeDeclaration` param available                        |
| Find concrete implementations             | `lsp_find_implementations`  | For interfaces/abstract classes                             |
| Get type info / documentation             | `lsp_hover`                 | `query` param supported                                     |
| Check for errors/warnings in a file       | `lsp_diagnostics`           | Pass `path="*"` for workspace-wide                          |
| Check all errors across project           | `lsp_workspace_diagnostics` | Filter by `severity` or `language`                          |
| Preview rename refactoring                | `lsp_rename`                | Returns planned edits without applying                      |
| Get code completion suggestions           | `lsp_completions`           | At a position                                               |
| Apply quick fixes / refactorings          | `lsp_code_actions`          | Filter by `kind` (quickfix, refactor, source)               |
| Project structure & key symbols           | `code_overview`             | Tree-sitter based                                           |
| Structural code search                    | `code_search`               | AST patterns with metavariables                             |
| Structural find-and-replace               | `code_rewrite`              | AST-based transformations                                   |

## Navigation Strategy

### Find a definition
1. Try `lsp_find_symbol(query="Foo")` to find where `Foo` is defined.
2. If 0 results → `grep_search("Foo")` to find a usage site.
3. Use `lsp_definition` at that usage site.

### Check for errors after editing
Auto-diagnostics handle this — check the tool result for appended errors.

## Fallback Policy
LSP first. Fallback to `grep_search`/`read_file` ONLY when:
1. The LSP tool returned an error or no results after trying both `lsp_find_symbol` and position-based tools.
2. You're searching for plain text, comments, or config values.
3. The file type has no LSP server configured.

**Prohibited**: using `grep` to find a function definition. Use `lsp_find_symbol` or `lsp_definition` instead.

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