# FUSE descriptor metadata runtime promotion

The daily managed ZeroBox entry selects `native-42676495778-1`, built from engine commit `05118dd83ba581d0361df4d5915b76862a8d0d65`. The qualified Pi implementation is commit `15c093b183cda9d4ce48dd6ef1cc811a20c99fad`. The tracked entry uses a relative path so the source selection remains portable to another home directory.

## Qualification and identity

- [ZeroBox Linux CI](https://github.com/abdwhb-png/zerobox/actions/runs/42676425486) passed, including library and integration suites, SDK checks, Cargo Deny, formatting and Clippy.
- [Pi native and portable qualification](https://github.com/abdwhb-png/my-pi-setup/actions/runs/42676495778) passed, including the 47 FUSE regressions, private IPC/runtime checks, explicit Pi candidate contracts, an installed-runtime session, and two installation runs each on Ubuntu and WSL2.
- [Pi lint](https://github.com/abdwhb-png/my-pi-setup/actions/runs/42676496183) passed.
- The downloaded GitHub artifact ZIP SHA-256 is `d72c2e1f99543071527a625697390af7305cfd543980d1722080cad89139ce4e`; the enclosed native archive SHA-256 is `aba21bba8643fbebb24a53e3de50707c4acdab30bcfb9e4e4a7e6ead642e2929`. Both were verified before staging.
- The engine/helper SHA-256 is `264cdca886b5d4c2e8dcb109d09034a7e41f3711f75f65c6095956d1ee9f9279`; the runtime manifest SHA-256 is `f728af77889f41be412c581c5ba3dd5f3d2db4db2e40b30c434056f5a07a022c`. Complete bundle validation passed locally.

## Daily installation checks

The existing atomic installer activated the qualified archive. A fresh local Pi session then passed the installed-runtime contract for both `bash` and `safe_bash`: one test and 16 assertions, with candidate-selection overrides unset. A direct execution against the installed private runtime also passed four checks: metadata of the original descriptor survives external replacement and unlink, while metadata remains denied after an external rename to a protected name and after that name is unlinked. The same probe reproduced the replacement-metadata failure on the former daily runtime before activation.

The personal settings and sandbox configuration hashes remained unchanged. The rollback reference retains `native-42238285159-1`, whose engine SHA-256 remains `8f6908cf42971096cb76b4c0e7efce5028a881814aaaa5f193dda0e86c1438a4`. Open Pi sessions can retain an earlier runtime; reload or start a fresh session to pin this release.

The local receipt, archive, integrity result and probe logs are preserved under `~/.local/state/pi/zerobox-promotion/20261109-fstat/`. This promotion establishes the tested correctness behavior and carries no performance improvement claim. No public binary or package release was published.
