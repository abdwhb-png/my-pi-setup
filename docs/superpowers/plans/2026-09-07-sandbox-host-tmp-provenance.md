# Sandbox host tmp and execution provenance

Implement the approved 2026-09-07 plan in the existing checkout. Preserve pre-existing changes. Keep implementation and review local.

## Approved contract

- A1: Use host `/tmp` for `bash-general`, including bash, safe_bash and user bash. Keep other sandbox protections and explicit project restrictions.
- A2: Add `think-strict` for command collection with the existing project permissions and a separate session/cwd lease. Keep a fresh private lease for each `analysis-strict` request. Set `TMPDIR=/tmp` and mount private tmp for both Think profiles. Never fall back to development or host execution for Think.
- A3: Record factual execution status (`sandboxed`, `unsandboxed`, `unknown`), profile, backend, tmp namespace, phase, outcome and real exit status at the execution boundary. Distinguish setup, process, policy and cleanup errors.
- A4: Persist provenance in tool details and expose a compact receipt in model context. Share transient records through a process-global Symbol registry. Do not infer a backend from a tool name or the current session setting.
- A5: Preserve separate source and analysis provenance in Think success/error JSON and batch items. Read file sources on the host, then analyze in the sandbox. Keep raw output out of Think public results.
- A6: Preserve provenance through Save Tokens, keep text archives byte-for-byte unchanged, and add companion metadata with source provenance and host storage. Prune text and metadata together.
- A7: Identify archives as tool-output text, exempt archive reads from recompression, support paginated native read, and never claim filesystem artifacts were archived. Keep private Think files private, without adding export. Keep Think excluded from Save Tokens compression.

## Acceptance

- V1: Verify host -> shell and shell -> native tool visibility of `/tmp`, including explicit project restrictions.
- V2: Verify Think collection and analysis private tmp, sibling isolation and lease cleanup against real Zerobox.
- V3: Verify success, nonzero exit, timeout, cancellation, policy refusal, disabled runtime, setup failure and protocol failure without changing real stdout/stderr or exit codes.
- V4: Verify the real Pi tool/hook/provider pipeline, compression on/off and registration order, concurrent calls, historical results and non-text results.
- V5: Verify exact archive retrieval, fullOutputPath, pagination, legacy archives, archive failure and retention.
- V6: Verify a fresh Pi process and the Bun/Vite Dev Services workflow without modifying central services. Record source and binary resolution.

Use focused RED -> GREEN -> REFACTOR cycles, then focused diagnostics and a shared-interface typecheck. Do not upgrade dependencies or Zerobox. Keep Unix-socket, network, filesystem and Docker restrictions except the approved development tmp change.

## Execution record

Implementation started on `develop` with existing dirty files. Validation results will be recorded in the companion verification report.
