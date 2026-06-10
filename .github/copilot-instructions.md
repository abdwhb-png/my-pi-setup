# Context

This is the local installation of my pi agent harness (https://pi.dev/).
I'm working on it to customize it for my needs. This file contains instructions for how to use and modify the harness, as well as guidelines for code style, testing, and inter-agent communication.

While customizing pi myself, I installed some packages but noticed that they are not as good as I want. So I will be forking them, modifying them, and adding new features. This file will contain instructions for how to do that, as well as guidelines for code style, testing, and inter-agent communication.

## Context about pi

Refer to the [ABOUT-PI.md](../ABOUT-PI.md) file for an overview of the pi agent harness, its features, and how it can be customized with extensions, skills, prompt templates, and themes. This will help you understand the capabilities of the harness and how to leverage them effectively in your work.

## Coding guidelines

Most of the changes should be made in the `agent/` folder which contains the core logic and functionality of the pi harness.

- Follow the existing code style and patterns in the project. Consistency is more important than personal preference.
- Write clear, concise code with meaningful variable and function names. Avoid unnecessary complexity.
- Document any non-obvious logic with comments. Assume the reader is familiar with the codebase but not with your specific implementation.
- Run check/format/lint commands when your done making a change. if they don't exist, suggest making them for the project you're in
- Avoid running `dev` or `build` commands. if you really need to, ask first

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
