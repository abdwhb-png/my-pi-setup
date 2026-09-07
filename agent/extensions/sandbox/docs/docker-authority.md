# Docker authority

Docker is disabled until the current canonical project root has a grant in
`~/.pi/agent/sandbox.global.json`. This file is owner-only (`0600`), cannot be
a symlink, and is separate from project settings so a repository cannot grant
itself Docker access.

## Recommended setup

Start Pi from the target project and run:

```text
/sandbox doctor
/sandbox docker grant
```

The assistant reads `docker compose config --format json` without a shell.
It then asks for a Compose service and an access profile. If Docker Compose is
unavailable, it asks for an exact container name instead. It shows the project,
target and operations before writing anything.

The command also checks matching containers through the real Sandbox Docker
broker. A container with host bind mounts (even read-only mounts), privileged
access, or other host access can be excluded despite a matching grant.
In that case, it explains the container's access and asks separately whether
to allow the target exception. Declining either confirmation leaves the file
unchanged. If inspection fails, the command reports the failure and saves nothing.
An absent container is reported as absent; its grant can be saved for later use.

| Profile | Operations |
| --- | --- |
| Observation | `ps`, `inspect`, `logs`, `stats` |
| Exploitation (default) | Observation plus `start`, `stop`, `restart` |
| Administration | Exploitation plus `exec` |

`exec` can expose the selected container's mounts, network and secrets. Choose
Administration only when that access is required.

The target exception is independent of the profile: choosing Administration
does not enable it. `allowUnsafeTarget: true` bypasses the broker's target safety
check for that selector, including replacement containers matching it. It does
not add operations. For example, Exploitation with this exception still excludes
`exec`. Confirm it only for a workload whose host access you accept.

## Manual configuration

`mode: "targeted"` always needs `targets`. A target names either one container
or a Compose project and service. Omitting `operations` is compatible with
older files but grants every supported operation; write an explicit list for
new grants.

```json
{
  "$schema": "./extensions/sandbox/docs/sandbox.global.schema.json",
  "docker": {
    "grants": [
      {
        "projectRoot": "~/projects/shared-services/cliproxy",
        "mode": "targeted",
        "targets": [
          {
            "selector": {
              "type": "compose-service",
              "project": "cliproxy",
              "service": "cli-proxy-api"
            },
            "operations": ["ps", "inspect", "logs", "stats", "start", "stop", "restart"],
            "allowUnsafeTarget": false
          }
        ]
      }
    ]
  }
}
```

`project` is Compose's resolved project name, and `service` is the Compose
service key. Get both from the guided command or `docker compose config --format
json`; do not infer them from a container image. `container-name` is useful for
non-Compose workloads:

```json
{
  "selector": { "type": "container-name", "name": "my-service" },
  "operations": ["ps", "inspect", "logs"],
  "allowUnsafeTarget": false
}
```

`full` grants Docker engine control for one project and cannot declare
`targets`. Treat it as host control.
