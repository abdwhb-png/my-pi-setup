# Docker Sandbox delivery verification

## Delivered behavior

`/sandbox docker configure` discovers existing containers and Compose services, presents their mounts and access, and saves permissions only after final consent. The Sandbox panel uses horizontal sections and actionable service rows. The workflow preserves explicitly stored target selectors and unrelated configuration. Pi and Zerobox contain no framework-specific integration.

Host-access exceptions, permanent command execution and temporary break-glass execution remain separate permissions. Engine information requires both global `docker.allowEngineInfo` and project `docker.engineInfo`; targeted mode then permits only `GET /info`, including its versioned route. It does not permit container creation or image builds. See [Docker authority](../../agent/extensions/sandbox/docs/docker-authority.md) for configuration and operation limits.

All participating configuration publishers and recovery share a kernel file lock. The persistent lock inode must not be removed to release ownership. Trust is checked again after asynchronous container inspection and before publication. Missing global configuration is prepared in memory and written only after consent. The correctness, security and API review lanes approved the corrected implementation with no outstanding findings in their reviewed scope.

## Source and qualification

- Pi implementation: `160fe775fc8a1908dfa556d596d59d97fd04170e`.
- Pi qualification fixes and exact native checkout: `c9700c00bfcc9b6e9c15b4963fb1f210c9649654`.
- Zerobox source: `885449e7607063afbe97b7c95aeac4e7ac237647`.
- Published source branches: `codex/private-runtime-validation-docker-access-20261029` in `abdwhb-png/my-pi-setup` and `codex/docker-access-20261029` in `abdwhb-png/zerobox`. No remote base branch was merged as part of this delivery.

[Native qualification run 40901222245](https://github.com/abdwhb-png/my-pi-setup/actions/runs/40901222245) completed successfully on Ubuntu with pinned Bun 1.3.14. The Pi boundary suite passed 1,281 tests with 85 opt-in skips and zero failures. All 26 candidate-contract files completed successfully: 90 tests passed and four scenarios were skipped. The real Docker and Compose contract exercised execution, denied access, temporary exceptions and the granted `docker info` route. The final installed-runtime contract also passed on the native runner.

[Initial run 40896700243](https://github.com/abdwhb-png/my-pi-setup/actions/runs/40896700243) failed before building the runtime: four new workflow fixtures closed their HTTP server twice under pinned Bun, and three existing panel tests still used the former pane-navigation keys. The qualification-fix commit corrects those tests. Their failures were reproduced before correction; all 67 workflow and lifecycle tests subsequently passed under Bun 1.3.14. The failed run remains part of the delivery evidence.

## Artifact identity

| Item | Value |
| --- | --- |
| Artifact | `qualified-native-runtime`, ID `12910127380` |
| Runtime release | `native-40901222245-1` |
| ZIP SHA-256 | `85d20e2deb47781d36edb79851adfa764844f178630db2a90c21fadbb0747898` |
| Runtime archive SHA-256 | `2be5e4c20a81020422d21661670b7c16aa29ff6850e9178384116d3f6b67f9af` |
| Engine and helper SHA-256 | `890d5dee15c4ac13a58e9b5fc8442913973202b619547e92ec1e5ff0ea31f19e` |
| Runtime manifest SHA-256 | `ea365c2e6ec9bbd998159b22b25a329e0e2582a3d27918f02304dc34fbd8b0aa` |

The artifact ZIP digest was checked against GitHub metadata before extraction; the archive checksum, manifest digest, engine digest and exact Zerobox source revision were then verified. The repository staging command validated component contents, helper identity and provenance before atomically switching the managed entry. The checked-in baseline provenance was preserved; the promoted release carries its own adjacent provenance. No SDK or package release was published.

## Local activation and recovery

Before promotion, all three Docker candidate-contract files passed locally with 107 assertions, using actual Docker Desktop client and Compose executables against isolated Engine fixture sockets. These checks cover container filtering, host-access exceptions, global and project admission, revocation, command execution, temporary access and engine information. The candidate public policy schema also exposed `engineInfo`.

The managed entry `~/.pi/bin/zerobox` now points to `../runtimes/zerobox/native-40901222245-1/bin/zerobox`. After promotion, `PI_SANDBOX_INSTALLED_CONTRACT=1 bun test --isolate extensions/sandbox/runtime/installed-runtime.integration.test.ts` passed with Bun 1.4.3: one real Pi session exercised `bash` and `safe_bash` with 14 assertions. No model or paid provider call was made.

The first staging attempt correctly refused the restricted executor's filesystem view, where root-owned `/home` appears owned by `nobody`. The actual host ownership was verified separately, and staging succeeded with the unchanged validation rules against the real host filesystem. No directory permissions were changed.

The previous `native-40321985864-1` release remains intact. Evidence, verified archives, activation metadata and a guarded rollback script are retained under `~/.pi/runtime/deliveries/docker-access-20261029/`. Run `python3 ~/.pi/runtime/deliveries/docker-access-20261029/rollback.py` to restore the previous managed link only if the current and previous runtime identities still match the recorded hashes. The script was syntax-checked; rollback was not executed.

Restart every existing Pi session before using the new configuration workflow so all writers honor the publication lock. Then open `/sandbox docker configure` in the trusted project and review the desired service permissions. Global Sandbox configuration and Pi settings remained byte-identical across activation. No Ownertek permissions or project configuration were changed. Existing user sessions were not restarted.

## Validation limits

The focused correction suite passed 208 TypeScript tests, and the Zerobox library suite passed 223 Rust tests. Lint and extension-boundary checks passed with existing warnings. The repository typecheck still reports four errors in unchanged tests: `agent-browser-sandbox-artifacts.integration.test.ts`, `sandbox/preparation.test.ts` and two locations in `sandbox/runtime/runtime-bundle.test.ts`.

The local boundary suite completed with 1,275 passes, 85 skips, six failures and one between-test error. One fixture inherited the local `002` mask and created a group-writable bundle; its isolated rerun passed with the native runner's `022` mask. The other five failures were execution deadlines in Python serialization, cross-runtime storage and distribution tests, with a between-test error after a worker was terminated. The unchanged 1,366-test boundary suite passed completely on the native runner. The local result remains recorded and is not presented as green.

A separate repository-wide local run was interrupted after failures outside this change, including installed-package import failures and unrelated timeouts. Its log is retained. This delivery establishes the documented native release gate, the focused correction checks and the local candidate and installed-runtime contracts; it does not establish a passing repository-wide local suite or a clean global typecheck. Unrelated working-tree changes were excluded from the delivery commits.
