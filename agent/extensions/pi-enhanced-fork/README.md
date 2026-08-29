# pi-enhanced-fork

Direct Pi extension that provides a responsive fork-point selector without
reimplementing any session or fork internals.

## Commands

- `/efork` is the canonical command and durable fallback.
- `/fork` is rewritten to `/efork` only when the editor text trims exactly to
  `/fork` and the submitted key is an unmodified Enter press.

The selector reads candidates from `ctx.sessionManager`, renders through
`ctx.ui.custom(...)`, and delegates exactly once through
`ctx.fork(entryId, { withSession })` after a selection.

## Submit shim configuration

The submit shim is enabled by default. Disable it before starting Pi with:

```bash
PI_ENHANCED_FORK_SHIM=off pi
```

The values `0`, `false`, and `off` disable the shim. `/efork` remains available
when the shim is disabled or when its terminal listener cannot be installed.

## Public API limitation

Pi's public extension UI does not expose the currently focused component.
Terminal-input listeners run before focused-component dispatch, so an Enter
handled by another overlay can still rewrite a hidden editor containing exactly
`/fork` to `/efork`. It does not consume that Enter or execute the fork at that
time. Disable the shim and use `/efork` if this edge case is disruptive.

The extension intentionally does not replace the editor or patch Pi core to
work around this limitation.

## Manual smoke test

Use a short fullscreen pane (27 rows is the regression target):

1. Run `/reload` and confirm there is one `/efork` command.
2. Run `/efork`; verify the newest message starts selected.
3. Exercise arrows, Page Up/Down, Home/End, and mouse wheel navigation.
4. Resize the pane smaller and larger; verify the selected row stays visible.
5. Cancel with Escape, then run `/fork` and confirm the same selector opens.
6. Select a skill-expanded message and verify the replacement editor contains
   compact `/skill:...` input.

## Rollback

Set `PI_ENHANCED_FORK_SHIM=off` for a shim-only rollback. For a full rollback,
remove or move `~/.pi/agent/extensions/pi-enhanced-fork/` out of the extension
discovery path, restore the previous `/cfork` block if it was removed, and run
`/reload`.
