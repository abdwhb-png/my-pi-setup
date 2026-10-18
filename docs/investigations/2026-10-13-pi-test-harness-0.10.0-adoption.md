# pi-test-harness 0.10.0 installation and useful adoption opportunities

Date: 2026-10-13. Scope: install the published development dependency in `agent/`, verify the installed consumer, and identify useful changes to existing tests. Test migrations and package implementation changes are not part of this work.

## Installation

The official npm registry confirmed `@abdwhb-png/pi-test-harness@0.10.0`, published at `2026-10-13T22:04:34.996Z`, with `latest: 0.10.0` and Git commit `d02afe00da5a26497a29e190820ace8041f2bb6e`. Its five Pi peers require `~1.1.0`. All five resolve to the existing local fork packages at version `1.1.0` in this consumer. [Exact published metadata](https://registry.npmjs.org/@abdwhb-png%2Fpi-test-harness/0.10.0).

Installed from `agent/` using `sfw bun add --dev --exact --ignore-scripts @abdwhb-png/pi-test-harness@0.10.0`. The package manifest and Bun lockfile now pin `0.10.0` instead of the previous local `0.8.1-fork.3` tarball. The only dependency changes in the diff are this dependency and its lock entry. Existing Pi overrides remain intact, and the runtime coherence check passes. The installed public entrypoint is `~/.pi/agent/node_modules/@abdwhb-png/pi-test-harness/dist/index.js`.

The previous package tarball remains under `~/.pi/runtime/pi-test-harness/releases/0.8.1-fork.3-be5b44088212/`. Copies of the prior manifest and lockfile, a typecheck comparison configuration, and the temporary capability probe are retained under `/tmp/pi-test-harness-010-install-ehati8/`. A future rollback should restore only the harness dependency through the package manager while preserving later changes to the manifest and lockfile.

## Validation performed

| Check | Result and boundary |
| --- | --- |
| Installed metadata and public ESM resolution | `0.10.0`, with all five Pi peers resolving to local `1.1.0` packages. |
| `bun run check:pi-runtime` | Pass. Active release remains `1.1.0-00c5e7e300ba-dirty-79f8bc0b6a58`. |
| Six existing integration files | 13 tests pass, 73 assertions: native MCP role policy, permissions, HTTP/stdio environment handling, codemode shell admission, subagent fallback advice, and final execution provenance. |
| Temporary installed-artifact probe | Two tests pass, 15 assertions: native in-memory MCP, parent/child correlation, structured results, actual mock provenance, asynchronous nested mocks, policy refusal before mock execution, and awaited transport closure. No LLM calls. |
| `bun run typecheck` | Fails on three `options.signal` type errors in sandbox tests, listed below. |
| Same typecheck with the old harness declarations | The same three errors reproduce using `0.8.1-fork.3` declarations extracted from the preserved tarball, without replacing the installed package. No additional errors appear with `0.10.0`. |
| `git diff --check` | Pass. |

The type errors are at [preparation.test.ts:104](../../agent/extensions/sandbox/preparation.test.ts#L104), [runtime-bundle.test.ts:141](../../agent/extensions/sandbox/runtime/runtime-bundle.test.ts#L141), and [runtime-bundle.test.ts:216](../../agent/extensions/sandbox/runtime/runtime-bundle.test.ts#L216): `Property 'signal' does not exist on type 'never'`. They remain outside this dependency-installation scope.

No full extension suite, Windows matrix, real-provider run, dependency publication, core promotion, or changes to personal settings were performed. The separate untracked `2026-10-13-live-delegation-e2e/` investigation was preserved.

## Prioritized adoption inventory

The search found 61 TypeScript files referring to the package under `agent/extensions`, `agent/scripts`, and `agent/bin`. This includes fixtures and tooling, not 61 independent migration candidates. The useful changes are concentrated below.

### P1 — Role policy for native MCP: high value

Owner: [native-mcp-policy.test.ts:20](../../agent/extensions/__tests__/integration/native-mcp-policy.test.ts#L20). Existing coverage already runs real Pi MCP, codemode, tool search, deferred exposure, and allowed/denied role policies. It uses a purpose-built HTTP peer and separately records tool-call events. Its parent check only establishes that some parent identifier exists.

Use `createMcpFixture` for this policy scenario while retaining real Pi factories and the public `tool-groups` extension. Assert the exact MCP child-to-codemode parent ID, received arguments, no fixture execution under denial, and visibility before and after tool search. This localizes MCP protocol simulation in its existing package owner and improves failure attribution. Preserve the current behavioral assertions rather than merely changing fixture syntax. Do not require a child event for a call rejected before Pi dispatches the child.

### P2 — Native MCP permission enforcement: high value

Owner: [native-mcp-permissions.test.ts:17](../../agent/extensions/__tests__/integration/native-mcp-permissions.test.ts#L17). Current assertions check a codemode error and an empty server-call list. Those assertions alone can also pass when execution fails for a reason unrelated to the intended permission rule.

Retain the actual permission extension and isolated configuration, use `createMcpFixture` for the external peer, and assert the refused child's tool name, block reason, and parent correlation where Pi emits that child call. Keep the zero-execution assertion. The useful improvement is proving which boundary refused the operation. Mocking the permission extension or the tool under test would remove that proof.

### P3 — Codemode cannot bypass shell admission: high value

Owner: [native-codemode-sandbox.test.ts:14](../../agent/extensions/__tests__/integration/native-codemode-sandbox.test.ts#L14). The current test checks a generic parent error and absence of a filesystem marker.

Add assertions on the nested `bash` call/result and its codemode parent using the new observations. Distinguish a hook block from an execution-time admission error according to the actual event emitted. Preserve the marker assertion as the independent side-effect check. Do not replace the owned shell admission implementation with `mockTools`, which would skip the behavior being qualified.

### P4 — Await real shutdown through the public harness API: targeted value

Owners: the native tests above, [native-mcp-env.test.ts:69](../../agent/extensions/__tests__/integration/native-mcp-env.test.ts#L69), and real-session portions of [sandbox/lifecycle.test.ts:1247](../../agent/extensions/sandbox/lifecycle.test.ts#L1247). These currently emit `session_shutdown` through `extensionRunner`, then call synchronous `dispose()`.

Use `await session.close()` where teardown intends to end the complete session. It awaits the native shutdown path, settles a harness run, and restores interception before removing harness-owned state. With an in-memory MCP fixture, assert `fixture.closed`. Keep cleanup of caller-owned directories, HTTP servers, and externally launched operations explicit and ordered after session closure.

This is not evidence that the current manual cleanup fails. Do not replace direct hook invocations in unit tests that intentionally isolate a particular lifecycle transition. Do not call `close()` after `dispose()`, because that sequence rejects. Do not mass-convert every synchronous teardown when no resource lifecycle is under test.

### P5 — Make the current usage guide discoverable: maintenance prerequisite

Owner: [the repository skill](../../.agents/skills/pi-test-harness/SKILL.md). The installed development package contains the current skill, but the separately tracked skill copy still announces harness `0.7.0` and Pi `0.83`. A development dependency install does not synchronize skill discovery.

Update that guide through its owning synchronization process, with one canonical source and the version-matched references. Also reconcile the relevant guidance in [AGENTS.md](../../AGENTS.md) with current capabilities instead of adding competing instructions. Avoid publishing a second manually maintained API description. The published skill itself contains stale prose saying three peers and recommending positional call/result pairing, despite five peers and ID-based native observations; correct those statements in the owning package before propagating the guide wholesale.

## Keep these tests as they are

- K1 — Preserve real HTTP/stdio coverage in [native-mcp-env.test.ts](../../agent/extensions/__tests__/integration/native-mcp-env.test.ts). Its subject is environment inheritance and header interpolation across real transport boundaries. An in-memory fixture would bypass that subject. The shared [local-mcp.ts](../../agent/extensions/__tests__/integration/fixtures/local-mcp.ts) still has a role for these transport and real-child tests even if P1/P2 stop using it.
- K2 — Preserve pure policy/parser/state tests, including [tool-policy/index.test.ts](../../agent/extensions/_shared/tool-policy/index.test.ts) and [subagents/rpc-client.test.ts](../../agent/extensions/_shared/subagents/rpc-client.test.ts). Booting Pi adds no coverage when the contract is entirely within those modules.
- K3 — Preserve real-child qualification in [pi-subagents-provider-failure.integration.test.ts](../../agent/extensions/__tests__/integration/pi-subagents-provider-failure.integration.test.ts). The new MCP fixture does not replace RPC, process interruption/resume, provider failure, or external authentication checks. `createMockPi` remains a sequential CLI mock and is not a new deterministic parallel/RPC engine in 0.10.0.
- K4 — Do not add generic copies of the package's structured-result, async-mock, or codemode tests to every extension. Add a consumer scenario only when that extension depends on the behavior. Existing final-result provenance and fallback advice tests passed unchanged.

Recommended order: P1 and P2 first, P3 next, and P4 while touching the corresponding session tests. P5 should keep future test work aligned with the actual installed API. Native errors, exposure, and result semantics remain owned by Pi and the harness; consumer tests assert their own policy and workflow contracts through those implementations.
