# Bundled Linux helper startup verification

## Correction

Zerobox CLI previously attempted to create an arg0 helper alias before considering the supplied runtime bundle. Release builds reject alias homes under the operating system temporary directory, while Pi intentionally places private leases under `/tmp/pi-z-…`. The resulting warning was unnecessary: bundle execution independently validates and stages the bundle's helper.

Engine commit `bf98c8dcd55eeac063e0ec3df3104e677d748993` skips alias preparation whenever `runtime_bundle` is supplied. Non-bundle alias initialization, the temporary-directory protection, bundle validation and helper integrity checks remain in place. No public API, schema, dependency or permission changes were required.

Pi qualification source commit `91fb1a88fc0e710f45564b105a0a0190d74c5451` pins that engine and extends the real profile contract across leases under `/tmp` and `/var/tmp`, private and host Bash temporary namespaces, and all three shell/analysis profiles. Exact output assertions detect unexpected diagnostics while existing isolation assertions remain active. Three public CLI cases reject missing manifests and incomplete bundle/component argument pairs before executing the target. The installed Pi contract also rejects the alias warning for both `bash` and `safe_bash`.

## Evidence

- RED: the installed previous release successfully executed the target but failed the new exact-output assertion because it emitted the alias warning for a lease under `/tmp`.
- Local static checks: Pi typecheck and repository lint, including ownership/storage checks, passed. Existing lint warnings remain.
- [Native engine qualification](https://github.com/abdwhb-png/zerobox/actions/runs/41601718911) passed with 924 reported passing Rust cases across workspace libraries and native kernel integration, including existing helper-integrity and non-bundle execution coverage.
- [Native Pi qualification](https://github.com/abdwhb-png/my-pi-setup/actions/runs/41601826009) passed: 1,290 boundary tests with 91 skips; 96 explicit candidate-contract tests with four skips; and the fresh installed-runtime contract. The workflow's type checks also passed.
- Local GREEN: the verified candidate passed all 12 profile tests with 70 assertions. A fresh Pi session after promotion passed the installed-runtime contract with 16 assertions, including real admission and absence of the warning for both shell tools.

The first local negative-case invocation could not create its `/var/tmp` fixtures in the restricted executor. It passed all three cases when rerun with host filesystem access. This was a fixture prerequisite, not a policy change. No repository-wide Pi test suite was run beyond the documented native qualification gate, and no model/provider calls were made.

The separate [disabled release workflow](https://github.com/abdwhb-png/zerobox/actions/runs/41601717285) returned failure without jobs. Its existing `release.yml` declares `on: {}` and was not changed. Both native qualifications above succeeded; this delivery makes no claim that every unrelated workflow is green. No binary or package release was published.

## Artifact and activation

The qualified artifact is `13215032589`, runtime `native-41601826009-1`. The ZIP digest from GitHub metadata and the embedded archive checksum were checked before safe extraction; engine source revision, binary digest and manifest digest were then verified.

| Item | SHA-256 |
| --- | --- |
| Artifact ZIP | `a1fbf6da224abca5b21471aed25ce84a3a22548dafd8df718ca3d18f372c00be` |
| Runtime archive | `1a744b2cb6c09ed469e17b858ba3e71b875616f8a94c45268c3c0f9dfed83223` |
| Engine/helper | `eace9fe07cad924d2c4808a5b7d2fa114a8dac25a32913965d7eb77140998655` |
| Manifest | `80bc399b0a50a928dd76b44ddfa6c3645a5533a266dff7bfc6518034c77d67ea` |

The existing staging command validated and atomically promoted the bundle. `~/.pi/bin/zerobox` points to `../runtimes/zerobox/native-41601826009-1/bin/zerobox`. The previous `native-40901222245-1` release remains intact. Global Sandbox configuration and Pi settings stayed byte-identical; Gemini access was not expanded. Restart existing Pi sessions so cached backend objects resolve the new runtime.

Logs, verified archives and activation metadata remain under `~/.pi/runtime/deliveries/helper-alias-20261103/`. Its guarded `rollback.py` restores only the recorded previous link after checking both runtime identities. The rollback script was syntax-checked and was not executed. Source branches were published for qualification; no remote base branch was merged. Unrelated files were excluded from all delivery commits.

Storage cleanup on 2026-11-03 removed the downloaded ZIP, tar archive and expanded candidate after comparing all 4,216 regular candidate files against installed runtime `native-41601826009-1`. Activation metadata, checksums, candidate manifests, logs and the guarded rollback script remain in the delivery directory. Installed current and rollback runtimes were preserved; the preceding archive-retention statement records the original delivery state.
