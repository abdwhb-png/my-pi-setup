# A1 corrective review: F1 and F2

## Result

The local targeted review passes with no remaining actionable finding identified in the corrected scope. F1 and F2 are closed. The original failing reproductions now pass without modification. Publication and activation (A2) have not started.

The corrections are uncommitted changes on fork candidate `77741169d455bd4ab4f65037c226c4ce644ff8e4`. Harness implementation remains at `9b6ca13f6c6be8e4713760c8d385584984f6a60b`. The exact reviewed fork diff and changed-file SHA-256 hashes are recorded in `/tmp/pi-o3-corrections-Md8mxF/validation.json`.

## F1: Native remote placement

The remote launch serializer now distinguishes unused conditional catalogue entries from required extension contracts. An empty catalogue or a conditional provider that the launch does not select no longer blocks remote placement. Selected extension paths, unconditional requirements, and `requireForAllRunners` entries remain rejected before provisioning.

The regression tests invoke the real child-launch builder and placement-aware factory. Two positive cases failed before the fix and pass afterwards. The negative test for mandatory runtime providers passes throughout. Remote provisioning is replaced at the existing factory boundary, so these tests make no network connection.

## F2: Empty catalogue retention

Workflow admission now retains the complete captured catalogue, including `[]`. The persistence owner writes empty catalogues, preserving the distinction between an explicit snapshot and an absent legacy file. Foreground history and detached recovery descriptors also preserve `[]` instead of omitting it based on array length. No new configuration or per-agent extension list was introduced.

Verified RED failures covered empty persistence, both foreground and asynchronous workflows, and resume from both foreground and asynchronous runs after the host acquired a new provider. All now pass. Additional append coverage verifies that queued steps inherit the stored empty catalogue. Tests import production modules and use the repository's existing child-process fixture.

## Final checks

| Check | Result |
| --- | --- |
| Focused fork unit suites: remote placement, conditional providers, mandatory contracts, preflight, recovery | 121 passed, 0 failed |
| Focused workflow, append, recovery and resume integration scenarios | 11 passed, 0 failed |
| Harness provider discovery, shared API, and real Pi resource-loader composition | 21 passed, 0 failed |
| Original F1 and F2 reproductions | 2 passed, 0 failed |
| Final catalogue tests after removing unnecessary test casts | 3 passed, 0 failed |
| Fork `npm run typecheck` | Passed |
| Lint on changed TypeScript files compared with the pre-correction candidate | 0 added diagnostics, 1 removed |
| Diff whitespace validation | Passed |

Lint remains nonzero because the compared files contain 1,175 existing diagnostics, down from 1,176. No lint rule, suppression, or configuration was changed. Async workflow fixtures still report the existing missing `sendMessage` notification stub, including the previously committed conditional-provider test. These diagnostics remain visible in the logs and are not treated as production failures or silently suppressed.

The final review reread all four changed production files and their affected consumers. It checked remote admission, selected versus retained provider semantics, legacy absence versus explicit emptiness, workflow persistence, append propagation, and both recovery paths. Raw RED/GREEN and final-check evidence remains in `/tmp/pi-o3-corrections-Md8mxF/`. The original review evidence remains in `/tmp/pi-o3-review-gj7gnP/`.

## Limits and preserved state

This is a local corrective review, not an independent delegated review. Full repository suites were not rerun, and their previously documented failures remain an existing qualification limit. No fresh live model test or actual remote connection was performed for these corrections. The earlier live qualification is retained as historical evidence for the local delegation paths.

The daily installation and runtime were not changed. No dependency installation, version bump, commit, merge, push, or publication was performed. Candidate changes remain available for the next explicit integration decision.
