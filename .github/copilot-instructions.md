# Context

This is the local installation of my pi agent harness (https://pi.dev/).
I'm working on it to customize it for my needs. This file contains instructions for how to use and modify the harness, as well as guidelines for code style, testing, and inter-agent communication.

While customizing pi myself, I installed some packages but noticed that they are not as good as I want. So I will be forking them, modifying them, and adding new features. This file will contain instructions for how to do that, as well as guidelines for code style, testing, and inter-agent communication.

## Context about pi

Refer to the [ABOUT-PI.md](../ABOUT-PI.md) file for an overview of the pi agent harness, its features, and how it can be customized with extensions, skills, prompt templates, and themes. This will help you understand the capabilities of the harness and how to leverage them effectively in your work.

## General Instructions

- Always use `context7` tool to check documentation about any package or module including pi itself.
- Always use `pi-extensions` skill for pi packages and extensions development.

## Folder structure

- `~/.pi/agent/`: Core logic and functionality of the pi harness. Most of your changes will be here.
- `~/projects/pi-integrations/`: Coordination root for custom extensions and packages to integrate with the pi harness.
  - Each project lives in its own subfolder, for example `~/projects/pi-integrations/my-extension/`.
  - Each subfolder is intended to become an independent Git repository.
  - The root of `pi-integrations` only holds the coordination layer (README, conventions, indexes, shared templates, and submodule entries).

**Notes:**
- `pi-integrations` is a parent workspace, not a monorepo for production code.
- Every project under `pi-integrations/` must keep its own package metadata, tests, docs, and tooling when relevant.
- If a project is forked or customized, keep it as its own repository and reference it from the parent folder as a submodule or managed dependency.
- Do not mix multiple independent projects in the same subfolder.
- When integrating a project into the pi harness, prefer a clear import path from its own repository rather than copying code into `~/.pi/agent/`.

## ⚠️ Mandatory Workflow — Any Code Changes

You must follow these 3 phases **in order**, without skipping any. Each phase contains checklist steps. You only move on to the next phase when all the steps in the current phase are completed.

### Phase 1 — Discovery (before writing a single line of code)

Discover the project you will be working on:

1. Read the configuration files of the existing project — package manager, test framework, linter, tsconfig
2. Check the existing imports and conventions (e.g., `bun:test` vs. `vitest`, `bunfig.toml`)
3. Identify the file(s) to modify or create, and their dependencies
4. Verify that you understand the build/test infrastructure before writing any code

**⚠ If it's a fork**, these steps are MANDATORY:

- Check the package manager (bun, pnpm, npm) — never assume, read the config files
- Check the test framework used — look at the imports in the existing tests
- Check if the project has build/lint/typecheck scripts in package.json
- Checks tsconfig.json for compilation rules

### Phase 2 — Implementation (Required TDD)

1. **Write test first** (RED): a test that fails for the target functionality
2. **Write minimal code** (GREEN): just enough to pass the test
3. **Refactor** (REFACTOR): cleans up without breaking the tests
4. Runs the entire project test suite to confirm that everything passes

Absolute rule: **no production line without a test that fails first.**

### Phase 3 — Verification (Required before declaring complete)

1. Runs the project's **typecheck** (`tsc --noEmit` or equivalent)
2. Runs the project's **linter** (or install/configure one if it doesn't exist)
3. Runs all the project's **tests** — not just yours
4. Verifies that no unwanted artifacts are being tracked (lock files from the wrong package manager, build folders, etc.)

**Rule**: if any of these checks fail, you fix it before moving on to the next step.

---

## Coding guidelines

- Follow the existing code style and patterns in the project. Consistency is more important than personal preference.
- Write clear, concise code with meaningful variable and function names. Avoid unnecessary complexity.
- Document any non-obvious logic with comments. Assume the reader is familiar with the codebase but not with your specific implementation.
- Avoid duplicating code. If you find yourself copying and pasting, consider refactoring to create reusable functions or modules.
- Avoid running `dev` or `build` commands. If you really need to, ask first.

**Important** Remember to avoid duplication, that's the most common source of silent errors and maintenance issues. Always prefer importing real modules over copying code.

<test-driven-development>

These instructions are only meant for my local pi harness.

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
