# Pi Dangerous Mode and Unattended

`pi-dangerous-mode` exposes two independent session modes:

- **Dangerous** auto-allows eligible permission asks and bypasses unprotected extension `tool_call` blockers.
- **Unattended** suppresses blocking human prompts during agent work. It does not bypass permissions, inject follow-up turns, decide task completion, or authorize external actions.

Dangerous behavior remains defined by [ADR-013](../../../docs/adr/ADR-013-pi-dangerous-mode-authorizer-chain.md). Unattended behavior is defined by ADR-018.

## Activation

| Surface | Dangerous | Unattended |
| --- | --- | --- |
| CLI flag | `--dangerously-skip-permissions` | None |
| Command | `/dangerous-mode on\|off\|status` | `/unattended on\|off\|status` |

Both commands affect only current session. Explicit command state survives `/reload` and resets for new, resumed, and forked sessions.

## Prompt interception

While Unattended is on:

- `ask_user_question` is blocked before extension handlers execute.
- `ExtensionUIContext.select`, `confirm`, `input`, and `editor` throw `UNATTENDED_PROMPT_BLOCKED` before UI renders.
- `custom()` is blocked only during active agent work. Idle user dashboards remain available.

The block message directs the agent to select only a safe, reversible path supported by current context and not repeat the prompt. If no such path exists, agent must end normally with concrete blocker. Unattended never invents user preference or approval.

UI created outside `ExtensionUIContext` is outside interception contract.

## State and limits

Dangerous and Unattended are independent. Enabling Unattended does not enable Dangerous. Widget shows each effective state separately.

Unattended does not inspect plans, extract objectives, register completion tools, inject messages, count turns, retry errors, enforce duration budgets, or guard external actions. Use `extensions/until.ts` for explicit looping.

## Configuration

Global configuration: `~/.pi/agent/pi-dangerous-mode.json`

Project configuration: `<cwd>/.pi/pi-dangerous-mode.json`

```json
{
    "protectedTools": [],
    "protectedExtensions": []
}
```

These lists only preserve selected extension blockers under Dangerous mode. Project lists override declared global lists. Patterns support `*` globs.

## Verification

From `~/.pi/agent`:

```bash
bun test --isolate extensions/pi-dangerous-mode
```
