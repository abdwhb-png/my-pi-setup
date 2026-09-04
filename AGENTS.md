# .pi/AGENTS.md

Apply these instructions only when working in the local Pi harness repository. Use [ABOUT-PI.md](./docs/ABOUT-PI.md) when a task requires a general Pi architecture overview.

## Context

This is the local installation of my [pi](https://pi.dev/) agent harness. Interpret `pi` as the Pi agent harness, not Raspberry Pi.
I'm working on it to customize it for my needs. This file contains instructions for how to use and modify the harness, as well as guidelines for code style, testing, and inter-agent communication.

While using pi myself, I installed some packages but noticed that they are not as good as I want. So I will be forking them, modifying them, and adding new features. This file will contain instructions for how to do that.

## Pi repository invariants

- Never patch the global Bun installation to fix a Pi package issue. Prefer a Pi extension, wrapper, explicit finalizer, or repository-managed symlink.
- Use the `pi-extensions` skill for Pi package and extension development and the `pi-cli` skill for Pi command-line flags or automation.
- Before trusting a Pi package E2E result, verify the concrete package root resolved at runtime: installed `node_modules`, Git clone, or local path.
- Treat `agent/settings.json` as the model-configuration source of truth for `pi-subagents` unless the configured model is factually unavailable in the harness.
- **NEVER SPECULATE ON PI TYPES**: Inspect Pi's installed source or exported types before using a framework type or property. Never speculate about Pi internals or repair uncertainty with unsupported casts. That ensure the correct types are imported.
- Interract autonomously with `pi-expert` subagent as an explorer for clarification on pi.

## Workspace boundaries

- `~/.pi/agent/` contains the installed harness logic and global Pi resources.
- `~/projects/pi-integrations/` coordinates independent custom extension repositories; it is not a production-code monorepo.
- `~/projects/shared-services/` contains cross-project infrastructure and external forks, not Pi extensions.
- Keep each independent project in its own repository with its own package metadata, tests, documentation, and tooling. Integrate it through a clear package or import path instead of copying it into `~/.pi/agent/`.

## Guidelines and Best Practices

- Follow the existing code style and patterns in the project. Consistency is more important than personal preference.
- Write clear, concise code with meaningful variable and function names. Avoid unnecessary complexity.
- Document any non-obvious logic with comments. Assume the reader is familiar with the codebase but not with your specific implementation.
- Avoid duplicating code. If you find yourself copying and pasting, consider refactoring to create reusable functions or modules.
- Pi loads extension entrypoints through separate Jiti instances with `moduleCache:false`. Share cross-extension state through a process-global registry using `globalThis` with `Symbol.for(...)` or through Pi's shared event bus; never rely on a normal module singleton or key state by `ExtensionAPI` wrapper identity.

**Important** Remember to avoid duplication, that's the most common source of silent errors and maintenance issues. Always prefer importing real modules over copying code.

### Paths and TUI input

- Persist and document home-relative paths as `~/…`; expand them with `homedir()` before filesystem or child-process I/O. Never hardcode `/home/<user>` in tracked files or tests.
- In `Component.handleInput()`, recognize supported `@earendil-works/pi-tui` keys with `matchesKey()` and `Key`, not raw terminal strings. Document and test any unavoidable raw comparison.
- After an input mutates visible component state, call `tui.requestRender()`. Test legacy terminal sequences and Kitty CSI-u encodings for special and navigation keys.

### Tool groups and contextual visibility

- Prefer named groups from `agent/tool-groups.json` when configuring tools for agents, roles, extensions, or subagent overrides. Use aliases such as `@inspect`, `@review`, `@implement`, or `@lens` when an existing group fits.
- Enumerate individual tools only when no group fits or a security boundary requires an exact least-privilege allowlist. Document that exception.
- Hide workflow-, phase-, role-, and specialist-specific tools from the active LLM schema by default. Expose them only after an explicit current-session entry action and remove them on stop, completion, cancellation, reset, or unrelated reload.
- Keep hard `tool_call` execution gates because visibility is not enforcement. Test both the hidden baseline and explicit activation through the real Pi runtime boundary.

## Package commands and linting

- Treat every shell call as an independent process. Select the package root in the same invocation, for example `bun --cwd=~/.pi/agent run lint` or `cd ~/.pi/agent && bun run lint`.
- Use package scripts for package-wide checks so Bun resolves repository-owned binaries from `node_modules/.bin`. Invoke a local binary directly only when no script can express the focused check.
- Run oxlint through the repository script: use `bun run lint`, not `bunx oxlint`, because the latter may resolve a cached binary with incompatible native bindings.
- Use `bun run lint` for routine checks. It reports warnings without blocking.
- Use `bun run lint:check` only when a strict zero-warning gate is required; it passes `--deny-warnings` and exits non-zero on warnings.
- Do not run `dev` or `build` merely as a routine post-edit check. Run them when the task, repository contract, or required validation actually depends on them.

### Package-boundary lint warnings

Some Pi APIs intentionally expose generics that default to `unknown`. When oxlint reports a warning at a package boundary:

1. Inspect the type origin in `@earendil-works/pi-coding-agent` or the owning package.
2. Replace `unknown` with a concrete publicly exported Pi type such as `GrepToolDetails` or `FindToolDetails` when one exists.
3. Inspect the installed `.d.ts` files under `node_modules/@earendil-works/pi-coding-agent/dist/`; never guess the type.
4. If the required type is not exported or the generic cannot be eliminated without breaking typecheck, add a narrow `// oxlint-disable-next-line <rule>` with a short package-boundary rationale.

Do not chase zero warnings at the expense of type safety. For example, `makeRenderResult` in `pi-overrides/index.ts` requires boundary casts because `ToolRenderContext` is not publicly exported.

## Pi extension tests

### Runner and imports

- Prefer `bun:test` when applicable. Never create manual `console.log` test harnesses.
- Run the agent test suite with `agent/` as Bun's working directory so it loads `agent/bunfig.toml`:
  - From `~/.pi/agent`: `bun test --isolate`.
  - From `~/.pi`: `bun --cwd=~/.pi/agent test --isolate`.
  - Never use `bun test agent` from the parent directory; it bypasses `agent/bunfig.toml` and discovers vendored tests under `agent/git/**`.
- Import the real module under test. Never copy implementation functions into a test.
- If a Pi package import requires Jiti and cannot load directly, use `mock.module()` and dynamically import the real module after installing the mock.

```ts
import { expect, mock, test } from "bun:test";

mock.module("@plannotator/pi-extension/plannotator-browser.js", () => ({
  openPlanReviewBrowser: mock(),
  openMarkdownAnnotation: mock(),
  hasPlanBrowserHtml: mock().mockReturnValue(false),
}));

const { validatePlanPath } = await import("./index.ts");
```

`mock.module()` is not hoisted. A static import does not reliably observe a mock registered earlier in source order; use `await import(...)` after mock setup.

### Test placement

- For a single-file extension directly under `agent/extensions/`, place tests in `agent/extensions/__tests__/`; otherwise Pi may auto-discover the test as an extension.
- For a directory-form extension, Pi loads only its `index.ts`, so tests may live beside its source files.

### Plain `bun:test` versus `@abdwhb-png/pi-test-harness`

Use `bun:test` with `mock.module()` for pure helpers, configuration parsing, string or JSON transforms, isolated import verification, and type-shape checks.

Use `@abdwhb-png/pi-test-harness` only when the test must exercise real Pi runtime wiring, including:

- the `pi.registerTool(...)` execution pipeline;
- blocking or mutation through `tool_call` or `tool_result` hooks;
- multi-turn agent flow or `turn_end` and `agent_end` gates;
- branching through `ctx.ui.confirm`, `select`, `input`, or `editor` using `mockUI`;
- an extension that spawns `pi` and requires the harness PATH shim.

If removing Pi's runtime would allow the test to pass without exercising the defect, use the harness. Otherwise prefer plain `bun:test`.

Harness limitations and release boundaries:

- `MockUIConfig` does not cover `ctx.ui.custom(...)`; test overlay handlers in isolation.
- Upstream harness CI is Vitest-only. Smoke-test the first `bun:test` integration before relying on Bun-specific process-exit or PATH-shim behavior.
- `verifySandboxInstall` performs `npm pack` and `npm install`; use it as a release gate, not a routine per-change check.

## Model configuration verification

Before adding or changing an ai provider model, verify  `contextWindow`, `maxTokens`, cost, input modalities, and reasoning support against the provider's current official documentation or API, or a trusted aggregator such as the OpenRouter API.

1. Identify the underlying provider model rather than inferring from a local alias.
2. Verify context length, maximum output, and modalities from the source.
3. Record subscription/OAuth models as zero marginal API cost only when that billing assumption is confirmed; use the relevant provider pricing for OpenCode Go and OpenRouter models.
4. Never copy specifications from another model or assume default token limits.
5. **Do not guess model specs:** Assuming `contextWindow: 1000000` or `maxTokens: 8192` as defaults is incorrect. Each model has specific, documented limits.

## ANTI PATTERNS

- **Guess or Speculate about PI framework internals:** Avoid making assumptions about the internal behavior or structure of the PI framework. **Solution:** Ask `pi-expert` or refer to the official documentation.
- **Speculating with casts and generic gymnastics where the real fix is simpler**. **Solution:** Let TypeScript infer the parameter types directly from the framework's types. For example, if a pi extension tool expects `ToolDefinition` from `@earendil-works/pi-coding-agent`, do not cast or wrap it in a generic. Import the type and use it directly (e.g., `import type { ToolDefinition } from "@earendil-works/pi-coding-agent";`).
- **Copying code instead of importing modules:** Never copy-paste functions or classes from other modules into your test or implementation. **Solution:** Import the real module to ensure you are testing the actual code and catching any dependency or resolution issues.
- **Writing tests for extensions under `agent/extensions/`:**
  - **Single-file extensions** (a `.ts` directly under `agent/extensions/`): pi auto-discovers any `.ts` file there, so placing a test file next to it would be loaded as an extension and fail. **Place tests in `agent/extensions/__tests__/`** instead.
  - **Directory-form extensions** (a subfolder like `agent/extensions/my-ext/`): pi only loads `index.ts` from the subfolder. Test files can sit alongside source files safely.

## Additional resources

- Consider [MEMORY.md](./MEMORY.md) when past Pi decisions or user preferences could affect the task.
- Skills specific to Pi may also exist under `agent/skills`.
