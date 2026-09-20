# Sandbox runtime

Sandbox uses a provenance-pinned Zerobox release and a private runtime bundle. The Pi policy compiler, binary, manifest and provenance must describe the same contract. A version string alone does not identify a locally patched build.

## Filesystem and tool baseline

The default Bash policy grants the project permissions and a read-only private runtime at `/__zerobox/runtime`. It does not grant host `/bin`, `/sbin`, `/usr`, `/lib`, `/lib64`, `/etc`, `/nix/store`, host executable directories, or the caller's PATH.

```text
Bash, coreutils, findutils, grep, sed, gawk,
diffutils, tar, gzip, and required private dependencies
```

Shell PATH contains selected installation command directories, legacy `environment.path`, then `/__zerobox/runtime/bin`. An installation grants its declared roots read-only. Host environment variables require an explicit allowlist or configured value. Git, `rg`, `jq`, package managers, editors, and development tools are not part of the private shell runtime. Neither PATH nor an executable's name grants access to other resources. Canonical targets of symlinks and dependencies must remain inside authorized roots or the private runtime.

Configured denies remain enforced, including within a writable project. The default policy does not grant the host HOME, `/etc` or the filesystem root. FUSE views enforce dynamic exclusions without reopening their parent directories.

## Private state

Bash and Think collection use separate leases below `~/.pi/zbx/`. Analysis uses a fresh lease per request. The physical lease control directory is masked, even when it is inside the project.

Zerobox mounts the current lease's private HOME at `/home/sandbox`. Shell HOME, XDG/Bun/npm caches and Docker configuration use this logical location. Its caches are writable while sibling leases and control data stay hidden. The mount uses a pre-opened directory descriptor rather than reopening an inaccessible source through the sandbox view.

A filesystem deny that intersects the logical private HOME is rejected explicitly when it cannot be enforced by this mount contract. It is never silently ignored. Configuration paths beginning with `~/` still expand from the host user's HOME before policy compilation. In a sandboxed command, shell `~` expands from its private HOME.

Bash uses private `/tmp` by default. Explicit global `tmpNamespace: "host"` permits host temporary storage, and the project can restrict it to `lease-private`. Think and Analysis always retain separate private temporary namespaces. Native file tools remain on the host, so use a project file when an artifact must be visible on both sides.

Analysis is separate from the shell: it receives `/__zerobox/analysis` only for Analysis execution, alongside the private shell runtime where required. Do not infer that a shell command can run an Analysis helper or that an Analysis helper can access a selected shell installation.

## Runtime distribution and admission

The bundle manifest is distribution metadata, not user configuration. It declares the managed release's target, version, helper digest, components, files, symlinks, and digests. Pi verifies the manifest and tree, installs a complete release atomically, and pins the resolved real release path for a runtime lifetime. A later symlink or current-release change cannot alter an already prepared runtime.

Zerobox writes a bounded admission report to FD 4 before it reports `child_started` on status FD 3. The report is limited to 1 MiB, includes the runtime and helper digests, mounts, effective filesystem/network/resource policy, PATH, private HOME and temporary namespace, and must match the submitted policy. The V2 status stream contains `sandbox_admitted` with the report digest; Pi accepts readiness only after the FD 4 report validates and the digest matches. A missing, oversized, malformed, mismatched, or out-of-order report blocks execution.

The inner helper records `kernelMounts` from `/proc/self/mountinfo` after entering the private filesystem. Each record includes the destination, filesystem root, source, filesystem type and observed read/write flag. The helper and Pi reject absent or writable private runtime mounts. Authorized host path aliases remain explicit in `pathAliases`. Policy mounts use validated descriptors so replacing an authorized path during setup cannot redirect the mounted source.

Pi returns the validated report digest on a separate acknowledgement descriptor, FD 5. The supervisor keeps that descriptor outside the sandbox and does not release the target until the acknowledgement matches. It then confirms successful `exec` through the private setup channel before emitting `child_started`. A rejected report or missing executable remains a setup failure, distinct from a started program that exits with code 125.

## Execution lifecycle

Bash enables `pipefail`. A failure in an earlier pipeline stage therefore affects the reported exit code. Commands that intentionally accept such a failure can explicitly change shell options.

The runtime distinguishes `uninitialized`, `reconfiguring`, `enabled`, `disabled` and `error`. Callers resolve the service at dispatch and recheck the policy fingerprint after preparation. A stale or revoked admission cannot dispatch against a wider old policy.

During reconfiguration, pending calls wait at most 30 seconds within their original deadline and cancellation signal. Additive valid changes retain the old runtime while already admitted operations drain. A removed right revokes admission and interrupts existing affected descendants before replacement. Session replacement and Docker break-glass expiry preserve their interrupting behavior. Interrupted commands are never replayed automatically.

Removing a Unix socket or TCP publication triggers the same watcher and pre-admission revocation as filesystem access. Pi interrupts and awaits older shell runtimes that held the removed resource before preparing the replacement. This closes their existing connections and stops their commands, including other commands in the same runtime. Older runtimes whose resource grants remain valid continue draining normally. Think and Analysis receive no shell resource grants.

A missing or mismatched binary, invalid policy, failed setup protocol or unavailable Linux facility blocks sandbox execution. It never selects host execution as a fallback.

Docker uses its policy broker and a private connection. A Docker authorization does not mount the daemon socket. Its global ceiling and project activation are checked before each new admission.

## Model context

Before each provider request, Pi adds one `<pi-shell-context>` block to a copy
of that request's system instructions. The block combines current execution
facts, tool availability and active Safe Bash checks. It never becomes a user
message, changes the saved base prompt or appends to session history. Unchanged
facts produce the same block; changed facts replace their section. Historical
assistant acknowledgements remain part of the conversation.

The provider adapters preserve conversation messages, tool results, unrelated
system instructions and cache metadata. An unsupported payload produces a UI
warning instead of falling back to a user message. The `context` hooks only
remove legacy ephemeral `pi.shell-context.v2` messages from outgoing context.
Stable tool descriptions and common guidelines contain no changing policy values.

The context resolves configuration without starting Zerobox. An unchanged
configuration reports the admitted runtime's policy facts. A valid change
reports `pending`; new openings are not advertised as active. The next shell
admission prepares the replacement through the existing lifecycle. Invalid
configuration, missing policy or an unavailable runtime reports the block and
preserves execution gates. Already admitted calls keep their original receipts
and remain subject to the existing revocation rules.

Version 3 execution receipts are derived from the validated engine admission report and include its digest, runtime/helper identities and mount evidence. They prove the permissions admitted for that execution, not executable availability or service reachability. Version 1 and V2 receipts remain readable as historical or planned policy; they do not prove current mounts and must not be upgraded by inference. Environment values other than HOME and PATH are omitted. Display aliases such as `~` identify host paths; sandbox shell expansion still uses the private HOME.

Successful per-call contexts are available during `tool_result` and cleared from the transient registry at `agent_end`. Failed sandbox results retain their context in result details. The shared current shell context comes from the runtime's latest validated admission independently of that per-call registry. Observe successful execution evidence before turn cleanup when testing the tool boundary.

Host context reports the host environment without shell isolation claims.
Think and Analysis remain separate strict environments. Neither disabling a
project sandbox nor selecting host mode through project configuration is
allowed. Host execution still requires global authorization and explicit
session selection.

Install the matching engine and private bundle, then use `/reload` or a new Pi session to load these extension changes. Existing explicit configuration fields remain compatible.

## Qualification and activation

The initial target is Linux x86_64, including WSL2 x86_64. Other platforms and architectures fail explicitly. Native Linux CI and WSL2 require separate qualification evidence.

Private control paths must fit the Unix socket address budget. Preflight rejects a layout whose worst-case socket path is 108 bytes or longer. The current default lease layout permits a host HOME path of at most 12 bytes. Longer home paths block admission. The default Analysis IPC qualification uses a short fixture home and does not establish support for arbitrary home path lengths.

The runtime requires Linux user namespaces and the managed Zerobox/FUSE facilities. The private Analysis component supplies Node with JSPI support, Bun, workers and `prlimit`. Qualify the native kernel separately from WSL2. Neither platform's shell tests establish Windows interoperation or application-specific browser behavior.

### Local network diagnostic release, 2026-09-19

Runtime `2026.09.19.1` is installed at `~/.pi/runtimes/zerobox/2026.09.19.1` through the atomic `~/.pi/bin/zerobox` symlink. It keeps engine version `0.3.3-fork.17`. A managed-proxy denial now writes the denied host and port with its policy reason to stderr and returns the same detail in the HTTP body. Request paths and queries are not included. The engine/helper SHA-256 is `c0a4c892db43eaf26ace36e80f390c1c5aacfd2e635834a724b8a5eaf235c1c0`; the runtime manifest SHA-256 is `a34ad844a94067a734c7d85cf022eb689bf8f5843828eaff7fdc3ff18f8fb287`.

The network-proxy suite passed 149 tests, the allowlist integration module passed 7 tests, the configured warnings-denied Clippy gate passed, and the managed Pi runtime exercised real Bash and Safe Bash admissions. A live Pi service command reported `blocked.invalid:443` beside the original curl `403`, and a non-mutating `sfw npm view` completed successfully through the same installed runtime. This release is qualified locally on WSL2 and is explicitly not native-CI evidence. Reload open Pi sessions or start a new session to pin the corrected engine.

### Local corrective release, 2026-09-15

Runtime `2026.09.15.1` is installed at `~/.pi/runtimes/zerobox/2026.09.15.1` through the atomic `~/.pi/bin/zerobox` symlink. It keeps engine version `0.3.3-fork.17` and prevents write-deny globs from creating guarded FUSE views over roots that are already read-only. The engine/helper SHA-256 is `e1544627b8b448c7f1a818e052be432ccf3fc1d003101be0f93d4ed98737bfc7`; the runtime manifest SHA-256 is `c3b55157c30095ad9b09b829a7fcb9779dc657ce53fca75d672edb523017c61e`.

The focused `dynamic_fs` suite passed 33 tests, the real FUSE integration suite passed 10 tests with one benchmark ignored, Clippy completed with warnings denied, and the Pi read-only-cwd admission regression passed through the managed entry. The same Pi regression reproduced `internal mount exceeds the submitted filesystem grants` with runtime `2026.09.12.10`. This corrective build is qualified locally on WSL2 and is explicitly not native-CI evidence. Reload open Pi sessions or start a new session to pin the corrected engine.

### Release evidence, 2026-09-12

Runtime `2026.09.12.10` is installed at `~/.pi/runtimes/zerobox/2026.09.12.10` through the atomic `~/.pi/bin/zerobox` symlink. It contains the rebuilt Zerobox `0.3.3-fork.17` engine. The engine's version string is unchanged; use its digest and the runtime manifest to identify the release. Existing explicit configuration was preserved byte-for-byte. Reload open Pi sessions or start a new session to use the matching extension code and runtime.

| Validation boundary | Result and scope |
| --- | --- |
| WSL2 Pi regression suites | 909 passed, 72 gated tests skipped across command execution, shared runtime, Bash, Sandbox and Think-in-Code. Real-runtime cases run separately below. |
| WSL2 real shell and Analysis | 42 passed, 4 project-specific workflow replays skipped. Includes installation access, active revocation, Git protection, domain/loopback rules, stream closure and real TypeScript/Python Analysis. |
| WSL2 native authority protection | 2 passed with the candidate, including existing and absent authority files and path aliases. Native `write` and `edit` cannot grant sandbox permissions. |
| Distribution | 10 publication/integrity tests and 3 Python builder tests passed. Hoisted and nested dependency layouts produce the same locked Analysis package closure. |
| Rust on WSL2 and native Linux | Complete workspace tests passed. Kernel integration suites passed 180 cases with 4 explicitly ignored on each platform. Native evidence: [engine CI](https://github.com/abdwhb-png/zerobox/actions/runs/34716118241), engine source `a2e1e2578ac61980807370bde7b82cc41ac32eaa`. |
| Native Linux Pi | [Pi CI](https://github.com/abdwhb-png/my-pi-setup/actions/runs/34719945721) passed on source `afc4c3a2f89976158be602c1ed9eb1d730c63c4c`: 909 regression tests, 42 real shell/Analysis tests, 2 native-authority tests and the installed-runtime session test. The 72 ordinary-suite skips and 4 application workflow skips have the same scope as the WSL2 runs. |
| Installed Pi on WSL2 | The default managed-entry test passed after actual local publication: 1 test, 14 assertions. Both real `bash` and `safe_bash` operations used the installed release with matching V3 admission, private temporary storage, blocked outside files and filtered host environment. Candidate-selection environment overrides were unset. |

Pi typecheck and focused lint completed. Lint warnings remain; this is not a zero-warning qualification. The four omitted application workflow replays require an explicitly selected development project. No personal application's dependency installation, build or browser session was replayed. Pi session tests use a simulated model with real extension loading and real tool execution; they do not evaluate autonomous model behavior.

The installed engine/helper SHA-256 is `d9691ca74d27e3d54af4b82c44aff7efce68689ca1b9d8ca0eed477698139544`. Its runtime manifest SHA-256 is `bf1693f12cc340c71fbb3f1b748a9eb90f92a97552424d3311f9f6e6ca2cf560`. Adjacent provenance records the modified-worktree source delta used for this build, including its patch digests. The native CI rebuild has its own output identities; do not equate separately built binaries solely from their version strings.

The previous regular executable and its matching legacy provenance were retained under `~/.pi/runtimes/zerobox/recovery/1789249018425-c27bc825-4481-45fc-960f-7125317fe26a`. Its SHA-256 is `6814f2ebc1715be50b8fedc63251dd922df625b3f5c086d7637ed658cb777df3`. Publication did not add grants or migrate the personal configuration. The validation branches contain source changes only, with no merge or binary release.

Managed releases store source commits, patch digests, source identity, binary/helper digests and runtime-manifest digest in adjacent `provenance.json`. The legacy `runtime/zerobox-provenance.json` remains associated with the old regular executable for explicit recovery. Start a new Pi session after installing the matching code, engine and runtime.

Select recovery explicitly and restore the corresponding Pi extension code together with its engine and, where applicable, its retained private bundle. Preserve each release's matching provenance when doing so.

## Distribution build and staging

Use the offline [runtime distribution builder](../runtime/distribution/README.md) only with its pinned Ubuntu 24.04 amd64 builder image and locked input cache. It verifies input digests before assembly, builds the QuickJS worker with the downloaded unmodified Bun, relocates the private shell and Analysis components, and writes a manifest for every declared output. The staging operation validates the candidate through `resolvePrivateRuntime`, keeps matching binary provenance beside the release, preserves the existing executable for recovery, and atomically changes the managed entry only when explicitly called. Assembly does not activate a release. Staging to the real managed entry activates it atomically.

Real shell contract tests require both `PI_SANDBOX_ZEROBOX_BINARY` and `PI_SANDBOX_ZEROBOX_SHA256`. Supply the exact candidate explicitly. Tests that require that candidate skip when it is absent instead of using a personal installation. The standalone Analysis proof exercises the real engines; shell lifecycle fixtures simulate only their unrelated Analysis preflight.

### Candidate contract runner

Run `bun run test:sandbox:zerobox-candidate` from `agent/` only after providing one private runtime candidate through `PI_SANDBOX_RUNTIME_BUNDLE`, `PI_SANDBOX_ZEROBOX_BINARY`, and `PI_SANDBOX_ZEROBOX_SHA256`. The command verifies that the executable is the bundle's `bin/zerobox`, validates its SHA-256, then enables only the explicit candidate flags required by the retained Shell, Docker, local-resource, Analysis, authority, profile, fork, and read-only-CWD contracts. It never selects `~/.pi/bin/zerobox` or another host executable. Set `PI_SANDBOX_ZEROBOX_SOURCE_ROOT` when the matching Zerobox Git worktree is available so the source and ordered-patch provenance contract runs too. Use `--validate` to check this configuration without executing native contracts.

The runner deliberately excludes installed-runtime verification. Publish the candidate atomically first, unset all candidate variables, then run `PI_SANDBOX_INSTALLED_CONTRACT=1 bun test --isolate extensions/sandbox/runtime/installed-runtime.integration.test.ts` against the managed entry.

Keep these contracts manual and opt-in:

- `PI_SANDBOX_DEV_WORKFLOW_CWD` replays a developer's real workflow from a supplied checkout. It must not run in generic CI because it intentionally executes that checkout's commands.
- `PI_BROWSER_TOOLS_RUNTIME_CONTRACT` needs a live native Agent Browser installation and a user-visible browser grant.
- `PI_HERDR_RUNTIME_CONTRACT` needs a live Herdr pane and its current pane identity.
