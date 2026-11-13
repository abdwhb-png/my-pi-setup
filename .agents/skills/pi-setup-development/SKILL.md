---
name: pi-setup-development
description: Develop and validate changes to this repository's personal Pi setup, including extensions, launchers, configuration, tool policies and terminal UI. Use for setup features, fixes and refactors that must include user-facing discovery and runtime integration. Not for unrelated projects or standalone Pi usage questions; release operations use pi-setup-release.
---

# Pi setup development

## When to use

Use this workflow when changing the personal Pi setup maintained by this repository. A working implementation can still be incomplete when its CLI help, command description, configuration path, role policy or installed runtime does not expose the change. Deliver the requested behavior through the interface the user actually uses.

## When not to use

For a standalone CLI explanation, use `pi-cli` when available. For an independent extension repository, follow that repository's workflow and use `pi-extensions` for framework behavior. For promotion, packaging or publication, use [pi-setup-release](../pi-setup-release/SKILL.md). A design-only request stays design-only; none of these workflows expands the user's authorization.

## Establish the delivery boundary

Read the repository [AGENTS.md](../../../AGENTS.md) and the relevant part of [About my Pi](../../../docs/ABOUT-MY-PI.md). They own repository conventions and runtime boundaries; do not copy their rules into another checklist or configuration layer. Use `tdd`, `pi-cli`, [pi-extensions](../pi-extensions/SKILL.md) and [pi-test-harness](../pi-test-harness/SKILL.md) only for the work that needs them.

Before editing, identify the current behavior, its owning implementation, the user entrypoint and the intended activation step. Inspect existing modules and public Pi APIs first. Trace execution order when it determines the solution: a launcher option that prevents extension imports must act before factories run; a session-start handler cannot undo their side effects. Keep the core fork independent of setup-specific packages and minimize any explicitly authorized fork change.

Use the conversation's accepted requirements as acceptance criteria. Resolve discoverable facts from code and configuration, and ask only about material preferences that remain undecided. If scope is ambiguous, inspect the existing feature before proposing a new owner or configuration system. Preserve unrelated working-tree changes and personal state.

## Complete the changed interface

For each affected surface, include its implementation, discovery, configuration and verification in the same change. Select only applicable rows; do not run an unrelated audit or add speculative options.

| Changed surface | Delivery checks |
| --- | --- |
| CLI or launcher | Expose the option in the help owned by that entrypoint, document its syntax and precedence, and exercise the real executable. Use Pi's public parser where applicable so option values and `--` do not become flags accidentally. Launcher-owned help must remain discoverable when extensions are disabled. |
| Extension command or tool | Update its registered description, usage, completions when applicable, and maintained documentation. Verify registration and behavior through the public extension entrypoint rather than a copied helper. A command's help must explain when its effect becomes active. |
| User configuration | Reuse the existing owner in `agent/extensions/_shared/config-owners.mts` and its loader; add an owner when introducing a new owned file. Define defaults, scope and invalid-input behavior. Provide a usable example or editor flow when configuration is part of the request. Exercise user customization with temporary fixtures, not personal files. |
| Footer or TUI | Inspect the existing integration and reuse `agent/extensions/_shared/fancy-footer.ts` for footer contributions and `agent/extensions/_shared/ui/ui-colors.ts` for semantic text roles. Preserve requested icons and identifying information. Test visibility and lifecycle transitions such as model changes, session switches and reload when affected; inspect the real rendering for visual changes. |
| Tool visibility or policy | Trace registration, named groups, role/workflow selection and the actual outgoing catalogue. Test both schema visibility and execution enforcement, including affected child sessions and activation/stop/reload transitions. A current `/context` view alone does not prove what an earlier request received. |
| Provider or model behavior | Identify the underlying provider and inspect the installed public contracts. Verify changed capabilities or request fields against current authoritative evidence. Keep provider transport behavior with its owner rather than making an unrelated UI extension own it. |
| Package or runtime integration | Verify the declared package source and concrete resolved root. Determine whether reload, restart, package installation or fork promotion is needed. A passing source test does not establish that the daily runtime contains the change. |

Keep shared behavior authoritative in its existing module. Do not duplicate resolution, parsing, policy, persistence or configuration just to connect another caller. Update the affected callers and interfaces together while keeping independent extension owners separate.

## Verify the complete path

Start with a failing test at the integration boundary for a behavior change; use narrow tests for pure branching or parsing. Include the user-visible result, relevant side effects and failure states. For example, a launch exclusion is verified by an entrypoint that would execute if filtering failed, and its help is verified by invoking the launcher with extensions disabled. Neither an argument-array assertion alone nor an isolated formatter proves the complete feature.

Use the repository's focused checks first, then the checks required by the touched ownership boundary. Apply the validation cadence in AGENTS.md; do not repeatedly run the whole project between routine edits. Keep installed-runtime and personal-configuration probes explicit and isolated. Report actual checks and failures without changing unrelated packages or weakening assertions to make a gate pass. Documentation-only work needs no manufactured failing test.

Before reporting completion, walk from the user's entrypoint through discovery, configuration, execution and activation. Close any missing part within the authorized task. If daily activation is requested, perform and verify the appropriate existing operation; do not stop at source implementation. If activation is outside scope, state the exact remaining step without claiming the daily setup is updated.

Report the resulting behavior and how to use it, the verification performed and any remaining limitation. Distinguish source changes, daily activation, commits and publication only where relevant to the task. Keep the response concise; an internal delivery checklist does not need to become a long user-facing report.
