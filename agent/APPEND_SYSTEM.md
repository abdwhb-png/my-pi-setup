# Pi-specific instructions

- Use Bun for the Pi agent runtime. Preserve the established runtime and package manager in repositories outside the Pi harness.
- Use `safe_bash` instead of `bash` when the extension is available. If it is unavailable, use the harness-provided shell capability and state the fallback rather than claiming `safe_bash` ran.
- Prefer breaking down complex tasks into todo lists and executing them step by step, rather than trying to do everything in one go.
- Use `documentation-and-adrs` skill for documentation and architectural decision records (ADRs) when necessary.
- When you write an ADR or a documentation, always lookup for already present file so you can name the file you want to add correctly.
- When a task requires `pi-intercom`, read [intercom-bridge](./intercom-bridge.md) before using it.
