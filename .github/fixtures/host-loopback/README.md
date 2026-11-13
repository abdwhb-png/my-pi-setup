# Host loopback transport feasibility

Run `python3 .github/fixtures/host-loopback/probe.py` only on a disposable GitHub Actions Linux host. The script refuses ordinary local execution before creating namespaces, listeners or mounts. The `host-loopback-transport` job prepares signed distribution packages and the required kernel modules.

This experiment tests a possible transport for an explicit global `network.hostLoopback.allowed` permission. It is not a production implementation of that option, a Zerobox qualification, or authorization to enable it. The production configuration and native runtime integration require separate qualification against the exact candidate artifact.

The child creates separate user, mount and network namespaces. A namespace-local hosts file maps `host.localhost` to the reserved experiment address `198.18.0.1`. One namespace-local NAT rule redirects TCP to that address into one listener, regardless of destination port. The listener descriptor is transferred to the host process; the host relay obtains the original destination with `SO_ORIGINAL_DST`. The target drops its capabilities before sending requests.

Success requires distinct host and private services on the same port, access to an IPv6-only host service created after namespace setup, refusal before dispatch to a denied destination, and inability for the target to alter network rules. All listeners, temporary files and child processes are cleaned up. The relay implements only the bounded experiment's request/reply exchange, not a general production stream proxy.

The production implementation must reuse Zerobox's managed proxy for actual authorization and full-duplex transport; preserve explicit denials and namespace isolation; install routing before capability lockdown; and reject unsupported kernels without a host-execution fallback. Native changes belong in Zerobox's maintained sources and upstream patches. No Pi core change is needed.
