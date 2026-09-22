# Mediated direct TCP: helper gate result

Status: **superseded by the implemented O1 boundary**. Promotion remains gated on the WSL2 and native release checks. No saved configuration or installed release was changed by this earlier probe.

The production implementation preserves Bubblewrap's `--disable-userns` and `--assert-userns-disabled`. A trusted outer Zerobox helper now prepares the isolated IPv4 route and reserved listeners, transfers only those listener descriptors, then executes the target in Bubblewrap's user and PID namespaces with all capabilities dropped. Focused tests cover route mutation, signaling, broker access, listener replacement, external UDP, IPv6 egress, raw IP, private destinations, and managed proxy coexistence. The exact Zerobox source is pinned by Pi provenance and the native CI workflow; this document retains the discarded provisional probe for audit history.

## Reproduction

The Zerobox worktree `codex/mediated-direct-tcp` starts at baseline commit `6bc49bb`, whose source diff SHA-256 is `e3847ff7e72eef9aa8c092f5843b07647c48ecc1e56c2e0c53d0acd1e2a6686c`, matching the installed runtime provenance. A disposable helper modification was tested there and then removed; the worktree is back at its clean baseline. The original Zerobox and Pi checkouts were not edited.

In the **actual Zerobox helper**, adding Bubblewrap setup capabilities and UID 0 inside its user namespace while retaining `--disable-userns` yielded `CapEff: 0000000000201500`, but `bind(0.0.0.0:443)` failed with `EACCES`. A direct Bubblewrap check with the same flags also failed to add the local IPv4 route with `EPERM`. Omitting `--disable-userns` made both port binding and route setup succeed. This A/B result shows that the existing Bubblewrap sequence cannot perform the required setup as written. The exact namespace ownership mechanism remains to be verified against Bubblewrap's implementation.

A provisional helper path omitted `--disable-userns` only for mediated mode, installed a replacement seccomp filter against namespace creation, dropped all target setup capabilities, put the target in a nested PID namespace, and connected an outer gateway to a one-use host Unix broker socket before target execution. Focused integration tests passed for capability removal, PID isolation, route mutation denial, listener replacement denial, raw-IP closure, disappearance of the broker socket and inherited socket descriptors, and coexistence with the managed loopback bridge. These tests establish feasibility of that **alternative**, not production security equivalence or a working direct-network feature. The disposable code is saved as `/tmp/zerobox-mediated-helper-gate-tracked-2026-09-22.patch` and `/tmp/zerobox-mediated-helper-gate-upstream-2026-09-22.patch`.

## Decision at the time of the probe

The production feature selected the first option below and proved it in the real helper. The remaining text records the gate that applied before that implementation existed.

The implementation must choose and qualify one setup boundary before exposing `network.mediatedDirectTcp`:

1. Preserve Bubblewrap's `--disable-userns` and move route/listener setup into a trusted process that still has capabilities in the network namespace's owning user namespace. This needs a different launcher or namespace setup seam; no working integration was demonstrated.
2. Keep the tested mediated-only Bubblewrap variant and formally replace `--disable-userns` with a target seccomp policy. Verify all namespace creation and entry paths (`unshare`, `setns`, `clone`, `clone3`), capability bounding and ambient sets, mount and `/proc` isolation, broker path and descriptor isolation even when exact Unix sockets are granted, signal/cancellation behavior, and WSL2/native Linux parity. The provisional filter is not yet sufficient evidence for release.

The second path is the shorter implementation candidate, but it changes an existing sandbox invariant. Continue with DNS, protocol inspection, policy, Pi admission, and promotion only after its security gate passes in the real helper. If it does not, return to the first path. Keep the global ceiling and project opt-in absent until then.
