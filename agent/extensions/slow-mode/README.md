# Slow Mode

`/slow-mode on` enables interactive approval for configured tools; `/slow-mode off` disables it and rejects outstanding reviews. Tool configuration lives in `~/.pi/agent/config/slow-mode.json` and trusted project `.pi/config/slow-mode.json`. The defaults review `write`, `edit`, `bash` and `safe_bash` when registered. Headless and RPC operation retain their existing noninteractive behavior.

Each write or edit receives one content review. Other configured tools receive a call review. Reviews are queued in order so only one component owns keyboard focus. Write and edit preparation, review and approved application share that ordering, including when Pi requests parallel tools.

Enter or `y` approves, `n` or Escape rejects the displayed review, and `r` records a rejection reason. `a` explicitly allows subsequent matching operations for the current turn. External editing remains available through the displayed shortcuts. Approved edits use Pi's native file validation and mutation queue; a changed file is not overwritten with a stale reviewed snapshot.

Aborting the turn, disabling Slow Mode, switching/forking sessions or shutting down rejects outstanding reviews and releases waiting tools. A late response cannot approve a cancelled request. Temporary review files are private to each call and removed after success, rejection, cancellation or failure.

Updating this extension does not repair an already running session with reviews orphaned by an older version. Recovering that session is a separate operation; do not approve an unseen write to unblock it.
