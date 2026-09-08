# Sandbox configuration

Put ordinary Sandbox configuration in `~/.pi/agent/settings.json` under the
`sandbox` key. A project can narrow or override it in
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

The effective `enabled` value is resolved in this order: `--no-sandbox`,
`PI_SANDBOX_SESSION_STATUS`, session state, project settings, global settings,
then the built-in default. Filesystem, network and environment settings still
come from the merged project and global configuration.

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
