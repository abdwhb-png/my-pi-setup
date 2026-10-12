# Host tool-selection contract

The configured provider exports a synchronous `resolveTools(request)` function. The request contains `cwd`, `agentDir`, `scope`, `projectTrusted` and ordered `selections`, each with `agentName` and `selectors`. Return exactly one ordered result per input: `{ ok: true, selectors: string[] }` or `{ ok: false, error: string }`. Successful selectors must be concrete and contain no unresolved `@` alias. Asynchronous results, malformed results and cardinality mismatches fail closed.

The types are exported by the fork's existing `pi-subagents/agents` API and re-exported by the harness `_shared/subagents` boundary. The global setting accepts a file path relative to the agent directory, an absolute path, or a `~/` path. Project settings never override it.

One batch represents effective configured agents after native scope, identity, override and disabled-agent selection. It is not the raw declaration view. The provider must not write settings, cache permissions, acquire workflow visibility, or depend on a parent tool registry. Child-only exact tool names and literal MCP selectors stay available for native validation and capability ceilings.
