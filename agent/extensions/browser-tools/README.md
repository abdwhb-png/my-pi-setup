# Browser Tools

Local Pi wrapper for `pi-agent-browser-native@0.6.10`.

The upstream package owns the `agent_browser` implementation and Chromium lifecycle. This wrapper only controls model access:

- hidden by default;
- `/browser-tools on` grants access for the current session;
- `/browser-tools off` revokes that grant;
- `/browser-tools status` reports `hidden`, `manual`, `manual (restricted)`, or `unavailable`;
- reload, resume, a new session, and shutdown clear the grant;
- CLI and child tool ceilings remain authoritative;
- `agent_browser_web_search` stays hidden and blocked.

The slash command is user-only. There is no tool that lets the model grant browser access to itself.
