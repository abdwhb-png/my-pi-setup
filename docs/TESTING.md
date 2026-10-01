# Local Pi validation

Run standard tests from `~/.pi/agent` so Bun reads `bunfig.toml` and excludes managed package checkouts:

```sh
bun run test
```

Role parsing, inheritance, alias resolution and handoff guards use isolated fixtures. Personal tool lists and prompt wording are mutable configuration, not unit-test snapshots. Historical migration assertions that require `mcp.json` or ban a previously removed package are retired.

The portability audit uses Oxlint's parsed JavaScript/TypeScript literals rather than treating comment examples as executable paths. Its shared home-path policy also checks configuration and script values. SSH remote directories remain caller-configurable, including `/home/dev`.

Inspect the current personal configuration explicitly:

```sh
bun run test:configuration-audit
```

This read-only audit checks alias graphs, configured consumers, protected read/write boundaries and planning handoff selections. It does not require an MCP configuration file.

Real Zerobox contracts require Linux and an explicitly pinned runtime bundle, binary and SHA-256. Run `bun run test:sandbox:zerobox-candidate -- --help` for the required environment. Each contract runs in a separate Bun process.

The Sandbox/Bash path diagnostic additionally runs its session in a bounded child process with a disposable HOME and agent directory. It retains real engine admission, outside-scope diagnosis and missing-path assertions. Startup, Bash, user Bash and shutdown phases appear in failure output. Its unrelated Analysis preflight is mocked; separate real Analysis contracts cover workers. Standard tests exercise timeout containment without loading a personal runtime.

The original full-suite 60-second path-diagnostic timeout could not be reproduced in focused or preceding-file replays. Its trigger remains unresolved. A small timeout probe did reproduce parent cwd leakage when Bun advanced to another file before the timed-out test's `finally` completed; process isolation contains that failure mode.
