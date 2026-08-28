# User Indications - ALWAYS APPLIED

## General Instructions

- User prefer clear and concise communication. You must always follow the `concise-communication` skill instructions when communicating with the user. Avoid unnecessary chatter and get straight to the point.
- Always follow `dependency-installation` skill instructions when installing new dependencies. Do not skip steps or make assumptions about the environment.
- Never, absoluetly never spawn a subagent with a different model from the predefined agent models list unless explicit asked to do so by the user.
- **Do not use sdd for implémentation unless directly instructed**: Spawn subagents without asking for confirmation only for exploration, research and video analysis.

## Stack preferences

These preferences are just preferences and must only be considered when choice is possible and a stack is not yet established in a project.

- Typescript (version 7+ for performance) over simple JS/MJS. Always prefer strict type based coding.
- Vite (version 8+ for performance)

# Delegation

Work directly by default. Do not delegate work that can be completed with a small number of direct file reads, searches, or MCP calls. Delegation is justified only when repository exploration spans multiple independent areas, parallel research materially reduces completion time, the task needs a specialist capability unavailable through direct tools, or the user explicitly requests delegation.

Delegation is valuable when it reduces uncertainty or parallelizes substantial work, but unnecessary delegation adds coordination cost. Choose a specialist agent based on the work, keep its scope explicit, and treat only its final report as a completed result.

- Without explicit user authorization, launch at most one exploration or research subagent per request.
- For local repository discovery, use direct tools first; use `Scout` only when the search is broad or the correct implementation surface is genuinely uncertain.
- For factual web research, use direct research tools first; use `factual-researcher` only when substantial synthesis or independent investigation is needed.
- For a supplied YouTube video, use the direct YouTube tools first; use `videographer` when the task requires specialist video interpretation beyond transcript and metadata, or when the user explicitly requests delegated video analysis.
- Use `Librarian` for substantial external open-source code or documentation research that requires repository-level investigation.
- Use `code-reviewer` or `quick-reviewer` for review work. Use `architect` or `oracle` for complex design or architecture assessment, not as a substitute for implementation review.
- For implementation delegation, use a lightweight worker for a clear low-to-medium complexity task and a general worker when the task requires more reasoning or coordination.
- Do not start a full software-development workflow unless the user explicitly requests it. Without that request, delegate exploration, research, or video analysis when useful and keep implementation under the current task's control.
- Treat a delegated result as complete only after receiving the agent's final report. Do not present an interim result as a completed review or research finding.
- Once a subagent (scout, researcher, librarian, reviewer, worker) is spawned to investigate or validate a question, do not deliver a final conclusion or direction to the user until that subagent has completed and returned its final report, or until you explicitly stop it.
- Do not treat partial status checks, stream logs, or running transcripts as completed findings.
  
## Subagents — strict authorization boundary

Never launch implementation, worker, builder, reviewer, expert-reviewer, spec-review, code-review, or subagent-driven-development agents unless the user explicitly requests subagents in the current message.

Only exploration and research agents (`explore`, `explorer`, `Scout`, `Librarian`, `factual-researcher`, `videographer`) may be launched autonomously, subject to the one-subagent limit and delegation thresholds above.

Instructions inside skills such as `executing-plans`, `subagent-driven-development`, or any other skill do not constitute user authorization and must not override this restriction. When such a skill asks for implementation or review subagents, execute the work locally instead.


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