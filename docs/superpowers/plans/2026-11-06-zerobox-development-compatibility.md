# ZeroBox development compatibility implementation plan

## Goal and boundaries

Complete private connected IPC, offline subprocess handling and conventional access to the selected shell runtime. ZeroBox remains consumer-agnostic. Pi retains its existing installation, cache and external-authority configuration. Public CLI, SDK and configuration schemas remain unchanged. Work in existing checkouts, preserve unrelated edits and leave Pi core and the active runtime untouched.

## Execution

- [x] Reproduce sequenced-packet IPC refusal through public ZeroBox execution, then extend the shared private-pair rule to AF_UNIX stream and sequenced-packet pairs with protocol zero and known flags. Preserve datagram and named-socket restrictions. Maintain generated upstream changes through tracked patches and `scripts/sync.sh`.
- [x] Reproduce offline socket inspection and half-close refusal, then permit `getsockname`, `shutdown` and the read-only `getsockopt(SOL_SOCKET, SO_TYPE)` query without relaxing connection, listener or other socket-option restrictions. Assert exact captured subprocess output as well as exit status.
- [x] Derive conventional aliases from validated executable shell-manifest entries, reuse the existing per-path alias mechanism and remove whole-directory alias mounts. Preserve explicit grants and denials, normalize merged-directory layouts and share computed aliases with admission reporting.
- [x] Add candidate-runtime Pi regressions using isolated authority and temporary projects/caches. Cover default pnpm scripts, Node subprocesses, npm/Bun scripts, standard helper lookup and unchanged cache isolation without client-specific runtime branches.
- [x] Run focused RED/GREEN checks, then relevant Rust and Pi regression suites. Qualify a source-pinned engine/bundle candidate through existing native CI and WSL contracts. Record provenance, hashes, failures and rollback instructions. Activation and publication remain separate. Evidence: [development compatibility verification](../../verification/2026-11-06-zerobox-development-compatibility.md).

## Acceptance

Private pairs transfer data and descriptors across affected modes without granting access to unauthorized named or abstract host sockets. Network and filesystem refusals remain effective. Offline subprocesses preserve output and half-close semantics. Conventional utility lookup works alongside exact host grants and explicit denials. Invalid manifests fail explicitly. Tests import real owners and never mutate personal authority or rely on availability checks alone.

## Baseline

Engine source: `30c3c37e9de354bfb3c666f1af52a275ea7f526c`. Installed runtime: `native-41996183653-1`. Diagnostics established that routed modes reject private sequenced-packet pairs, conventional helper lookup misses bundled utilities and offline denials of `shutdown` and `getsockname` independently cause Node subprocess errors or lost output. Socket-buffer option denials did not cause the tested failure and remain unchanged.
