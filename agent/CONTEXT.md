# Context

- The project was migrated from `@mariozechner/pi-coding-agent` to `@earendil-works/pi-coding-agent` in June 2026.
- `@mariozechner/pi-coding-agent` is deprecated. All imports in the `~/.pi/agent` source files now use `@earendil-works/pi-coding-agent`.
- Some external packages (e.g. `pi-roles`) may still declare peerDependencies on the `@mariozechner/*` scope — these are third-party packages, not ours to fix.