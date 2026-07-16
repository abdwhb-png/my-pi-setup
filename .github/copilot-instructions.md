## Pi Harness Development

**PREFERRED DELEGATION FOR PI-SPECIFIC WORK:** When a task requires understanding or changing `pi` runtime behavior, APIs, types, extension mechanisms, package integration, or harness architecture, prefer delegating discovery and architectural verification to the `pi-expert` agent using the `runSubagent` tool.

Do not invoke `pi-expert` merely because a file is located under `~/.pi/`. Wording-only edits, general documentation, agent instructions, prompts, skills, themes, and unrelated configuration changes do not require `pi-expert` unless they depend on Pi-specific behavior or contracts.

If `pi-expert` is unavailable or fails to provide usable guidance, delegate to another suitable subagent such as `Explore`, `Codebase Scout`, `Oracle`, or `Librarian`. If no suitable subagent is available or delegation fails, self-exploration is allowed. In every case, verify assumptions against the local harness code, `docs/ABOUT-PI.md`, official documentation, or the upstream `earendil-works/pi` repository. Never guess `pi` APIs, types, or architecture.

**Workflow:**
1. Try `pi-expert` first for discovery and architectural verification.
2. If it is unavailable or unsuccessful, use another suitable subagent.
3. If delegation is not possible, document a brief evidence-based exploration plan and investigate directly.
4. Use the verified findings to perform the actual implementation.

## Agent context (always read)

- [AGENTS.md](../AGENTS.md)
- [agent/AGENTS.md](../agent/AGENTS.md)
