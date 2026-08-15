# .pi/agent/AGENTS.md

**Consider everything you know false until it is factually verified with supporting evidence.** You do not speculate, and you do not assume. You must always verify your assumptions, and if you cannot verify them, you must notify it.

<general-constraints>

- You must always provide factual and accurate information. If you are unsure about something, search for reliable sources before providing an answer.
- You do not guess when you can ask the user for clarification. If a request is ambiguous or missing critical details, use `ask_user_question` tool to ask the user specific questions to clarify before proceeding.
- Always use `context7` mcp coupled with `deepwiki` mcp when you need library/API documentation, code generation, setup or configuration steps without having to explicitly ask.
- Prefer breaking down complex tasks into todo lists and executing them step by step, rather than trying to do everything in one go.
- Use `documentation-and-adrs` skill for documentation and architectural decision records (ADRs) when necessary.
- When you write an ADR or a documentation, always lookup for already present file so you can name the file you want to add correctly.
- Use the `factual-research` skill for factual research or delegate to researcher subagent when necessary.
- Use `safe_bash` instead of `bash` for any bash commands. `safe_bash` blocks dangerous patterns (rm -rf /, sudo, mkfs, shutdown, reboot, etc.) and is available as an installed extension.
- For Pi package debugging, always verify which concrete package root is actually resolved at runtime (`node_modules`, git clone, local path) before trusting an E2E result.

</general-constraints>


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

1. **LSP diagnostics** — Run `lsp_diagnostics` at the end of the changed files. This catches type errors before tests even run.
2. **Run focused tests** — At minimum the test files in the changed directory, ideally the full focused suite.

These 2 steps MUST execute in Phase 3 (Verification) after all code changes. If a file has no test that imports it, that's a gap — add an import test.

### Anti-Patterns (prohibited)

1. **Copy-pasting source functions into test files** — Tests must import the real module. Copies do not catch import errors, missing dependencies, or divergence.
2. **Skipping TDD because "the environment makes testing hard"** — If the env blocks imports, mock the blockers, don't bypass them.
3. **Testing pure helpers in isolation without testing the module that exports them** — The helpers are only useful if the consuming module loads correctly. Always have at least one test that imports the full module.
4. **Detaching methods from class instances** (`const f = obj.method; f()`) — In TypeScript, class methods lose `this` when detached. Always call methods directly (`obj.method()`) or use arrow-function class fields. Tests must explicitly verify this pattern if a public API returns a method reference.


## Important Notes
- Always follow `dependency-installation` skill instructions when installing new dependencies. Do not skip steps or make assumptions about the environment.

