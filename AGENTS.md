<general_constraints>

- You must always provide factual and accurate information. If you are unsure about something, search for reliable sources before providing an answer.
- You do not guess when you can ask the user for clarification. If a request is ambiguous or missing critical details, use `ask_user_question` tool to ask the user specific questions to clarify before proceeding.
- Prefer breaking down complex tasks into todo lists and executing them step by step, rather than trying to do everything in one go.
- Use the `good-research` skill for factual research or delegate to researcher subagent when necessary.
- Firecrawl mcp is not available so use firecrawl-cli (available skills: `firecrawl`, `firecrawl-crawl`, `firecrawl-scrape`, `firecrawl-search`)
- Use `safe_bash` instead of `bash` for any bash commands. `safe_bash` blocks dangerous patterns (rm -rf /, sudo, mkfs, shutdown, reboot, etc.) and is available as an installed extension.
  
</general_constraints>

<coding-guidelines>

## Working in typescript

- when adding a package to a project add it with an install command, instead of manually editing the package json
- run check/format/lint commands when your done making a change. if they don't exist, suggest making them for the project you're in
- avoid running `dev` or `build` commands. if you really need to, ask first

</coding-guidelines>

<test-driven-development>

## Test Framework

- **Vitest is mandatory.** Use the `vitest` skill for all testing. Never use manual console.log test harnesses.
- Import the module under test directly — **never copy-paste functions** into the test file. Testing copies of code instead of real imports is the most common silent failure pattern: the copy diverges from the source, and errors like missing dependencies or broken imports go undetected.
- If an import cannot be resolved by the test runner (e.g. pi extension packages requiring jiti), **mock it with vi.mock()** — do not inline a copy. The goal is to exercise the real module and catch resolution errors at test time.

## Anti-Patterns (prohibited)

1. **Copy-pasting source functions into test files** — Tests must import the real module. Copies do not catch import errors, missing dependencies, or divergence.
2. **Skipping TDD because "the environment makes testing hard"** — If the env blocks imports, mock the blockers, don't bypass them.
3. **Testing pure helpers in isolation without testing the module that exports them** — The helpers are only useful if the consuming module loads correctly. Always have at least one test that imports the full module.

## Red-Green-Refactor

- Always follow the `tdd` skill: RED (failing test) → GREEN (minimal code) → REFACTOR.
- **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.**
- Write one minimal test showing what should happen. Watch it fail for the right reason. Then write the minimal code to make it pass.

## Mocking pi extensions

When a module imports from pi packages that require jiti (e.g., `@plannotator/pi-extension`, `@earendil-works/pi-coding-agent`), use Vitest's `vi.mock()` to stub them:

```ts
import { vi, describe, it, expect } from "vitest";

vi.mock("@plannotator/pi-extension/plannotator-browser.js", () => ({
  openPlanReviewBrowser: vi.fn(),
  openMarkdownAnnotation: vi.fn(),
  hasPlanBrowserHtml: vi.fn().mockReturnValue(false),
}));

// Now this import works — the real index.ts exercises real logic,
// only the pi-specific browser layer is mocked.
import { validatePlanPath } from "./index.ts";
```

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