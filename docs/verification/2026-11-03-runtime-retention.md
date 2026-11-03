# Runtime retention and local cleanup

Runtime promotion now applies the retention policy documented in the [portable setup guide](../portable-setup.md). The existing setup operator exposes the same policy through `pi-setup cleanup --dry-run` and `pi-setup cleanup`. Current and previous versions, installed package references, portable installation snapshots and live process references remain protected. Migration backups and historical package-set snapshots are outside this cleanup.

## Local verification

The affected owner suites passed 175 tests with 698 assertions across 20 files. Coverage includes cleanup preview/application, current and previous retention, package and installation references, PID reuse, legacy-session deferral, unknown directories and symlinks, automatic promotion retention, kernel lock contention, killed lock owners and descriptors inherited by in-flight children. The final RPC stream type guard was followed by another passing run of all 20 Pi fork release tests with 67 assertions.

Agent and portability-script typechecks passed. The extension boundary graph, boundary lint and storage policy lint passed. Focused production-file lint completed with zero errors and 77 warnings; warnings were not treated as a zero-warning gate. Git whitespace checks passed. These tests use temporary fake installations; they do not qualify real sandbox installation, a paid provider or the VPS. The public qualification regression list includes the new runtime storage and Zerobox staging suites, but no GitHub Actions run was dispatched for this change.

## Applied cleanup

The inspected preview and applied command both identified 28 removable directories: two old Pi releases, six inactive Pi promotion states, nine old Zerobox releases and eleven recognized obsolete recovery copies. Cleanup reclaimed 3,757,481,984 allocated bytes, approximately 3.50 GiB. A subsequent preview reported no remaining removal candidates and no warnings.

The current and previous Pi releases remain `1.1.0-00c5e7e300ba-dirty-79f8bc0b6a58` and `0.87.1-00c5e7e300ba-51024884e6e0`. The current and previous Zerobox releases remain `native-41601826009-1` and `native-40901222245-1`. Four historical recovery directories with unrecognized metadata remain intact. Migration and package-set backups were not removed.

After cleanup, SHA-256 comparisons confirmed that all 14 inspected protected files, including personal configuration, package metadata, kept manifests and executables, were unchanged. The four inspected runtime pointers also resolved to their original targets. The owner-only local receipt is `~/.cache/pi/cleanup/2026-11-03-runtime-retention.json`; it contains the preview, applied report, post-cleanup report and protected fingerprints.

This change remains local development work. The previously published `setup-2026-11-03.2` archive does not include this retention mechanism; integrating and publishing it require the normal promotion and qualification process.
