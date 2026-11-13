# Launch profiles

Start a process with a named set of extension exclusions:

```sh
pi --profile no-permissions
pi --profile standard --continue
```

Place `--profile NAME` before all other Pi arguments. `pi --help` documents this launcher option, including when extensions are disabled. The launcher translates the selected profile to native, repeatable `--exclude-extension` options before Pi imports extensions. Explicit exclusions can be added after the profile. The remaining Pi arguments, including values and `--`, are passed through unchanged. No profile is selected implicitly or propagated automatically to child processes. Without `--profile`, the existing launch behavior is preserved.

Use `/profiles` to list profiles, `/profiles NAME` to inspect one, and `/profiles edit` to edit the JSON through Pi's public editor. Changes apply to the next process; they do not unload extensions or change tools in an existing session. Restart Pi after installing this extension, or use `/reload` to make its command available.

The personal configuration is `~/.pi/agent/config/launch-profiles.json` (under `PI_CODING_AGENT_DIR` when set). Project files do not override launch profiles. Add profiles to its `profiles` object:

```json
{
  "profiles": {
    "minimal": {
      "description": "Omit notifications and builtin MCP.",
      "excludeExtensions": ["notify", "builtin:mcp"]
    }
  }
}
```

Names contain letters, digits, underscores or hyphens and begin with a letter or digit; `edit` is reserved. Each profile requires an `excludeExtensions` array; an empty array adds no exclusions. Unknown fields, malformed configurations and unknown profile names fail visibly. The editor preserves the previous file on cancellation, invalid input or a detected concurrent edit. Pi validates extension selectors itself, rejecting unknown or ambiguous matches. Disabling a package's extensions leaves its other resource types available.

The supplied `no-permissions` profile excludes the permission package and its local addons. It does not bypass other extensions' independent policies, such as sandboxing or role tool restrictions.
