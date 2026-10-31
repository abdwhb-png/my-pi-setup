# About my Pi setup

This document describes the personal Pi installation maintained in this repository. It separates capabilities provided by Pi from the fork, launchers and distribution tooling specific to this setup. Use the [official Pi documentation](https://pi.dev/docs/latest) for the general framework and the [portable setup guide](./portable-setup.md) to install this configuration on another machine.

## Capabilities provided by Pi

Pi is an extensible agent harness. The concepts below describe the underlying framework; they do not imply that the local runtime management commands are part of upstream Pi.

### Packages and extensions

**Packages** distribute extensions, skills, prompt templates and themes through npm, Git or local paths. They declare resources under the `pi` key in `package.json` or use conventional directories. See the [package documentation](https://pi.dev/docs/latest/packages).

**Extensions** are TypeScript modules that subscribe to lifecycle events, register tools and commands, and customize the interface. Global extensions are discovered under `~/.pi/agent/extensions/`; project extensions live under `.pi/extensions/`. Discovered extensions support `/reload`; `pi -e ./path.ts` loads an explicit entrypoint for a run. See the [extension documentation](https://pi.dev/docs/latest/extensions).

Subagents, planning workflows, permission gates, sandboxing and MCP integration can be implemented through extensions. Their presence and behavior depend on the selected packages and local implementation. See the [extension examples](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/) and [package catalog](https://pi.dev/packages).

### Sessions and context

**Sessions** are JSONL trees saved under `~/.pi/agent/sessions/`, organized by working directory. See the [session documentation](https://pi.dev/docs/latest/sessions).

**Project instructions** come from `AGENTS.md` files loaded at startup from the agent directory and applicable project directories. `SYSTEM.md` and `APPEND_SYSTEM.md` customize the system prompt. Skills supply instructions on demand, while prompt templates expand through `/name` commands.

**Compaction and dynamic context** can be customized by extensions: they can summarize conversation history, inject messages and implement retrieval or memory. See the [system prompt source](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/system-prompt.ts), [skills documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#skills), [prompt templates](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#prompt-templates) and [custom compaction example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/custom-compaction.ts).

### Execution interfaces

| Interface | Purpose |
| --- | --- |
| Interactive | Terminal UI for daily use. |
| Print / JSON | `pi -p "query"` for scripts; `--mode json` for event streams. |
| RPC | JSON protocol for process integrations; see the [RPC documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs/rpc.md). |
| SDK | Embed Pi in an application. |

## Choices specific to this installation

### Daily launcher and promoted fork runtime

The daily command is `~/.pi/bin/pi`. It launches the promoted, read-only fork release under `~/.pi/runtime/pi-core/releases/`. Adding `~/.pi/bin` to the shell's `PATH` makes it available as `pi`; the [installation guide](./portable-setup.md) includes the Bash and Zsh instructions.

The fork source lives separately under `~/engineering/pi-core`. Editing or building that checkout does not change the daily runtime; promotion must succeed first. For development from the fork source, run `pi-fork deploy` before installing dependencies in `agent/`, because the committed Pi pins refer to release tarballs excluded from Git. A portable installation instead restores its bundled runtime through `pi-setup`.

Bare/self `pi update` is blocked by this installation's launcher. `PI_REAL_BIN` is an explicit development override for testing another executable. These are local policies, not general Pi requirements. [ADR-026](./adr/ADR-026-immutable-local-pi-fork-releases.md) records the runtime isolation and promotion decision.

### Runtime management versus complete setup management

`pi-fork` and `pi-setup` are repository-managed commands. They operate at different scopes:

| Command | Scope |
| --- | --- |
| `pi-fork deploy` | Build, verify and promote the local Pi core fork. |
| `pi-fork import` | Verify and promote an already packed Pi core runtime without the fork source checkout. |
| `pi-fork status` / `pi-fork verify` | Inspect the active core release and verify runtime coherence. |
| `pi-fork rollback` | Activate the previous Pi core release. |
| `pi-setup` | Package, install, check, update or roll back the complete managed setup, including its profile, packages and runtimes. |
| `pi-setup memory export` / `pi-setup memory import` | Transfer optional global memory separately from the setup archive. |

Importing a packed core runtime does not install the complete personal setup. The [portable setup guide](./portable-setup.md) owns both the complete installation procedure and the advanced core-only import procedure, including prerequisites and verification boundaries.

### Configuration and portable state

The personal profile declares package sources and resource selection in `agent/settings.json`. Extensions, skills, prompts and themes customize the installed harness; they must not be confused with guarantees made by upstream Pi.

The portable distribution pins package and runtime versions. Authentication, sessions and personal memory are excluded from the setup archive. Provider credentials are configured on the destination machine; global memory has a separate optional export/import workflow. The [private qualification guide](./portable-private-qualification.md) describes GitHub Actions checks, credential handling and the distinction between installation, profile lifecycle and provider connectivity.

## Reference documents

- [Portable setup and shell configuration](./portable-setup.md)
- [Private profile qualification](./portable-private-qualification.md)
- [Local runtime promotion decision](./adr/ADR-026-immutable-local-pi-fork-releases.md)
- [Official Pi documentation](https://pi.dev/docs/latest)
- [Upstream source](https://github.com/earendil-works/pi)
- [Documentation map](./resources/pi-docs.map.json)
