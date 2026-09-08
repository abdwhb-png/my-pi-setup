# Sandbox

Sandbox is the Linux Zerobox runtime used by Bash and Think-in-Code. It keeps
filesystem, network, environment and Docker access explicit.

## Start here

1. Put ordinary Sandbox settings in `~/.pi/agent/settings.json` under
   `sandbox`, or in `<project>/.pi/settings.json` for one project.
2. Open Pi in the project and run `/sandbox doctor`.
3. Run `/sandbox on` when the status is correct.
4. If the project needs Docker, run `/sandbox docker grant` from that project.
   Choose a service and an access profile, review the change, then confirm it.
   If the broker excludes that container, review the separate target exception.

Docker is off by default. Its authority is kept separately in
`~/.pi/agent/sandbox.global.json`, never in project settings.

## Daily commands

| Command | Purpose |
| --- | --- |
| `/sandbox` | Show configured and active permissions, including Docker operations. |
| `/sandbox doctor` | Validate canonical configuration, compare it with the active runtime and check target eligibility. |
| `/sandbox on` / `/sandbox off` | Enable or disable Sandbox for this session. |
| `/sandbox docker` | Compare the saved grant, project restrictions and active Docker rights. |
| `/sandbox docker grant` | Create or replace this project's global targeted Docker grant. |
| `/sandbox docker break-glass [duration]` | Allow arbitrary `exec` for one exact current container. The default is `5m`; accepted durations are `1m` through `30m`. |
| `/sandbox docker off\|targeted\|full\|inherit` | Set a project-local narrowing of the global authority. |

## Documentation

The Docker widget shows the effective profile, target count, host-access
exception and any active break-glass grant. Observation reads container state.
Exploitation also starts, stops and restarts containers. Administration adds
`exec` on targets without a host-access exception. With that exception,
arbitrary `exec` is removed and only fixed read-only probes of declared bind
destinations are accepted. `/sandbox docker break-glass 15m` can temporarily
add arbitrary `exec` for one exact current container after a separate
confirmation.
During a reload the widget shows `reconfiguring`; new calls wait up to 30 seconds.
Sandbox sends hidden runtime feedback to the active agent when break-glass is
activated or expires. If a configuration change interrupts an execution, the
agent is told that the command did not finish and was not retried.

A saved grant can be inactive or reduced by project settings. The notification
states the actual activation outcome. Target eligibility in doctor does not
prove every granted operation works.

- [Configuration](docs/configuration.md): ordinary Sandbox settings and precedence.
- [Docker authority](docs/docker-authority.md): guided and manual Docker grants.
- [Troubleshooting](docs/troubleshooting.md): errors and corrective actions.
- [Runtime](docs/runtime.md): isolation, temporary storage and operational limits.
