# Sandbox configuration

Put ordinary Sandbox configuration in `~/.pi/agent/settings.json` under the
`sandbox` key. A project can narrow local grants in
`<project>/.pi/settings.json` under the same key. Legacy `sandbox.json` files
remain readable.

```json
{
  "sandbox": {
    "enabled": true,
    "filesystem": {
      "denyRead": ["~/.ssh", "~/.gnupg"],
      "allowWrite": ["."],
      "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
    },
    "network": {
      "allowedDomains": ["github.com", "*.github.com", "localhost:8317"],
      "allowedHostDomains": ["*.dev.test:443"],
      "deniedDomains": []
    }
  }
}
```

Treat these settings as preferences, never as host authorization. The example
allowlists take effect only inside locally granted rights. Run `/sandbox
capabilities migrate` to review an existing installation once. New installations
start isolated with closed network and private `/tmp`.

Select `sandbox.profile` as `isolated`, `integrated` or `host`. A project profile
can only lower the user-selected profile. Set `sandbox.tmpNamespace` to `lease-private` to
suppress a saved shared-tmp grant. Set `sandbox.integrations` to a list of
integration names to restrict which saved integrations are usable. Explicit
domain lists intersect grants; read/write preferences remain within authorized
roots. Fixed and explicit denies remain enforced. An empty resulting read
selection blocks shell execution instead of becoming unrestricted access.

Use `/sandbox profile ... [--session]` for user selection and `/sandbox
capabilities grant|revoke ... [--session]` for authority changes. Legacy disabled
settings request host execution; they cannot disable Think's strict engine or
create a host grant. See [profiles and migration](shell-capabilities.md).

Use relative patterns from the project root. Only `denyRead` and `denyWrite`
accept globs. A pattern without `/`, such as `*.pem`, matches at every project
depth. A pattern containing `/`, such as `generated/**`, is project-relative.

`allowedHostDomains` routes an exact hostname or scoped wildcard to the host
loopback on its mandatory port. It preserves raw TLS and SNI, so a host reverse
proxy can select the intended local project. Schemes, paths, IP literals,
loopback names and the global `*` wildcard are rejected. `deniedDomains` still
wins, and no other host port, Unix socket or service is exposed.

Docker authority does not belong in these settings. See
[Docker authority](docker-authority.md).
