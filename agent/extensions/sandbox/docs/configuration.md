# Sandbox configuration

Use `~/.pi/agent/sandbox.json` for global defaults and ceilings. Put project overrides in `<project>/.pi/sandbox.json`. Do not add a global project registry or another active configuration file.

The global document requires `version: 2` and the local `machineId`. Use `/sandbox migrate` to preview and create a valid document from an existing installation. Preserve its machine identity when editing it. A copied authority from another machine is rejected.

Use [sandbox.schema.json](sandbox.schema.json) for editor validation. It describes both document scopes. Runtime validation additionally checks ownership, machine identity, canonical resources and ceilings. A project document cannot carry `$schema`; associate the schema through the editor instead.

Both files must be regular files owned by the current user and not writable by group or others. Symlink configuration files are rejected. Global identity fields and sensitive Docker fields are rejected in a project document, even when their value is false or the feature is disabled. Unknown fields and invalid inactive sections are errors.

## Precedence

| Input | Effect |
| --- | --- |
| Built-in baseline | Project read/write roots, private shell commands, closed outgoing network, private temporary storage. |
| Global configuration | Set the allowed resources and default restrictions. |
| Project configuration | Inherit or narrow those resources. Opt into Docker explicitly. |
| Current session | Narrow the policy or explicitly select host mode within the global ceiling. |

An absent ordinary field inherits its parent value. An empty allowlist closes that selection. Denies accumulate and take precedence. An empty effective project read selection blocks shell execution. Project configuration cannot grant resources outside the global ceiling.

Project `filesystem.allowRead` and `filesystem.allowWrite` entries outside the global ceiling are configuration errors, not silently discarded selections. The error identifies the requested path, the project configuration, and the global authority requiring explicit authorization. Denials still take precedence over accepted selections.

Read and write allowlists use paths, not glob patterns. Use `~/projects`, without `/*`, to cover that directory and its descendants, including future projects. This global grant is inherited unless restricted by project configuration. A read grant does not grant writes.

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

`environment.path` controls lookup only; it never grants filesystem access. Values in `environment.variables` that start with `~/` expand against the host home directory, without changing the private sandbox HOME or granting read access. Shell expressions such as `$HOME` and `$(command)` stay literal. Environment values are hidden in diagnostics. Prefer named local installations for existing tools so the roots and command paths remain one authorization. The private tool baseline is described in [Runtime](runtime.md).

## Local installations

Define machine-local sources only in the global document:

```json
{
  "environment": {
    "installations": {
      "company-cli": [
        { "root": "~/opt/company-cli", "path": ["bin"] }
      ],
      "toolchain": [
        { "root": "/opt/toolchain", "path": ["bin", "tools/bin"] }
      ]
    }
  }
}
```

Each map key is an installation name. Its entries describe an absolute or `~/` root and zero or more command directories relative to that root. When `files` is absent, the root is mounted read-only once. The PATH order is selected installation command directories in global declaration order, legacy `environment.path`, then `/__zerobox/runtime/bin`. An explicit system-directory root such as `/usr` is supported, but cannot replace reserved runtime components. Use `files` to group exact file grants with an installation. Legacy `filesystem.allowRead` remains compatible for independent reads.

An installation can combine entire directories with selected files:

```json
{
  "environment": {
    "installations": {
      "local-tool": [
        { "root": "~/opt/local-tool", "path": ["bin"] },
        { "root": "/usr/bin", "files": ["node"], "path": ["."] },
        { "root": "/usr/lib/x86_64-linux-gnu", "files": ["libc.so.6", "ld-linux-x86-64.so.2"] }
      ]
    }
  }
}
```

This illustrates the format, not a complete dependency list for any particular tool. When `files` is present, authorize only the listed regular files. Do not mount the base directory or expose its other contents. File paths are relative to the canonical `root`; reject missing files, directories, empty lists and escaping paths. `path` supplies command lookup without authorizing sibling executables. A selective `root: "/"` can describe exact aliases such as `bin/sh`, but never grants `/` itself or the reserved runtime.

Declare symlink targets explicitly, either as exact files or within another selected directory root. Replacing file contents at the same approved path remains allowed. Redirecting a symlink to a new unapproved target requires another explicit authorization. No dependency discovery, automatic grant expansion or host fallback runs at command launch. Installation names are selection labels, not Pi tool names.

Keep shared dependencies in a separately named installation if useful. Select that name together with the tools that need it; selection does not infer dependencies. The installations menu previews individual file paths and retains them on save. Project restrictions and revocation apply to the derived file grants. Removing an installation does not remove independent overlapping legacy grants.

A project selects only global names:

```json
{
  "environment": { "installations": ["company-cli", "toolchain"] }
}
```

An omitted project field inherits all global installations without additional activation. An empty list selects none. Project names are filtered in global declaration order, so a project cannot reorder PATH or create a root. A session may narrow the project selection further but cannot add a name outside that ceiling.

The parser resolves `~/` and requires every global root to exist as a directory. It rejects a redirected root unless its canonical path is the declared authorization. The installation preview canonicalizes roots before saving so an explicit user decision can record the real boundary. Each declared command directory must be relative, exist, resolve inside one of the selected roots, and be a directory. Access to a command, symlink target, loader, or dependency outside the private runtime and authorized resources fails inside the sandbox. `/sandbox doctor <executable>` inspects common shebang and ELF dependencies without execution. A legacy PATH entry grants no read access.

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

Set global `host: { "allowed": true }` to permit host execution, then select it explicitly with `/sandbox mode host` in the current session. The global value alone does not switch a session to the host. Project `host` and `mode: "host"` are refused. Missing `host.allowed` denies access. Legacy global `mode` is accepted with a deprecation diagnostic, and explicit `host.allowed` takes precedence. `/sandbox migrate` rewrites the legacy alias; an already-current configuration produces no changes or archives. Return with `/sandbox mode sandbox`.

The displayed profile is derived from the effective configuration: `default` for the baseline, `custom` when it differs, and `host` for host execution. Restrictions can also produce `custom`. Restoring the baseline restores `default`. Do not configure a profile or use decision labels such as D1 as selectors.

## Applying and migrating changes

The loader watches both documents, polls once per second while processes are active, and rereads authority before every admission. A valid change rebuilds the runtime as needed. Existing work with unchanged rights drains using its original configuration. Removing a read, PATH-derived installation, socket, publication, Docker grant, or another right interrupts every affected runtime and its descendants before the replacement takes new work. Docker break-glass expiry also interrupts every runtime that held the expired grant. Invalid configuration blocks new admissions with a diagnostic. A failure never authorizes host fallback or replays a command.

Use `/sandbox migrate` for historical `settings.json` sandbox sections, old `sandbox.json`, `sandbox.global.json` and `sandbox.capabilities.json`. Review the proposed global ceiling before publication. Migration preserves exact archives and unrelated settings. Use `/sandbox recover` for an interrupted transaction.

Docker target selection belongs to each project. Global Docker configuration authorizes the feature, optionally limits operations, and declares exact unsafe-target exceptions. See [Docker authority](docker-authority.md) for these separate rules.

Git metadata inside a writable project follows ordinary filesystem rules. Explicitly deny `.git` writes when required. Git pointers and symlinks do not grant write access to external directories. Zerobox still protects `.agents` and `.codex` by default.
