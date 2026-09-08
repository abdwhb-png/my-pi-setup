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

Mounts are shown as **host source → container destination**, followed by
`read-only` or `read-write`. These are existing container mounts, obtained from
Docker metadata. The wizard does not read their file contents. Container state
(`running`, for example) and broker eligibility are reported separately.

| Profile | Operations |
| --- | --- |
| Observation | `ps`, `inspect`, `logs`, `stats` |
| Exploitation (default) | Observation plus `start`, `stop`, `restart` |
| Administration | Exploitation plus `exec`, subject to the target rules below |

`exec` can expose the selected container's mounts, network and secrets. Choose
Administration only when that access is required.

On a target without a host-access exception, Administration accepts ordinary
`docker exec <container> ...` and `docker compose exec -T <service> ...`.
Targeted mode refuses privileged or detached exec and non-empty detach keys.
The process keeps Docker's usual user selection.

Docker authorization and Linux file permissions are separate. A process in the
container keeps the container's normal Linux user and permissions. If arbitrary
`exec` is authorized, that process can still modify any writable host bind that
its container user can access.

The target exception is independent of the profile: choosing Administration
does not enable it. `allowUnsafeTarget: true` makes containers matching that
selector visible despite their host access, including future replacements. It
does not make arbitrary `exec` persistent. If the saved operations correspond
to Administration, the effective persistent rights are Exploitation plus these
fixed read-only probes below a declared bind destination:

```text
test -r PATH
stat -- PATH
ls -la -- PATH
```

The broker accepts only these exact argument forms. It rejects shells,
interpreters, other commands, paths outside the declared bind destinations,
environment overrides, alternate users and alternate working directories.
For example, `test -r /mounted/log` checks readability without printing the
file. If the target has no bind destination, no bind probe is available.

Use `/sandbox docker break-glass [duration]` when the current task truly
requires an arbitrary command in such a target. The duration defaults to `5m`
and accepts whole minutes from `1m` through `30m`, for example
`/sandbox docker break-glass 15m`. It requires a separate confirmation that
lists the host mounts, authorizes only the exact current container ID, remains
in memory and is never written to `sandbox.global.json`. Expiry republishes the
normal runtime and interrupts commands still running in the old runtime
without replaying them. Sandbox sends activation, expiration and interruption
feedback directly to the agent context.

## Saved, configured and active rights

The wizard always saves explicit operations. Profile names are derived from
the exact operation set, including for manually edited files. No profile field
is stored. Other sets display `Custom`; differing profiles across targets
display `Mixed`, with each target's operations listed in `/sandbox`.

The success notification shows requested, saved and effective rights after
runtime publication. Project restrictions or the host-access rule can reduce a
grant. With Sandbox disabled, the result is `saved, not active`. A failed reload
is `saved; activation failed`, and execution remains blocked until recovery.
The confirmed host-access exception and a temporary break-glass grant are shown
separately from the effective profile.

`/sandbox doctor` compares saved authority, configured rights and the active
runtime. If files changed without reloading, it reports the difference. Its
container probe checks eligibility only; it does not run `exec`, restart a
container or test every operation.

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
