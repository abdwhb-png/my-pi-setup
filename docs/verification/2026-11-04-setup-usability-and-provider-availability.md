# Setup usability and provider availability verification

Date: 2026-11-04. Status: implemented working-tree changes; not committed, pushed, promoted or published.

## Behavior and ownership

The existing setup operator now reports stages and elapsed waits on stderr, keeps final results on stdout, provides contextual help and actionable usage errors, and prints concise previews with optional `--details`. The asynchronous command runner preserves secret redaction, bounded capture and inherited runtime locks. Packaging and extraction use the same archive implementation. Cleanup retains its JSON stdout contract and creates no persistent operator log.

The profile capture owner excludes global skills unless `pack --include-global-skills` is explicit. It also removes legacy generated portable-skill references from the default exported profile. Repository skills and package selection remain intact. Upgrade coverage verifies that managed old copies disappear while unmanaged additions survive.

CPA distinguishes live, authoritative empty and unavailable catalogs, withdraws unavailable models, preserves metadata caches, and prevents metadata refresh from restoring an unavailable provider. Startup awaits verification, including without a cache. Input and compaction are blocked for an unavailable active CPA model. Warning deduplication resets on state transitions; a headless child using another provider does not report an unrelated CPA outage as an execution failure. Native initial model fallback remains unchanged.

The setup-only follow-up uses Pi's public `ProviderConfig.refreshModels` callback so native catalog refresh shares CPA's verification TTL and in-flight request with the lifecycle gates. CPA remains registered with an empty model list during outages or an authoritative empty catalog, preserving its refresh callback for recovery. Pi owns native registry publication; the callback does not re-register itself and accepts provider state only through the generation-checked `RefreshModelsContext.publish` operation. Offline/cache-only callbacks perform no network request and never promote an unverified disk catalog. Metadata reprojection survives later TTL-cached validation. The extension does not mutate scoped preferences or access private Pi state.

Scope correction on 2026-11-04: changes to `~/engineering/pi-core` were made without the required explicit authorization and have been withdrawn. The selector source change, its regression test and the new runtime-candidate workflow are no longer part of this delivery. The remaining implementation is confined to the setup repository.

## Executed checks

- Initial combined check, before the setup-only native-refresh follow-up: `bun test --isolate bin/setup extensions/ai-providers ../.github/scripts/qualify-portable-setup.test.ts`, from `agent/`: 230 passed, 1 explicitly gated integration test skipped, 839 assertions across 22 files.
- Follow-up check: `bun test --isolate extensions/ai-providers`, from `agent/`: 197 passed, 1 explicitly gated runtime contract skipped, 615 assertions across 12 files. This covers native callback failure, recovery and empty catalogs, cache-only initialization, rejected publication, pre-aborted requests, retained metadata and active-model validation after registry publication.
- Public CLI regression tests observe verification feedback before releasing a blocked fake subprocess, verify stdout separation and credential masking, and exercise per-command help, invalid arguments and absent installation/recovery states.
- Packaging tests exercise both global-skill policies using real temporary archives and inventories; upgrade and rollback tests use isolated roots with fake provisioning.
- `bun run typecheck`, from `agent/`: passed. The portable qualification TypeScript configuration also passed during implementation.
- `bun run lint`, from `agent/`: passed, including extension boundaries and storage ownership guards; repository warnings remain. No zero-warning claim is made.
- Follow-up validation: `bun run typecheck`, `bun run lint:boundaries`, focused Oxlint on the five changed provider source/test files and the storage lint on the two changed production files passed. Focused lint reports five existing warnings in the headless-diagnostic parser. Task files were formatted through the repository formatter with a temporary configuration admitting the normally excluded test files; the temporary file was removed.
- Historical check of the subsequently withdrawn fork patch: all 4 selector tests passed using the faux provider. This is not validation of a delivered fork change. Two missing ignored catalog data files were temporarily restored from the already installed frozen Pi package to permit source imports, then removed after checking their contents were unchanged (20,637 bytes reclaimed); no provider endpoint was used.
- Historical configuration check: workflow YAML, 11 Bash programs and embedded runtime qualification TypeScript parsed successfully. The added fork workflow was subsequently withdrawn. Four unchanged PowerShell programs were not checked.
- `git diff --check`: passed.

RED failures were observed for default global-skill capture, legacy portable references, contextual CLI help and diagnostics, silent subprocess execution, CPA fallback publication, unavailable input, authoritative empty cache persistence, awaited startup verification, warning state transitions and headless child diagnostics before their corresponding corrections. The native-refresh follow-up also observed RED failures for the missing public callback, metadata being reset by TTL-cached validation and missing active-model validation after publication. The scoped-row regression exercised only the subsequently withdrawn fork patch.

## Remaining boundaries

During the unauthorized fork work, `npm run check` stopped in `check:runtime-deps`: the local installation contained TypeScript 5.9.3 while its manifest and lockfile specified 7.0.2, and `typescript/unstable/ast` could not be resolved. This is historical evidence from the withdrawn work, not a prerequisite for delivering the setup-only changes. No dependency synchronization or runtime build was performed on the workstation.

The existing runtime's scoped model selector can retain a previously scoped model after an extension withdraws it. The setup extension removes unavailable CPA models from its registry projection and blocks CPA input and compaction, but full absence from every selector view is not established. This remains an explicit limitation; no fork change, rebuild or replacement runtime is authorized by this task.

The public setup qualification now includes the ai-providers regressions and enables `PI_CPA_AVAILABILITY_CONTRACT=1` only in CI. The gated test loads the real extension through pi-test-harness, uses a loopback HTTP catalog fixture, refuses non-fixture fetches and generation, and verifies startup unavailability, native catalog refresh, withdrawal, blocked input, recovery, an empty live catalog and explicit `/cpa-refresh` recovery. It asserts that scoped model preferences remain unchanged. It was deliberately not executed locally.

The current promoted runtime and frozen Pi fixture remain unchanged. The fork working-tree edits and added workflow were withdrawn; none was committed or pushed. No release, main promotion, external provider generation or VPS operation is covered by the local checks above. The previously deferred legacy GitHub lint workflow is unchanged.
