# User Indications

## General Instructions

- User prefer clear and concise communication. You must always follow the `concise-communication` skill instructions when communicating with the user. Avoid unnecessary chatter and get straight to the point.
- Always follow `dependency-installation` skill instructions when installing new dependencies. Do not skip steps or make assumptions about the environment.
- Never, absoluetly never spawn a subagent with a different model from the predefined agent models list unless explicit asked to do so by the user.
- **Do not use sdd for implémentation unless directly instructed**: Spawn subagents without asking for confirmation only for exploration, research and video analysis.

## Stack preferences

These preferences are just preferences and must only be considered when choice is possible and a stack is not yet established in a project.

- Typescript (version 7+ for performance) over simple JS/MJS. Always prefer strict type based coding.
- Vite (version 8+ for performance)

# Coding Instructions

## Working in typescript

- when adding a package to a project add it with an install command, instead of manually editing the package json
- Run check/format/lint commands when your done making a change. if they don't exist, suggest making them for the project you're in
- Avoid running `build` commands like `npm run build` for each changes. Only build after a very substantial change to verify that the build succeeds.

## TDD

**Test Driven Development (TDD) is mandatory for any production behavior change, bug fix, domain rule, or workflow transition.** Follow the TDD cycle: Write a failing test → Write minimal code to pass the test → Refactor → Run the test suite to confirm all tests pass (follow `tdd` skill).

Documentation-only edits do not require a failing automated test. Pure tooling or configuration changes still require an executable before-and-after validation when feasible. If a production change genuinely cannot begin with an automated failing test, stop and obtain explicit user approval for the exception.

### Red-Green-Refactor

Follow the `tdd` skill: RED (failing test) → GREEN (minimal code) → REFACTOR.
Write one minimal test showing what should happen. Watch it fail for the right reason. Then write the minimal code to make it pass.

- Write one minimal test through the public boundary that should own the behavior.
- Import the real production module. Mock only nondeterministic or external boundaries.
- Observe the test fail for the expected missing behavior before changing production code.
- Implement only what the failing test requires; never weaken a correct assertion to obtain green.

### Anti-Patterns (prohibited)

1. **Copy-pasting source functions into test files** — Tests must import the real module. Copies do not catch import errors, missing dependencies, or divergence.
2. **Skipping TDD because "the environment makes testing hard"** — If the env blocks imports, mock the blockers, don't bypass them.
3. **Testing pure helpers in isolation without testing the module that exports them** — The helpers are only useful if the consuming module loads correctly. Always have at least one test that imports the full module.
4. **Detaching methods from class instances** (`const f = obj.method; f()`) — In TypeScript, class methods lose `this` when detached. Always call methods directly (`obj.method()`) or use arrow-function class fields. Tests must explicitly verify this pattern if a public API returns a method reference.

## Security and Safety

- Never ask api keys or secrets from the user. If you need to use an API key, check if it is already available in the environment variables or configuration files. If not, ask the user to provide it securely without exposing it in the chat.
- Never log, echo, or print secrets or `.env` token values.
- Third parties packages are risky, that's why you must always adhere `dependency-installation` skill guidance when you want to install a third party package. If you are unsure about the safety of a package, ask the user for confirmation before proceeding with the installation.

## Subagent wait guard

The `extensions/subagent-wait-guard` extension programmatically enforces the delegation rule "do not finalize an answer while delegated subagent runs are in flight":

- `message_end`: a final assistant prose answer produced while async subagent runs are active is replaced with a `[subagent-wait-guard]` blocked notice.
- `turn_end`: a follow-up user message forces the agent to call `subagent_wait({ all: true })` and incorporate final reports before answering.

If its interventions look like bugs (withheld answers, repeated "[subagent-wait-guard]" prompts), that is intentional enforcement, not malfunction. Disable with `PI_SUBAGENT_WAIT_GUARD=off` then `/reload`. Consecutive interventions cap at 10 (5 turns); design record: `docs/brainstorms/2026-08-23-programmatic-enforcement-of-subagent-wait/design.md`.
