# Sandbox development fixes

> Execute this approved plan locally, with focused RED → GREEN regressions. Preserve unrelated changes and never edit Zerobox's generated `upstream/` tree directly.

## Objective

Restore a normal sandboxed development workflow. Keep host isolation, report real failures, and remove project-specific command workarounds.

## Work items

- [x] F5: Preserve helper setup diagnostics separately from target exit status and output. Correct misleading DevServices port and Windows-path errors. Surface private loopback connection failures explicitly.
- [x] F1: Eliminate concurrent synthetic mount-source races and inherited writable-helper descriptor races. Exercise concurrent commands and preservation of real user files.
- [x] F2: Permit private stream socketpairs needed by buffered subprocess I/O, without opening access to host Unix sockets.
- [x] F3: Expose session-private storage at standard `/tmp`, isolated from host and sibling sessions.
- [x] F4: Support local test listeners inside the private network namespace, retaining outbound policy and host isolation.
- [x] F6: Memoize only static policy answers and limit directory-page policy work. Preserve fresh filesystem and symlink checks with zero metadata TTL.
- [x] Integration preparation: Synchronize fork patches, preserve complete fork.12 rollback, and restore workspace-filtered Bun scripts.
- [x] Final binary: Install provenance-pinned `0.3.3-fork.15` and verify the managed binary, source tag, patch hashes and complete rollback.
- [x] Final acceptance: Keep direct dependency edits under Pi Permission System, remove the blanket OS-level `node_modules` deny, and replay every unchanged DevServices workflow command successfully through real `safe_bash`.

## Final policy boundary

Do not use Zerobox's filesystem policy to prevent the LLM from directly editing dependencies. An OS-level `node_modules` deny also blocks legitimate writes by package managers, compilers and framework CLIs. Pi Permission System remains the owner of direct `write` and `edit` authorization and denies `node_modules/*` on both surfaces.

Keep `safe_bash` compatible with normal tool behavior, including writes into `node_modules`. DevServices keeps its existing Vite loader and TypeScript cache paths. Existing Pi sessions require a full restart to load the new integration.

## Acceptance

Run focused security regressions for globs, links, mounts, namespaces, private IPC, temp isolation, setup diagnostics, and exact target exit/output. Verify original DevServices build/typecheck/test commands through Pi's real tool pipeline. Report unrelated application errors as errors, never as sandbox success. Compare host and sandbox timings and document remaining limits.

## Baseline

Zerobox started clean at `v0.3.3-fork.12` (`288a888aec15298035d67dd1ab56e5330459f5b6`). Pi and DevServices contained pre-existing work. Fork.12 is preserved as the complete rollback; the validated installed release is fork.15.
