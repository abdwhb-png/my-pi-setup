# ZeroBox development compatibility verification

## Scope

The implementation completes private sequenced-packet IPC, offline descriptor inspection and half-close, and conventional aliases for the validated private shell runtime. It adds no public CLI switches, configuration fields, host directory grants or automatic host fallback. Pi validates runtime command aliases against the pinned shell manifest and retains its existing installation and cache configuration.

Development used the existing ZeroBox checkout at `~/engineering/shared-services/sandboxes/zerobox-worktrees/docker-trust` and the existing Pi `develop` checkout. The untracked `docker-trust.patch`, personal authority, running project services and daily runtime were excluded from changes. The source baseline was `30c3c37e9de354bfb3c666f1af52a275ea7f526c` and the implementation commit is `65c4db8b1dbad1202daebb9205bda9c06b2e9348`; the daily runtime remained `native-41996183653-1` throughout local verification.

## Regressions and implementation

- Public ZeroBox execution reproduced `EPERM` for sequenced-packet pairs in filtered modes. One shared rule now permits Unix stream and sequenced-packet pairs with protocol zero and known flags. Datagram restrictions and exact named-socket authorization remain separate.
- Offline tests reproduced failed socket inspection and half-close. A real Node subprocess test then revealed a further rejected `getsockopt(SOL_SOCKET, SO_TYPE)` call. Only this socket-option read was added. Other socket-option calls remain denied. Exact child output is asserted independently of exit status.
- Public Pi execution reproduced missing conventional helpers. Aliases now derive from executable manifest entries and reuse the existing private-root link mechanism. Integration tests caught two implementation regressions before delivery: a normalized `/bin` alias could shadow an explicitly granted host executable, and layout-only directory names were incorrectly treated as authorization roots when discovering file symlinks. Both were corrected and have executable regression coverage.
- Admission initially rejected runtime aliases targeting the reserved runtime prefix. Parsing now accepts only the conventional command-link shape, and policy validation additionally requires a matching declared shell entry. Arbitrary destinations, host targets and undeclared runtime entries remain rejected. Older admission reports remain supported.

## Local evidence

Local checks used WSL, Rust 1.96.0 and Bun 1.4.3. Source changes under generated `upstream/` were produced only through tracked patches and `scripts/sync.sh`.

| Check | Result |
| --- | --- |
| ZeroBox library suite | 223 passed |
| Linux helper library suite | 124 passed |
| ZeroBox network integration suite | 36 passed |
| Private execution integration subset | 20 passed |
| Pi development compatibility contracts | 4 passed, 27 assertions |
| Nearby shell, installation, cache and isolation contracts | 8 passed, 88 assertions |
| Pi admission, runtime-bundle and candidate-runner unit tests | 41 passed, 111 assertions |
| Pi type check and lint, including extension boundaries | Passed; existing lint warnings retained |
| Focused ZeroBox Clippy without dependency linting | Passed |
| Workspace Rust formatting | Passed |

The private IPC tests cover transfer, flags, inheritance, descriptor passing, original-peer preservation, denied named and abstract host sockets, unsupported pair arguments and unchanged datagram restrictions. The offline test also rejects socket-option operations outside the allowed type query. Runtime contracts cover host Bash precedence, explicit host symlinks, conventional helper lookup and read denials in both offline and filtered-network modes.

The script fixture executes an explicitly pinned native pnpm 12.8.1, npm and Bun. It asserts the pnpm version and the files written by actual scripts without shell overrides. A `packageManager` declaration in an otherwise isolated native fixture triggered a separate package-manager version-resolution path and attempted registry metadata access. That failed evidence was retained rather than converted into an execution workaround. Cold version-manager provisioning and complete project builds are separate from these script-execution contracts.

Global Clippy remains blocked by seven pre-existing `unwrap`/`expect` errors in generated `mediated_direct.rs` and `proxy_routing.rs`; their production logic was not changed. No lint rule was suppressed or weakened. The focused crate check does not replace this failed global check.

## Native qualification and delivery

Native qualification uses the existing private-runtime workflow. It provisions the pinned pnpm fixture through Socket Firewall, checks Rust formatting, runs the relevant native Rust regressions, builds the static engine, assembles the locked runtime bundle, runs every explicit candidate contract and tests installation in a disposable home. The engine source revision is `65c4db8b1dbad1202daebb9205bda9c06b2e9348`. The first native run ([42230228363](https://github.com/abdwhb-png/my-pi-setup/actions/runs/42230228363)), portable run ([42230128757](https://github.com/abdwhb-png/my-pi-setup/actions/runs/42230128757)) and lint run ([42230128786](https://github.com/abdwhb-png/my-pi-setup/actions/runs/42230128786)) failed before checks because the Pi 1.5 dependency pins still used a Pi 1.1 CI archive fixture. The complete fixture was replaced with the already-promoted immutable Pi 1.5 archives; no Pi core source, dependency pins or lockfile were changed. Temporary-directory restoration reproduced the archive-name refusal before replacement and verified all eleven archive hashes afterward. The two portable tools-only tests also passed.

Local probe bundles were explicitly marked unqualified WSL artifacts and did not claim a clean source commit. They were never promoted. Native qualification, daily activation and publication are distinct outcomes; passing these checks does not certify arbitrary tools or every host security configuration.

The next portable run ([42231307146](https://github.com/abdwhb-png/my-pi-setup/actions/runs/42231307146)) restored dependencies, passed type checking and tool discovery, then exposed a second Pi 1.5 setup prerequisite: Bun 1.3.14 executed `.d.ts` files selected by the base TypeScript path mappings and failed on their declaration-only imports. The same import failure was reproduced with the cached Bun 1.3.14 executable. Extensionless mappings now resolve executable JavaScript at runtime and declarations during type checking, retaining the existing extension compatibility view without duplicating configuration or changing Pi core. The full local type check and lint passed. The local CI boundary suite with Bun 1.3.14 recorded 1,390 passed, 101 skipped and three five-second timeouts, with no declaration-import errors. Those three unchanged tests passed together in an isolated rerun (3 passed, 14 assertions, 3.04 seconds); the initial timeout evidence remains recorded rather than being reported as a clean broad run.
