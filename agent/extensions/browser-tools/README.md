# Browser Tools

Local Pi policy owner for the separately installed `pi-agent-browser-native` package. The native package owns browser commands, its normal Pi skill, and browser lifecycle; this extension controls access to every registered tool in its public `browser` namespace.

Tools are hidden by default. `/browser-tools on` grants the family for the current session, `/browser-tools off` revokes access, and `/browser-tools status` reports the effective state. The command is user-only. Deactivation hides tool schemas and blocks stale calls without stopping browser processes.

## Default activation

Set `enabledByDefault` in `~/.pi/agent/config/browser-tools.json` for a global default, or in `<project>/.pi/config/browser-tools.json` for one project:

```json
{
    "enabledByDefault": true
}
```

The project layer overrides the global layer only after saved project trust is granted and launch/runtime trust permits it. Missing values inherit; the built-in default is `false`. Invalid configuration is reported and does not enable tools by default.

An explicit `on` or `off` overrides configuration for that session, even if it matches the current default. Reload and resume restore that choice. New and forked sessions clear inherited choices and resolve their own configured default. A reset marker prevents a later reload from reviving an inherited grant. Only the current session branch is read.

Configuration contributes policy defaults and never widens an explicit role. Manual activation contributes an explicit grant. CLI and child ceilings, other policy denials, and hidden exposures remain authoritative. Optional browser search becomes available only when the native package has registered it from its own configuration.

## Skill delivery

The matching native package registers `pi-browser-tool` through `resources_discover`. Its `before_agent_start` handler removes that skill from the normal model catalogue when no browser tool is active, without reloading extensions or injecting the full skill body. Manual `/skill:pi-browser-tool` and explicit skill search remain available. Other skills are unaffected.

Remove the former `~/.pi/agent/skills/pi-browser-tool` copy when activating the updated package. Merge `"!agent-browser"` into the existing `skills` list in `~/.pi/agent/settings.json` to exclude the separate shared CLI skill from Pi's automatic discovery. Keep `~/.agents/skills/agent-browser` intact for other harnesses. The repository's settings example includes this exclusion.

## Session state and status

The extension records explicit choices with `pi.appendEntry("browser-tools:grant", { granted: true | false })`. A `null` grant resets to configuration for a new or forked session. These custom entries do not enter model context.

| State | Meaning |
| --- | --- |
| `hidden` | Tools are available but disabled. |
| `configured` | Configuration enables at least one browser tool. |
| `manual` | An explicit session grant enables at least one browser tool. |
| `configured (restricted)` / `manual (restricted)` | Activation is requested but policy excludes every browser tool. |
| `unavailable` | The native package's primary tool is not registered. |

The footer widget uses the existing fancy-footer contribution and refreshes after commands, session start, input, and before agent start. Shutdown removes its widget and policy contribution.

## Validation

Run focused tests from the agent directory. The cross-package runtime contract is opt-in because it requires a built native package checkout:

```sh
PI_BROWSER_TOOLS_PACKAGE_ROOT=~/engineering/pi-integrations/pi-agent-browser-native bun test --isolate extensions/__tests__/integration/browser-tools.integration.test.ts
```

The contract uses isolated configuration and a scripted model, verifies the compiled package root through its registered skill path, and does not launch a browser or call a provider.
