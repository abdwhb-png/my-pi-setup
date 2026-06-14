# session-cron

Periodic polling and monitoring during a session, exposed as `/cron`.

## Commands

| Command | Description |
|---------|-------------|
| `/cron [interval] <prompt>` | Schedule a recurring prompt (executes immediately + on schedule) |
| `/cron list` | List all scheduled tasks |
| `/cron show <id>` | Show details for a scheduled task |
| `/cron delete <id>` | Cancel a task by ID |
| `/cron remove <id>` | Cancel a task by ID |
| `/cron clear` | Delete all scheduled tasks |
| `/cron help` | Show command help |

## Usage

```
/cron 5m check if the deployment finished
/cron 2h run the integration tests
/cron check deploy every 30m
/cron check the build                    (defaults to 10m)
```

## Interval syntax

| Unit | Examples | Cron expression |
|------|---------|-----------------|
| Seconds | `30s` | Rounded up to nearest minute (`*/1 * * * *`) |
| Minutes | `5m` | `*/5 * * * *` |
| Hours | `2h` | `7 */2 * * *` (off-minute to avoid thundering herd) |
| Days | `1d` | `0 0 */1 * *` |

Intervals that don't divide their unit evenly are rounded to the nearest clean value (e.g., `7m` → `6m`, `90m` → `2h`). The extension tells you when it rounds.

## Behavior

- **Executes immediately** on `/cron` — doesn't wait for first cron fire
- Tasks fire **between turns** — never interrupts the agent mid-response
- One task fires at a time per check cycle
- **Deterministic jitter**: tasks fire up to 10% of period late (max 15 min). Avoids thundering herd on `:00` and `:30`.
- Tasks auto-expire after **7 days**
- Expired recurring tasks get **one final run** and are then deleted
- Max **50 tasks** per session
- Persisted to `.pi/session-cron.json` and restored on next session start
- Rehydration uses `lastFiredAt ?? createdAt` as the scheduling anchor
- Missed recurring tasks are resumed immediately once, then rescheduled from the current time
- Missed one-shot tasks ask for confirmation before running now
- Multi-session lock: only one session owns the scheduler; others stay passive and can take over if the owner exits
- Hot sync between sessions: all sessions reload `.pi/session-cron.json` when another session creates, deletes, or updates tasks
- Atomic persistence: writes go to a temp file and are renamed into place to reduce JSON corruption risk
- Footer shows `cron:N` when active, or `cron:N (passive)` when another session owns execution

## Dependencies

- `croner` (cron expression parser/scheduler)

## How it differs from `extensions/until`

| | `/cron` (this extension) | `/until` |
|---|---|---|
| Purpose | Periodic monitoring | Iterate until condition met |
| Timing | Every N minutes (cron) | After every agent turn |
| Stops when | Expiry, manual delete, session end | `signal_loop_success` |
| Use case | "Check deploy every 5m" | "Run tests until they pass" |
