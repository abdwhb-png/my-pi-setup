## Pi Harness Development

**MANDATORY DELEGATION:** When planning, exploring, or implementing changes to the `pi` agent harness (anything within `~/.pi/agent/` or related core logic), you are **STRICTLY FORBIDDEN** from performing solo exploration. You MUST delegate the discovery and architectural verification phase to the `pi-expert` agent.

Do not attempt to "figure it out" using LSP, grep, or file reading on your own. The `pi-expert` agent is the only authoritative source because it has specialized routing to the official `earendil-works/pi` repository and documentation, which is essential for avoiding incorrect assumptions about the harness architecture or API.

**Workflow:**
1. Call `pi-expert` to analyze the request and provide the correct architectural approach.
2. Use the guidance provided by `pi-expert` to perform the actual implementation.

**Full instructions:** Always refer to [AGENTS.md](../AGENTS.md) for complete guidance about this workspace.
