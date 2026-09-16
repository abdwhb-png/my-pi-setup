# Docker authority

Docker requires two independent choices:

```text
Global sandbox.json: docker.allowed = true + security limits
                         ↓
Project .pi/sandbox.json: docker.enabled = true + targets/operations
                         ↓
Broker access to the project's targets within global security limits
```

An absent or false global authorization disables Docker everywhere. An absent project file, Docker section or enabled flag leaves Docker disabled in that project. Each project selects its own containers or Compose services without registering ordinary targets globally.

## Configure the global ceiling

Add a Docker section to the existing `~/.pi/agent/sandbox.json`, preserving its version and machine identity:

```json
{
  "docker": {
    "allowed": true,
    "mode": "targeted",
    "endpoint": "unix:///var/run/docker.sock",
    "operations": ["ps", "inspect", "logs"]
  }
}
```

A Compose selector has this form:

```json
{
  "type": "compose-service",
  "project": "my-compose-project",
  "service": "web"
}
```

Use this selector in a project's targets. Use the resolved Compose project name and service key. Do not infer them from an image name.

`allowed: true` defaults to targeted mode. In targeted mode, no project targets means no container access. Global `operations` optionally limits the supported operation set for every project. Omission permits the broker's supported set, while an empty array denies all operations. Write explicit operations on project targets. If omitted there, they inherit the global operation limit.

Global `mode: "full"` permits engine control for an enabled project without target restrictions. Treat this as host-level authority. Full mode cannot declare an operation limit. The endpoint, mode, operation limits and unsafe-target exceptions belong only in the global document. Global `targets` is rejected: put ordinary target selection in the project.

## Activate a project

Put this in `<project>/.pi/sandbox.json`:

```json
{
  "docker": {
    "enabled": true,
    "targets": [
      { "selector": { "type": "container-name", "name": "my-service" }, "operations": ["inspect"] }
    ]
  }
}
```

Or run `/sandbox docker on` from a trusted project. `/sandbox docker off` writes its disabled state. Toggling activation preserves configured target restrictions.

A project can select any ordinary target and choose operations within global limits:

```json
{
  "docker": {
    "enabled": true,
    "targets": [
      {
        "selector": { "type": "container-name", "name": "my-service" },
        "operations": ["inspect"]
      }
    ]
  }
}
```

An empty target or operations list removes that access. Other projects do not inherit these targets. Reserved fields are rejected by presence, including `allowUnsafeTarget: false` on a project target and `unsafeTargets` on a project Docker section. Invalid inactive sections are also rejected.

## Broker boundary

Use ordinary `docker` and `docker compose` commands. The runtime exposes a private broker connection and private Docker configuration. Global Docker permission does not grant raw access to the daemon socket.

The broker checks targets and operations against live engine metadata. A container with host bind mounts, privileged access or equivalent host access can be excluded despite a matching selector. `docker ps` can therefore succeed with an empty list.

To allow an exact target despite its host access, add its selector to global `docker.unsafeTargets`, for example `[{ "type": "container-name", "name": "my-service" }]`. A project must still select that target. The exception neither selects targets for other projects nor restricts their ordinary target choices. Removing the exception restores ordinary broker checks. It does not grant arbitrary persistent exec. The broker restricts such exec to these exact read-only probes below declared bind destinations:

```text
test -r PATH
stat -- PATH
ls -la -- PATH
```

Shells, interpreters, other commands, paths outside those destinations and exec option overrides remain rejected. On ordinary targets, authorized exec retains Docker's usual user selection. Targeted mode still refuses privileged or detached exec and non-empty detach keys.

Use `/sandbox docker break-glass [1m-<ceiling>m]` for a temporary exec exception. Select an eligible container and confirm the exception. The runtime rechecks the current global and project policy after confirmation and binds the exception to the exact current container ID. The accepted duration is bounded by the global `docker.breakGlassMaxMinutes` ceiling, which defaults to 30 minutes and cannot be raised from a project document. During the final 30 seconds before expiry the footer widget counts the remaining time down once per second.

The exception exists only in session memory. Its deadline remains attached to every runtime that used it, including runtimes retained while earlier commands finish. Expiration interrupts those commands. Activating a later exception does not cancel the earlier deadline. Global or project Docker deactivation blocks new admissions and terminates runtimes retaining the removed access, including descendants, before revocation completes.

## Configuration changes and inspection

Check global and project deactivation before every admission, through filesystem notifications, and once per second while processes remain active. Wait for runtimes retaining the removed access to terminate before considering revocation complete. Re-enabling one side cannot compensate for the other side being off. Retain valid inactive policy fields for a later activation.

Use `/sandbox docker` and `/sandbox doctor` to inspect configured policy and runtime state. Configuration acceptance is not proof that every engine operation succeeds. File permissions, target eligibility and container process permissions remain separate checks.

Historical `sandbox.global.json` is a migration input, not an active authority file. Migrate ordinary targets and operations to each project's `.pi/sandbox.json`. Review sensitive exceptions separately before placing their exact selectors in global `docker.unsafeTargets`. Never turn ordinary project targets into a global target registry.
