# Private sandbox runtime and explicit local environments

Date: 2026-09-12

Status: approved design, now implemented. Track release qualification and installation in the [runtime guide](../../agent/extensions/sandbox/docs/runtime.md#qualification-and-activation). The preliminary observations below describe the earlier architecture and are not evidence for the new runtime.

## Purpose and document boundary

Provide an isolated shell environment by default. Make existing development installations available through explicit, bounded authorization on each machine, without requiring Pi to recognize individual tools or users to maintain duplicate filesystem and PATH lists.

Use this document as the approved design input. Read the original qualification and documentation inventory as a historical record of the design stage. Consult the runtime guide and configuration reference for the implemented contract and release evidence.

Keep identifiers in this document local: `D` identifies a decision, `F` a finding, `O` an alternative and `R` a remaining qualification limit. These identifiers are not sandbox profiles and do not renumber earlier plans.

## Terms and scope

| Term | Meaning |
| --- | --- |
| Private runtime | A packaged shell, utilities and required dependencies supplied for sandbox execution. It does not borrow the machine's general system directories at command launch. |
| Local installation | An existing installation, or a bounded collection of resource roots, that the user explicitly authorizes on this machine. Its files remain host resources even when exposed read-only. |
| Local environment | The authorized installations and execution settings available inside the sandbox. This term does not require a second machine, another installation of every tool, a container image or Nix. |
| Admission | Validation and preparation of the permissions and runtime used to start a command. |
| Execution mode | The selected `sandbox` or explicit `host` route. |
| Derived profile | A description of the effective configuration, such as `default` or `custom` in sandbox mode. It is not another activation switch. |

Apply the design to the shared `bash` and `safe_bash` route, the explicit `!s` route, and sandbox-owned bootstrap dependencies, including the internal Think/Analysis runtime. Preserve Think/Analysis restrictions when adapting those dependencies.

Keep native Pi file tools, extensions, MCP tools and browser executors outside this shell boundary. Do not describe this work as isolating the entire Pi agent process.

## Approved decisions

### D1 — Supply a private runtime for the closed default

Supply the shell, the selected basic utilities and their runtime dependencies as a sandbox-owned distribution. Make the project explicitly entrusted to Pi available with its configured permissions. Keep HOME and `/tmp` private by default, and retain existing protection of sensitive project paths.

Do not implicitly expose host `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/etc`, `/nix/store` or executable directories discovered through the host PATH. Remove these hidden grants from every participating layer, including engine defaults and internal helper setup.

Distinguish private copies mounted at familiar paths inside the sandbox from mounts of host directories at those paths. A private `/bin/bash` is part of the supplied runtime. A read mount of host `/bin` is a host opening and requires authorization.

Construct the necessary private process and device resources explicitly. Do not interpret isolation as requiring the absence of the kernel interfaces needed to execute a process. Account separately for host-side orchestration tools and files exposed to the target process.

### D2 — Authorize bounded local installations generically

Let the user authorize an existing installation or a bounded set of resource roots. Run its tools inside the sandbox under the same execution policy. Do not require a product-specific adapter, a mandatory supported-tool catalogue, or an additional host execution route.

Support an optional nonempty `files` list on each installation entry. When present, use the canonical `root` only as a base for relative paths and expose only the listed regular files. Keep explicitly covered symlink targets, installation selection and revocation within the same authorization. Do not infer dependencies or grant the containing directory.

Derive filesystem exposure and executable search paths from that authorization. Keep the resulting paths inspectable, but do not require the user to duplicate each tool installation in both `allowRead` and `environment.path` to make it usable.

Treat discovery as optional assistance for preparing an authorization. Do not grant access because a tool appears on PATH, a package manager reports it, a command failed, or an agent asks for it. Support explicit authorization of an arbitrary installation that Pi has never discovered.

Expose the authorized installation read-only unless a separate write permission exists. Explain the actual resource scope: authorizing a directory permits reading its included files, not merely executing selected commands. Do not include credentials or unrelated user data by widening the installation boundary.

Require external dependencies to fit within independently authorized roots or the private runtime. This contract supports arbitrary tools without promising that every host installation is self-contained or immediately compatible.

### D3 — Preserve machine authority and project configuration

Keep exactly these two active configuration locations:

| Location | Responsibility for local installations |
| --- | --- |
| `~/.pi/agent/sandbox.json` | Define this machine's explicitly authorized sources and their maximum resource scope. |
| `<project>/.pi/sandbox.json` | Inherit, select or narrow those authorizations for the project. Do not grant an additional host installation or expand its perimeter. |

Keep project overrides inside their projects. Do not introduce `sandbox.capabilities.json`, another active authority file, or a global `projects` registry. Preserve the separately established Docker authorization model rather than redefining it through installation permissions.

Allow each machine to use a different development environment. Do not import machine A's authority merely because a project containing its configuration is opened on machine B. Validate the local sources and their authorization on the receiving machine.

Use one authorization to describe an installation and derive its execution permissions. Apply globally enabled authorizations through the existing inheritance rules. Allow project selection or narrowing without requiring an extra `custom` activation.

Leave the exact configuration field names and command syntax to the implementation design. Do not present an illustrative schema or command as an existing interface.

### D4 — Follow updates within the authorized perimeter

Follow installation updates inside the approved resource roots. Do not pin authorization to one immutable tool version. This update behavior was explicitly selected by the user.

Revalidate the boundary at admission. Block dependencies, symlink targets and other required resources outside the approved perimeter until the user authorizes the additional access. Do not widen an authorization automatically to make an update work.

Treat a newly added file inside an approved directory as covered by that directory authorization. Treat a relocated installation or a symlink redirected outside the approved roots as requiring a new boundary decision. Following updates does not certify the behavior of new tool versions.

### D5 — Keep other resources explicit and make revocation effective

Do not infer write access, secrets, network access, service access or host execution from installation authorization. Use the existing explicit resource controls for those permissions.

Keep network access closed by default while preserving explicit domain rules such as `allowedDomains`. Keep `/tmp` private by default while preserving explicit precise sharing and the previously approved option to share all host `/tmp`. Preserve exact Unix socket permissions and separately configured TCP publications to the machine or LAN. Do not turn these defaults into immutable profiles.

On revocation, block new admissions and interrupt affected running sandbox processes that retain the revoked access. Account for open descriptors and existing mounts. Do not claim that unmounting a path or changing the next command's configuration revokes an existing process's access.

Preserve the runtime's interruption and draining model. Do not replay commands or switch automatically to host execution when a resource disappears.

### D6 — Keep mode selection separate from permissions

Keep `sandbox` and explicit `host` as the two execution modes. In sandbox mode, derive `default` or `custom` from the effective configuration. An explicit opening changes permissions and the derived description; it does not move execution to the host.

Preserve the explicit host gate. Report the selected mode, derived profile and availability consistently in the widget, shell guidance and execution evidence. Do not infer the execution mode from a lock icon or tool name.

### D7 — Preserve shared shell context and report effective permissions

Preserve commit `bb174e2e4c42faaf42b541e8d961cced491e1343`, `feat(shell): unify tool guidance and live context`, and its shared routing and presentation contracts. Preserve per-tool command rewrites and the additional Safe Bash checks.

Build permission facts from the admitted runtime and the engine's effective policy. Do not present the Pi configuration as the complete filesystem boundary while the engine injects additional mounts.

Associate execution evidence with the permissions used for that execution. Distinguish the current configured intent, the admitted state and pending reconfiguration. Refreshing model context must not authorize resources or activate a changed runtime. Preserve preparation at the next shell admission.

Keep execution-environment guidance generic. Resolve target-side paths and variables in their target environment without adding instructions specific to SFW, Go, Bun or Dev Services.

## Target resource flow

```text
Sandbox-owned runtime ---------------------------+
Project explicitly entrusted to Pi --------------+
                                                  |
Machine authorization of local installations     |
    +--> Project inheritance / selection / narrowing
             +--> Boundary and dependency validation
                         +--> Read mounts and PATH |
                                                  v
                          Admission of an effective policy
                                      |
                            Zerobox sandbox process
                                      |
                          Effective execution evidence
                                      |
                        Shared shell context and widget

Separate explicit resource grants:
network, writes, shared temporary files, sockets, publications

Explicit host selection --> Existing host execution gate
```

Validate permissions before launch and maintain revocation supervision during execution. Keep the private runtime, approved installations and project resources distinguishable in diagnostics even when they are composed into one filesystem view.

## Verified starting point

Treat the following as a qualification snapshot, not a release certification. The workspace contains independent uncommitted changes, including an installed Zerobox binary and provenance manifest. The Pi commit identifies the integration baseline, not the complete contents of a clean checkout.

| Component | Observed identity |
| --- | --- |
| Pi branch and HEAD | `develop`, `bb174e2e4c42faaf42b541e8d961cced491e1343` |
| Installed executable | `~/.pi/bin/zerobox`, version `0.3.3-fork.17` |
| Installed executable SHA-256 | `6814f2ebc1715be50b8fedc63251dd922df625b3f5c086d7637ed658cb777df3` |
| Fork source base recorded in provenance | `ebd12774aafa63fec1864e04f248150ec50136d4` |
| Fork source diff hash recorded in provenance | `1e61dc46d7bfb749b021496157d3361c7d3c86fd50fdeb47fd07dd8c323f101b` |
| Qualification platform | Linux x86_64 on WSL2, kernel `6.18.33.2-microsoft-standard-WSL2` |

Use the [installed-runtime provenance manifest](../../agent/extensions/sandbox/runtime/zerobox-provenance.json) to identify the binary. The corresponding inspected fork is at `~/projects/shared-services/sandboxes/zerobox-generalisation`.

### F1 — Both Pi and Zerobox add implicit host reads

The Pi [shell baseline](../../agent/extensions/sandbox/runtime/shell-baseline.ts) defines system read roots and executable search paths. The [policy compiler](../../agent/extensions/sandbox/runtime/policies.ts) adds them independently of user-declared `allowRead` entries.

In the inspected Zerobox fork, `crates/zerobox/src/sandbox.rs` adds `FileSystemSpecialPath::Minimal` to a restricted read policy and adds the directory containing its executable. `upstream/linux-sandbox/src/bwrap.rs` expands the platform defaults to `/bin`, `/sbin`, `/usr`, `/etc`, `/lib`, `/lib64`, `/nix/store` and `/run/current-system/sw`.

The source also contains a root-read branch for an empty read list and a `/run` grant when networking is enabled. These are source observations, not proof that every Pi invocation reaches those branches.

A live probe of the installed executable requested only a temporary project as its read/write scope, with private HOME and temporary storage. Readability checks nevertheless succeeded for `/usr/bin/bash`, `/etc/os-release`, `/etc/passwd`, `/nix/store` and `~/.pi/bin/zerobox`. An unrelated outside canary remained blocked. The command exited with code 0 and empty stderr. No file contents or secrets were printed.

This establishes excess host visibility beyond the requested roots. It does not establish unrestricted access to every host file or bypass of operating-system file permissions.

### F2 — Removing broad reads alone does not produce a working private runtime

A second installed-engine probe staged a shell and libraries, denied the broad host roots and attempted execution through the staged loader. Setup failed before the target command started:

```text
bwrap: Can't mkdir /usr/bin: Read-only file system
```

This probe demonstrates a mount-setup failure. It does not by itself demonstrate a helper-loader failure. Source inspection separately shows that helper re-entry and dynamic dependencies also need treatment: `crates/zerobox/src/linux_runtime.rs` stages the helper, and `upstream/linux-sandbox/src/linux_run_main.rs` constructs its re-entry inside the sandbox.

Pi also assumes `/bin/bash` for shell execution and `/bin/true` for an engine probe. The [Think/Analysis host setup](../../agent/extensions/sandbox/analysis/host.ts) includes host runtime paths and broad system roots. Treat these as part of the runtime boundary, not exceptions that may silently preserve host access. In contrast, host-side creation of a status FIFO in [status-channel.ts](../../agent/extensions/sandbox/runtime/status-channel.ts) does not itself require exposing the host utility to the target.

### F3 — A small private runtime and explicit installation mounts are feasible

A direct Bubblewrap fixture used copied local binaries solely for qualification: Bash, `cat`, `head`, `tail`, `grep`, `sed`, `env`, their libraries and a `/bin/sh` symlink. It contained 13 regular files totaling 5,354,256 bytes. This is a prototype size, not a final runtime content or release-size commitment.

The fixture used a read-only private root, fresh process/device resources, a writable project, private HOME and `/tmp`, a cleared environment and separate namespaces. It did not mount the host system directories. A host loopback TCP fixture was unreachable.

| Scenario | Observed result |
| --- | --- |
| Closed sandbox | Shell pipelines and writes to the project, private HOME and private `/tmp` succeeded. The ungranted custom tool was unavailable. |
| Explicit installation | A read-only installation mounted at `/opt/local-tools` supplied an arbitrary custom command and its sibling resource. The command worked, resource writes were denied, and host `/etc/passwd` and `/usr/bin/bash` remained hidden. |
| Authorization removed before a new execution | The custom tool was unavailable again. |
| Installation updated inside the approved root | A new execution observed the updated resource. A symlink to an outside, ungranted canary remained unreadable. |

All completed scenarios exited with code 0. The first installation fixture attempt lacked its mount destination under the read-only root. Creating that fixture directory and rerunning the affected scenario resolved the setup error.

Do not equate this direct Bubblewrap proof with full Zerobox/Pi qualification or security-feature parity. Running-process revocation was not tested. Temporary fixtures and copied binaries were removed after the probes; these observations are recorded session evidence, not a retained runnable test suite.

### F4 — Shared context works, but currently understates engine permissions

The focused tests for the existing shared context passed: 13 tests, 0 failures and 125 assertions across `execution-context.test.ts`, `presentation.integration.test.ts` and `model-context.integration.test.ts`, run with `agent/` as Bun's working directory.

A separate temporary diagnostic imported the real sandbox service, installed backend, private temporary lease and Bash operations. The prepared context omitted `/etc` from `filesystem.allowRead`, while the resulting command could read host `/etc/passwd`. That diagnostic passed one test with three assertions because it intentionally asserted the discrepancy. It did not validate isolation.

The current [service](../../agent/extensions/sandbox/runtime/service.ts) and [backend](../../agent/extensions/sandbox/runtime/zerobox-backend.ts) describe a Pi-materialized policy, while the engine may add more resources. Preserve the shared [execution context](../../agent/extensions/_shared/sandbox-runtime/execution-context.ts), [presentation](../../agent/extensions/_shared/shell-presentation/context.ts) and [model context](../../agent/extensions/sandbox/model-context.ts), and correct their source of permission truth.

The current configuration fingerprint does not account for all resolved runtime and mount identities. Existing resource-removal handling covers Unix sockets and TCP publications but does not establish complete revocation of file or installation access. Reuse the [shared runtime lifecycle](../../agent/extensions/_shared/sandbox-runtime/index.ts) while extending that coverage.

## Alternatives and their disposition

| Option | Disposition |
| --- | --- |
| O1 — Automatically discover and expose host tools as a default baseline | Rejected. Discovery cannot substitute for explicit authorization. Retain optional discovery only as assistance that grants no access. |
| O2 — Make the host broadly readable and maintain exclusions | Rejected as the default architecture. An exclusion list does not satisfy a closed default with explicit openings. |
| O3 — Use a dedicated execution environment | Retained with the definition in this document: a private supplied runtime plus explicitly authorized existing local installations. Do not require a second machine or reinstall every development tool. |

Do not use an assistant that merely generates today's duplicate `allowRead` and PATH lists as the architectural remedy. Keep concrete paths in the enforcement model while exposing one coherent authorization boundary to the user.

## Remaining engineering decisions and qualification limits

This section records the limits identified before implementation. The runtime guide records their implementation and current qualification scope. Preserve these original findings rather than treating the preliminary probes as release tests.

No additional blocking user decision was identified after approval of updates within the authorized perimeter. Resolve the following technical details through the future implementation plan without reopening the accepted defaults or introducing implicit permissions.

| Reference | Remaining work or uncertainty |
| --- | --- |
| R1 — Runtime distribution | Select the packaged utilities, libraries, bootstrap helpers and internal analysis dependencies. Define provenance, compatibility, supported architectures, delivery and update validation. Copying local binaries was a probe technique, not the approved production packaging method. |
| R2 — Authorization interface and enforcement | Define the exact installation schema and user interface within the two existing configuration scopes. Specify path normalization, dependency handling, mount identities and symlink boundaries. Preserve inspectability and arbitrary-tool support. |
| R3 — Effective policy and active revocation | Define the engine-to-Pi permission contract and runtime identity. Prove that revocation interrupts affected running executions and closes retained access, without replay or automatic host fallback. |
| R4 — Complete platform qualification | Replace temporary probes with durable regressions through the actual Pi/Zerobox boundary. Validate both Linux and WSL. The current evidence covers WSL2 only and does not certify full engine hardening, native Linux behavior, every existing resource grant or autonomous agent behavior. |

No source implementation, personal configuration migration, runtime installation or service restart was performed for this qualification. No dependency installation, project-wide test suite, lint or typecheck was run. The focused tests qualify the existing context contract and the explicitly described probes only.

## Migration and deferred documentation reconciliation

Preserve explicitly authorized existing grants when defining migration. Do not silently convert historical engine or Pi system-directory defaults into permanent user authorizations. Make missing authorization or unsupported dependencies visible without widening the boundary.

Include documentation reconciliation as mandatory work in the future implementation plan. Attach each correction to the behavior it documents and its acceptance evidence. Keep the following files unchanged at this design-document stage:

| Existing document or contract | Required treatment during implementation |
| --- | --- |
| [Sandbox README](../../agent/extensions/sandbox/README.md), [configuration guide](../../agent/extensions/sandbox/docs/configuration.md) and [configuration schema](../../agent/extensions/sandbox/docs/sandbox.schema.json) | Document the private default, installation authorization, machine/project scope, derived PATH, update behavior and migration. Publish the concrete schema only when defined and implemented. |
| [Runtime guide](../../agent/extensions/sandbox/docs/runtime.md), [shell capabilities](../../agent/extensions/sandbox/docs/shell-capabilities.md) and [troubleshooting](../../agent/extensions/sandbox/docs/troubleshooting.md) | Replace obsolete system-baseline claims. Explain dependency refusals, effective permissions and revocation with validated behavior. Preserve independently maintained troubleshooting changes. |
| [Bash execution README](../../agent/extensions/bash-execution/README.md) and [Safe Bash README](../../agent/extensions/bash-execution/safe-bash/README.md) | Keep routing, mode/profile descriptions, environment guidance and failure attribution consistent with the admitted runtime. |
| [ADR-023](../adr/ADR-023-zerobox-sandbox-backend.md) and [ADR-024](../adr/ADR-024-bash-execution-ownership-and-sandbox-runtime.md) | Amend or supersede the affected runtime and ownership decisions while preserving their historical rationale. |
| [Earlier isolation design](2026-09-09-sandbox-isolation-and-local-capabilities-design.md) and [shared shell context design](2026-09-12-shared-shell-context-design.md) | Mark superseded baseline assumptions and reconcile qualification claims. Preserve the shared-context decisions and the actual scope of earlier test evidence. |
| [Generalisation plan](../superpowers/plans/2026-09-10-sandbox-generalisation.md), [execution record](../superpowers/plans/2026-09-10-sandbox-generalisation-execution.md) and [activation record](../superpowers/plans/2026-09-10-sandbox-generalisation-activation.md) | Annotate affected historical conclusions or supersession when the new behavior is implemented. Do not rewrite past test results as proof of the new isolation boundary. |

Keep unrelated browser and Dev Services work outside this reconciliation. Preserve unrelated working-tree changes. Treat implementation, configuration migration and activation as distinct deliverables, and report their completion separately.
