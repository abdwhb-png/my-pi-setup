# Sandbox configuration

Use `~/.pi/agent/sandbox.json` for global defaults and ceilings. Put project overrides in `<project>/.pi/sandbox.json`. Do not add a global project registry or another active configuration file.

The global document requires `version: 2` and the local `machineId`. Use `/sandbox migrate` to preview and create a valid document from an existing installation. Preserve its machine identity when editing it. A copied authority from another machine is rejected.

Use [sandbox.schema.json](sandbox.schema.json) for editor validation. It describes both document scopes. Runtime validation additionally checks ownership, machine identity, canonical resources and ceilings. A project document cannot carry `$schema`; associate the schema through the editor instead.

Both files must be regular files owned by the current user and not writable by group or others. Symlink configuration files are rejected. Global identity fields and sensitive Docker fields are rejected in a project document, even when their value is false or the feature is disabled. Unknown fields and invalid inactive sections are errors.

## Precedence

| Input | Effect |
| --- | --- |
| Built-in baseline | Project read/write roots, generic tool resources, closed outgoing network, private temporary storage. |
| Global configuration | Set the allowed resources and default restrictions. |
| Project configuration | Inherit or narrow those resources. Opt into Docker explicitly. |
| Current session | Narrow the policy or explicitly select host mode within the global ceiling. |

An absent ordinary field inherits its parent value. An empty allowlist closes that selection. Denies accumulate and take precedence. An empty effective project read selection blocks shell execution. Project configuration cannot grant resources outside the global ceiling.

Resolve relative paths from the canonical project root, including `.`. Use `~/…` for paths relative to the user's HOME. Filesystem allowlists take literal paths. Deny lists also accept globs: a pattern without a slash matches at any project depth, while a pattern containing a slash is project-relative.

## Editing ordinary resources

For example, add these fields to the existing global document, preserving `version` and `machineId`:

```json
{
  "network": {
    "allowedDomains": ["github.com", "*.github.com"],
    "allowedHostDomains": [],
    "deniedDomains": []
  },
  "filesystem": {
    "allowRead": ["."],
    "allowWrite": ["."],
    "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg"],
    "denyWrite": [".env", "*.pem", "*.key"]
  },
  "tmpNamespace": "lease-private"
}
```

A project can close external network access and require private temporary files:

```json
{
  "network": { "allowedDomains": [] },
  "tmpNamespace": "lease-private"
}
```

Set global `tmpNamespace: "host"` only when the shell should share the complete host `/tmp`. A project can then restrict it to `lease-private`. A project cannot enable host temporary storage under a private global ceiling. Think-in-Code always uses private temporary storage.

`allowedHostDomains` routes a hostname or scoped wildcard to the host loopback on its explicit port, for example `"*.dev.test:443"`. It preserves TLS and SNI. Schemes, paths, IP literals, loopback names and a bare `*` are rejected. `deniedDomains` still wins.

`network.allowLocalBinding` permits listeners inside the private network namespace. It does not publish them on the host. Outgoing network domains, local service access and incoming publication are distinct permissions.

Use `environment.path` to configure tool lookup and `filesystem.allowRead` to permit the executable and required runtime files. A PATH entry alone grants no filesystem access. The generic tool baseline is described in [Runtime](runtime.md).

## Local resources

Declare exact Unix stream sockets and TCP publications in `resources`. The global list is the ceiling. Project and session lists can only select entries from it. Missing lists inherit and empty lists close access.

For example, add this section to the existing global document, using a socket that actually exists on the machine:

```json
{
  "resources": {
    "unixSockets": ["~/run/example.sock"],
    "tcpPublications": [
      {
        "transport": "tcp",
        "scope": "host",
        "listen": "127.0.0.1:8080",
        "target": "127.0.0.1:3000"
      }
    ]
  }
}
```

A project can close both lists with `"resources": { "unixSockets": [], "tcpPublications": [] }`. Socket access exposes the functions that the service permits to the connected user. It does not filter application actions or grant neighbouring sockets. Docker's known and configured daemon endpoints remain subject to the broker policy and cannot be granted as raw sockets.

A publication requires literal IP addresses, nonzero ports and a private loopback target. `scope: "host"` requires loopback listening. LAN exposure requires a separate `scope: "lan"` entry with a precise local address. Wildcard addresses and UDP are unsupported. An incoming publication grants no outgoing network access.

The server remains inside Zerobox. Publication activates only after its private listener starts, so an ordinary concurrent command does not reserve the host port. A conflicting second server reports the conflict without replacing the first server or choosing another port. Qualification of the current implementation and its revocation lifecycle is recorded in the implementation report before activation.

## Modes and profiles

Set global `mode: "host"` to permit host execution, then select it explicitly with `/sandbox mode host` in the current session. The global value alone does not switch a session to the host. Project `mode: "host"` is refused. Return with `/sandbox mode sandbox`.

The displayed profile is derived from the effective configuration: `default` for the baseline, `custom` when it differs, and `host` for host execution. Restrictions can also produce `custom`. Restoring the baseline restores `default`. Do not configure a profile or use decision labels such as D1 as selectors.

## Applying and migrating changes

The loader rereads both documents before admitting the next shell operation. A valid change rebuilds the runtime as needed. Already admitted operations normally drain with their original configuration. Removing a Unix socket or TCP publication interrupts older runtimes that held that resource, including their other commands. Docker break-glass expiry also interrupts every runtime that held the expired grant. Invalid configuration blocks new admissions with a diagnostic. A failure never authorizes host fallback.

Use `/sandbox migrate` for historical `settings.json` sandbox sections, old `sandbox.json`, `sandbox.global.json` and `sandbox.capabilities.json`. Review the proposed global ceiling before publication. Migration preserves exact archives and unrelated settings. Use `/sandbox recover` for an interrupted transaction.

Docker target selection belongs to each project. Global Docker configuration authorizes the feature, optionally limits operations, and declares exact unsafe-target exceptions. See [Docker authority](docker-authority.md) for these separate rules.
