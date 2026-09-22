# Mediated direct TCP for the Zerobox sandbox

Date: 2026-09-22
Status: architecture and error contract approved; bounded configured ports selected; O1 helper boundary implemented; promotion pending the WSL2 and native release gates below.

## Destination

Allow proxy-ignoring programs to make explicitly authorized direct TCP connections from Pi's Zerobox shell across projects, without teaching Pi or Zerobox about Socket Firewall or any other specific tool. Keep sandbox isolation by default, the current `sandbox` and `host` modes, and the existing global `~/.pi/agent/sandbox.json` and project `.pi/sandbox.json` authority locations. A direct-transport grant must not be inferred from `allowedDomains` alone. Connections whose requested hostname cannot be evaluated under the existing domain policy fail closed. No automatic host fallback is permitted.

The requested policy guarantee matches the current HTTP `CONNECT` proxy contract: evaluate a client-presented hostname and use a policy-checked destination. It does not promise to prevent deliberate domain fronting inside an encrypted tunnel. This distinction was explicitly selected during brainstorming.

## Verified starting point

| Finding | Evidence and limit |
| --- | --- |
| F1 — Current egress is proxy routed | Pi turns effective `network.allowedDomains`, `allowedHostDomains`, and `deniedDomains` into Zerobox `allow_net`, `allow_host_net`, and `deny_net` in [zerobox-backend.ts](../../agent/extensions/sandbox/runtime/zerobox-backend.ts). The fork creates a managed proxy and private bridge; `~/projects/shared-services/sandboxes/zerobox-generalisation/crates/zerobox/tests/sandbox/net.rs` rejects direct, CONNECT, and SOCKS bypasses. The fork source is not the installed binary. |
| F2 — Authority and revocation already have seams | [authority.ts](../../agent/extensions/sandbox/capabilities/authority.ts) validates known network fields; [policy.ts](../../agent/extensions/sandbox/capabilities/policy.ts) applies global ceilings and project/session narrowing; [revocation.ts](../../agent/extensions/sandbox/capabilities/revocation.ts) detects removed access. [admission.ts](../../agent/extensions/sandbox/runtime/admission.ts) compares the materialized engine report with the submitted policy. |
| F3 — SFW's supported path differs from unsupported probes | Socket lists npm, yarn, pnpm, pip, uv, and cargo as supported by [SFW Free](https://github.com/SocketDev/sfw-free); Bun is not guaranteed. Socket says Free has [no chained HTTP proxy](https://socket.dev/blog/socket-firewall-enterprise). The earlier [SFW audit](../audits/2026-09-09-safe-bash-dev-services-sfw.md) observed direct-DNS failures in diagnostic `sfw curl` and a wrapper-cache write failure. Those do not establish that every supported package-manager command fails. |
| F4 — Current supported-manager controls | With the installed Zerobox runtime `2026.09.19.1`, `SFW_SKIP_UPDATE_CHECK=1 sfw npm view is-number@7.0.0 version` and `sfw npm pack is-number@7.0.0 --dry-run --ignore-scripts --json` returned success with fresh private npm caches. An in-memory deny-all policy failed at `firewall-api.socket.dev` DNS; an in-memory policy allowing Socket but denying `registry.npmjs.org` returned Zerobox's registry-domain denial and npm E403. These commands installed no package. They do not prove an SFW malware-block decision or that the normal wrapper update path works. No saved policy changed. |
| F5 — Transparent route is possible in a disposable namespace | On this WSL2 host, `ip route add local 0.0.0.0/0 dev lo` let a direct client connect to synthetic `203.0.113.10` and let a gateway observe the original destination. An unhandled port failed immediately. A Bubblewrap run required temporary `CAP_NET_ADMIN`; after `CAP_NET_ADMIN` and `CAP_SETPCAP` were dropped, the client retained the route, had `CapEff=0`, and could not add another route. This proves a narrow namespace setup, not Zerobox integration. |
| F6 — Disposable policy probes | A local DNS stub returned an A record for `allowed.test` and refused `denied.test`. HTTP allowed the matching Host and destination IP, and denied a raw IP Host, wrong IP, and denied Host. A direct TLS probe relayed `allowed.test` after observing SNI and denied a different SNI, absent SNI, wrong IP, and a synthetic ClientHello containing ECH. A Unix-socket broker outside Bubblewrap answered an allowed HTTP request while the sandboxed client could not reach the host loopback listener directly. These probes used synthetic addresses, a self-signed certificate, and local traffic only. |
| F7 — Existing bridge and DNS constraints | The fork's `upstream/linux-sandbox/src/proxy_routing.rs` rewrites managed-proxy variables to namespace loopback listeners and bridges them to host-side Unix sockets. In the disposable namespace, the catch-all local route preserved the more specific `127.0.0.1` route, but coexistence with the actual Zerobox bridge remains untested. `upstream/linux-sandbox/src/landlock.rs` currently rejects target IPv4/IPv6 datagram sockets in proxy-routed mode, so a DNS stub by itself does not let ordinary target resolvers send UDP queries. |

The installed release is the runtime selected through `~/.pi/bin/zerobox` on this WSL2 host. Source behavior, disposable Bubblewrap behavior, and installed Zerobox behavior remain separate evidence levels.

## Selected path and alternatives

**O2 — Generic mediated direct TCP, conditional:** add a separate transport capability at the Zerobox network seam. Pi resolves the existing authority, sends both destination policy and transport rights, and verifies the engine's admission report. Zerobox owns interception and passes hostname evaluation to its existing network policy implementation. This fits the requested tool independence and preserves filesystem/process isolation.

- **O1 — Repair the SFW wrapper/current proxy only:** useful as a separate integration fix, but it leaves proxy-ignoring tools unsupported.
- **O3 — Explicit host executor for dependency commands:** can make SFW's direct calls work, but child scripts lose Zerobox filesystem, network, and process restrictions. Invocation filtering does not contain child processes.
- **O4 — Existing explicit `host` mode:** no engine work, but the whole shell executes outside Zerobox until the user changes mode.
- **DNS-to-IP grants alone:** rejected. Shared IPs, raw-IP reuse, and rebinding would silently turn a domain rule into a broader IP rule.

The selected feature path remained conditional until the later O1 helper implementation proved the required boundary in Zerobox.

## Configuration and admission contract

Use the two existing configuration files. Proposed field name and shape:

```json
// Global ~/.pi/agent/sandbox.json, alongside existing network fields
"network": {
  "allowedDomains": ["packages.example.test"],
  "mediatedDirectTcp": { "allowed": true, "ports": [443] }
}
```

```json
// Project .pi/sandbox.json
"network": {
  "mediatedDirectTcp": { "enabled": true, "ports": [443] }
}
```

These fragments illustrate fields inside the existing JSON files; comments are explanatory and are not valid JSON file content. The global entry is a machine ceiling, and the project must opt in. Both default to off. The effective direct ports are the intersection of the global and project lists; session policy can narrow but cannot enable the capability. The configured port list is bounded to 64 canonical entries. Existing domain allows/denies still govern every destination. The direct TCP listener port must also be granted, even when an existing domain rule has no port. `allowedHostDomains` and local-service routing remain on their existing managed-proxy path. An attempted project enablement outside the global ceiling is a configuration error.

The exact field spelling is an interface proposal, not a promise about current parsers. Unknown fields remain errors until implementation. Pi's admission and widget must display domain authority and direct transport separately. A versioned engine admission report must carry the effective direct transport and port set; Pi must reject a missing, broader, or unsupported report. An older installed engine must fail admission if the new capability is requested.

## Data flow and security invariants

1. Zerobox prepares a private network namespace. A trusted setup phase reserves DNS and configured TCP listener ports and installs a local route for otherwise unreachable IPv4 destinations. Extend the existing namespace bridge lifecycle and private host-side Unix-socket channel instead of creating a second bridge framework. The disposable Bubblewrap proof required temporary `CAP_NET_ADMIN`, `CAP_SETPCAP`, and DNS binding privilege. The target command must start only after those privileges are removed from its effective, inheritable, ambient, and bounding sets, and after `no_new_privs` and the existing seccomp restrictions apply. The trusted mediator must not be killable or reconfigurable by the target.
2. A namespace DNS stub sends policy and resolution requests to an engine-owned host-side broker over a protected channel. The broker uses the existing domain policy and local/private-address checks. It returns short-lived answers only for allowed names. Denied names, private rebinding, and resolver failure fail closed. The DNS response and the later TCP decision must be bound closely enough to reject a destination IP that was not an answer for the asserted hostname. Before implementation, resolve the current seccomp conflict: ordinary DNS clients need UDP datagrams, which the target currently cannot create. A possible solution is allowing UDP sockets within the route-isolated namespace while proving they cannot reach external addresses; a TCP-only resolver path must demonstrate comparable client compatibility. Neither mechanism was proved by the disposable spike.
3. A direct TCP connection on a configured port reaches a trusted namespace gateway. It captures the original destination IP and port and forwards bounded initial bytes plus destination metadata to the host-side broker. No upstream connection starts before policy acceptance. The broker evaluates HTTP/1.1 Host or TLS ClientHello SNI through the same domain policy used by the managed proxy, checks the destination against its resolution, and dials or rejects. HTTP/2 prior-knowledge cleartext, opaque protocols, absent SNI, ECH, malformed or fragmented handshakes exceeding limits, and raw-IP requests without a matching hostname fail closed. A production parser must handle ordinary fragmentation safely; the disposable parser did not.
4. The existing HTTP/SOCKS proxy route stays available and obeys the same domain policy. All other direct sockets remain inside the isolated namespace; external UDP/QUIC and unsupported IPv6 egress are blocked until separately designed and tested. If local DNS uses UDP, that permission must not create external UDP egress. The broker socket and route-control capability must not be exposed to the target. A command may not gain access through a new transport merely because a domain is listed.
5. Removing a domain, direct-transport activation, or a direct port grant interrupts affected descendants and closes outstanding broker connections before replacing the admitted policy. There is no host fallback.

The broker authenticates its private channel and owns policy evaluation and upstream dialing. It must not trust a hostname asserted solely by a target-controlled process. Matching the current `CONNECT` contract accepts the residual possibility of deliberate domain fronting on shared infrastructure. It does not authorize a raw-IP route without an observable allowed hostname.

## Error handling and user presentation

Configuration failures identify the missing global ceiling or invalid project request. Setup failure reports the route, listener, or broker stage without admitting the command. Connection denials distinguish `domain denied`, `no observable hostname`, `hostname/IP mismatch`, `unsupported protocol`, and `mediator unavailable`; include only host and port, not URL paths, query strings, credentials, or environment values. The status display shows `proxy only`, `mediated direct TCP pending`, or `mediated direct TCP admitted`, along with its configured ports and effective domain policy. It must not claim SFW or any executable is healthy merely because transport was granted.

## Proof gates before production implementation

- **G1 — Namespace and privilege:** in the actual Zerobox helper, not only plain Bubblewrap, prove route/listener setup before target execution, capability drop, `no_new_privs`, seccomp, private PID/process supervision, and that the target cannot change routes, bind/replace a reserved gateway, signal the trusted broker, reach its private socket, or reach host network around it. Prove the existing managed proxy and local-service bridges still work with the catch-all route.
- **G2 — Port mechanism:** the disposable local route preserves destination ports. It proves interception only where a listener exists. Either keep an explicit bounded port list as proposed or demonstrate a separate secure all-port interception mechanism before expanding the interface. No silent promise of arbitrary TCP ports.
- **G3 — Identity and policy:** allowed and denied domains, exact and wildcard rules, precedence, port narrowing, SNI/HTTP Host, raw IP, mismatched IP, ECH, malformed and fragmented ClientHello, shared-IP fronting within the accepted `CONNECT` contract, DNS rebinding, DNS timeout, redirect, private/metadata IP, IPv6, and UDP/QUIC bypass attempts. Establish a target DNS path compatible with ordinary resolvers while keeping external UDP closed.
- **G4 — Lifecycle:** admission report and runtime provenance, setup failure, concurrent children, cancellation, policy reload, revocation of one domain or port, broker crash, stalled connection, resource limits, and cleanup. Revocation must be demonstrated with live descendants.
- **G5 — Consumer proof:** run a supported SFW package-manager operation with a fresh disposable cache and no installation, showing its actual destination and SFW decision path. Keep the wrapper-cache/update issue as a separate fix. Test Bun separately because SFW Free does not guarantee it. Do not use `sfw curl`, `sfw bun`, a cached package, or `sfw --version` as the general acceptance criterion.
- **G6 — Release qualification:** focused Rust/Pi contract tests, warnings-denied Clippy and relevant boundary checks, candidate runtime staging, installed-runtime WSL2 end-to-end tests, and explicit provenance. Native Linux CI is a separate evidence target.

## Disposable spike limits and handoff

The spike used temporary Python standard-library scripts, existing `ip`, `unshare`, Bubblewrap, `setpriv`, OpenSSL, and curl. It installed no dependencies, modified no Pi or Zerobox source, did not write the user's sandbox configuration, did not access external sites, and did not run a package installation. The disposable checks were:

| Probe | Observed result |
| --- | --- |
| `unshare -Urn` plus `ip route add local 0.0.0.0/0 dev lo` | `curl` to synthetic `203.0.113.10:18080` reached the wildcard listener, which observed that destination via `getsockname`; an unbound port failed to connect. |
| Namespace DNS and HTTP | `allowed.test` resolved and returned HTTP 200. `denied.test` did not resolve; forced denied Host, raw-IP Host, and a wrong destination IP returned HTTP 403. |
| Namespace TLS | A matching SNI and destination relayed to a local self-signed TLS origin and returned HTTP 200. Denied SNI, absent SNI, wrong destination IP, and a synthetic ECH extension were rejected. |
| Bubblewrap setup and capability drop | The route could not be installed with Bubblewrap's default capability set. Granting temporary `CAP_NET_ADMIN` and `CAP_SETPCAP` allowed setup; the target then had `CapEff=0` and route mutation failed. Binding the DNS listener before dropping privileges allowed the same DNS/HTTP decisions. |
| Host-side Unix-socket bridge | A sandbox gateway reached a host broker and returned its response; a direct call to the host loopback listener failed. The broker socket was visible in the disposable mount setup, so this is connectivity proof only. |

These results establish local-route interception on fixed ports, a DNS/HTTP and simple TLS policy path under disposable conditions, privilege drop for the client, and a Unix-socket host bridge. They do **not** establish compatibility with Zerobox's proxy-routed seccomp, a hardened broker isolation boundary, robust parsers, arbitrary ports, IPv6, real Zerobox helper admission, live revocation, or production safety.

Implementation should start with G1 and G2 in a disposable Zerobox candidate. If either cannot preserve the stated domain and isolation contract, stop and revise this design before changing Pi's public configuration schema. Keep the SFW wrapper-cache issue separate from the generic network capability.
