# Context

This is the local installation of my [pi](https://pi.dev/) agent harness.
I'm working on it to customize it for my needs. This file contains instructions for how to use and modify the harness, as well as guidelines for code style, testing, and inter-agent communication.

While using pi myself, I installed some packages but noticed that they are not as good as I want. So I will be forking them, modifying them, and adding new features. This file will contain instructions for how to do that.

In order to help me at the best of your ability I never want you to guess anything. You must always explicitly refer to the available contexts to determine which direction to take. **Consider everything you know false until it is factually verified with supporting evidence.** You do not speculate, and you do not assume. You must always verify your assumptions, and if you cannot verify them, you must ask me for clarification.

Any modifications you need to make should take into account that an LLM is not reliable, and it's better to use skills and tools that work programmatically rather than only relying on the LLM's judgment.

## Context about pi

Always refer to the [ABOUT-PI.md](../docs/ABOUT-PI.md) file for an overview of the pi agent harness, its features, and how it can be customized with extensions, skills, prompt templates, and themes. This will help you understand the capabilities of the harness and how to leverage them effectively in your work.

**Pi Packages**: Pi packages bundle extensions, skills, prompt templates, and themes so you can share them through npm or git. A package can declare resources in package.json under the pi key, or use conventional directories. Refer to the [pi package documentation](https://pi.dev/docs/latest/packages) for details on how to structure and publish your own packages.

**Pi Extensions**: Extensions are TypeScript modules that extend pi's behavior. They can subscribe to lifecycle events, register custom tools callable by the LLM, add commands, and more. Refer to the [pi extensions documentation](https://pi.dev/docs/latest/extensions) for how to create and use extensions.
Placement for /reload: Put extensions in ~/.pi/agent/extensions/ (global) or .pi/extensions/ (project-local) for auto-discovery. Use pi -e ./path.ts only for quick tests. Extensions in auto-discovered locations can be hot-reloaded with /reload.

**Pi Sessions**: Sessions auto-save to `~/.pi/agent/sessions/`, organized by working directory. Each session is a JSONL file with a tree structure. Refer to the [pi sessions documentation](https://pi.dev/docs/latest/sessions) for how to work with sessions.

# General Instructions

- Always use `context7` coupled with `deepwiki` tools to check documentation about any package or module including pi itself.
- Always use `pi-extensions` skill for pi packages and extensions development.
- Always provide factual and accurate information. If you are unsure about something, search for reliable sources before providing an answer.
- Use the `factual-research` skill for factual research.
- Use the `pi-cli` skill for any questions regarding the `pi` command-line interface, flags, and automation.
- Firecrawl mcp is not available so use firecrawl-cli (some available skills: `firecrawl`, `firecrawl-crawl`, `firecrawl-scrape`, `firecrawl-search`)

# Folder structure

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

# ⚠️ Mandatory Workflow — Any Code Changes

You must follow these 3 phases **in order**, without skipping any. Each phase contains checklist steps. You only move on to the next phase when all the steps in the current phase are completed.

## Phase 1 — Discovery (before writing a single line of code)

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

## Phase 2 — Implementation (Required TDD)

1. **Write test first** (RED): a test that fails for the target functionality
2. **Write minimal code** (GREEN): just enough to pass the test
3. **Refactor** (REFACTOR): cleans up without breaking the tests
4. Runs the entire project test suite to confirm that everything passes

Absolute rule: **no production line without a test that fails first.**

## Phase 3 — Verification (Required before declaring complete)

1. Runs the project's **typecheck** (`tsc --noEmit` or equivalent)
2. Runs the project's **linter** (or install/configure one if it doesn't exist)
3. Runs all the project's **tests** — not just yours
4. Verifies that no unwanted artifacts are being tracked (lock files from the wrong package manager, build folders, etc.)

**Rule**: if any of these checks fail, you fix it before moving on to the next step.

# Coding guidelines

- Follow the existing code style and patterns in the project. Consistency is more important than personal preference.
- Write clear, concise code with meaningful variable and function names. Avoid unnecessary complexity.
- Document any non-obvious logic with comments. Assume the reader is familiar with the codebase but not with your specific implementation.
- Use `oxlint` (check oxlint skill) and eventually `oxfmt` for linting and formatting.
- Avoid duplicating code. If you find yourself copying and pasting, consider refactoring to create reusable functions or modules.
- Avoid running `dev` or `build` commands. If you really need to, ask first.

**Important** Remember to avoid duplication, that's the most common source of silent errors and maintenance issues. Always prefer importing real modules over copying code.

**Test Driven Development (TDD) is mandatory for any code changes.** Follow the TDD cycle: Write a failing test → Write minimal code to pass the test → Refactor → Run the test suite to confirm all tests pass (follow `tdd` skill).


<test-driven-development>

## Test Framework

- **`bun test` is prefered when applicable.** Use bun's native test runner (`bun:test` imports) for all testing — it's 10x faster startup and 2.5-8x faster execution than vitest. Never use manual console.log test harnesses.
- Import the module under test directly — **never copy-paste functions** into the test file. Testing copies of code instead of real imports is the most common silent failure pattern: the copy diverges from the source, and errors like missing dependencies or broken imports go undetected.
- If an import cannot be resolved by the test runner (e.g. pi extension packages requiring jiti), **mock it with `mock.module()`** — do not inline a copy. The goal is to exercise the real module and catch resolution errors at test time.

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