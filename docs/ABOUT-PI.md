
# About Pi

Pi is a minimal agent harness that's fully customizable with [extensions](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#extensions), [skills](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#skills), [prompt templates](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#prompt-templates), and [themes](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#themes).

## Context engineering

Pi - Load project skills and instructions

Pi's [minimal system prompt](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/system-prompt.ts) and extensibility let you do actual context engineering. Control what goes into the context window and how it's managed.

**AGENTS.md:** Project instructions loaded at startup from `~/.pi/agent/`, parent directories, and the current directory.

**SYSTEM.md:** Replace or append to the default system prompt per-project.

**Compaction:** Auto-summarizes older messages when approaching the context limit. Fully customizable via [extensions](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/custom-compaction.ts): implement topic-based compaction, code-aware summaries, or use different summarization models.

**Skills:** Capability packages with instructions and tools, loaded on-demand. Progressive disclosure without busting the prompt cache. See [skills](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#skills).

**Prompt templates:** Reusable prompts as Markdown files. Type `/name` to expand. See [prompt templates](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#prompt-templates).

**Dynamic context:** [Extensions](https://github.com/earendil-works/pi/tree/main/packages/coding-agent#extensions) can inject messages before each turn, filter the message history, implement RAG, or build long-term memory.

## Four modes

Pi - Generate a shell script in print mode

**Interactive:** The full TUI experience.

**Print/JSON:**`pi -p "query"` for scripts, `--mode json` for event streams.

**RPC:** JSON protocol over stdin/stdout for non-Node integrations. See [docs/rpc.md](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs/rpc.md).

**SDK:** Embed Pi in your apps. See [OpenClaw](https://github.com/OpenClaw/OpenClaw) for a real-world example.

## Primitives, not features

Pi - Install a third-party extension

Features that other agents bake in, you can build yourself. Extensions are TypeScript modules with access to tools, commands, keyboard shortcuts, events, and the full TUI.

[Sub-agents](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent/), [plan mode](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/plan-mode/), [permission gates](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/permission-gate.ts), [path protection](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/protected-paths.ts), [SSH execution](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/ssh.ts), [sandboxing](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/sandbox/), MCP integration, custom editors, status bars, overlays.

Install a [package](https://pi.dev/packages) that does it your way. See the [50+ examples](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/).

Bundle extensions, skills, prompts, and themes as packages. Install from npm or git:

`$ pi install npm:@foo/pi-tools
$ pi install git:github.com/badlogic/pi-doom`

## Additional resources

- [Documentation](https://pi.dev/docs/latest)
- [GitHub](https://github.com/earendil-works/pi)
- [Docs map](./resources/pi-docs.map.json)
