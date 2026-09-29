# pi-ssh-tools

Explicit SSH tools for [pi](https://github.com/earendil-works/pi).

Turn SSH mode on only when you need it, keep local tools untouched, and give the agent a separate remote toolset:

- `ssh_read`
- `ssh_write`
- `ssh_edit`
- `ssh_bash`

## What it does

This extension adds a `/ssh` command.

- Default is off
- No persistence across sessions
- Local `read`, `write`, `edit`, and `bash` stay local
- When SSH mode is active, the agent also gets `ssh_read`, `ssh_write`, `ssh_edit`, and `ssh_bash`
- The active remote host, remote working directory, and local working directory are injected into the system prompt while SSH mode is on

That makes remote work explicit instead of silently swapping out local tools.

## Usage

```text
/ssh
/ssh mac
/ssh clawd
/ssh mac:/Users/can/project
/ssh status
/ssh off
```

When `/ssh` is called with no arguments, the extension offers hosts from `~/.ssh/config`.

You can always bypass the picker and type a host manually:

```text
/ssh user@host
/ssh user@host:/remote/path
```

That means the package still works even if you do not use `~/.ssh/config`.

A target that starts with `-`, or that carries a dash after `user@`, is rejected. It reaches `ssh` as a single argument with no shell, so metacharacters are inert, but ssh reads a leading dash as an **option** rather than a host. `-oProxyCommand=<cmd>` is the dangerous one: it runs a local command during connection. Bracketed IPv6 literals (`[2001:db8::1]`) are supported, including with a working directory (`[2001:db8::1]:/repo`).

## How host selection works

The picker reads `Host ...` aliases from your local `~/.ssh/config`.

- wildcard entries like `Host *` are ignored
- aliases are used as the SSH target directly
- if no remote path is provided, the extension resolves it with `ssh <host> pwd`

This is mainly a convenience layer. SSH config is not required for the actual remote tools.

## Path semantics

This is the part that is easy to get wrong, so it is spelled out.

| Tool        | Relative path                               | Absolute path                                                 |
| ----------- | ------------------------------------------- | ------------------------------------------------------------- |
| `ssh_read`  | resolves under the remote working directory | read as given                                                 |
| `ssh_write` | resolves under the remote working directory | written as given                                              |
| `ssh_edit`  | resolves under the remote working directory | **rejected** unless it is inside the remote working directory |
| `ssh_bash`  | runs in the remote working directory        | n/a                                                           |

`cd` written inside an `ssh_bash` command still applies, so `cd /etc && ls` works in one call.

Because `ssh_edit` is sandboxed, reaching a file outside the working directory means either an absolute path with `ssh_read` or a shell command with `ssh_bash`.

Paths are normalized (`.` and `..` resolved, duplicate separators collapsed) _before_ the containment check, so `/home/dev/../etc/x` is rejected rather than passing a prefix test and landing on `/etc/x`.

Treat the `ssh_edit` restriction as an **accident guard, not a security sandbox**. It is a lexical check: it does not follow symlinks, so a symlink under the remote working directory that points outside it is not contained.

### Paths this extension refuses

Two cases fail loudly instead of guessing, because guessing would target a different file than the model asked for:

- **A relative remote working directory.** `/ssh host:repo` is rejected; use `/ssh host:/absolute/path`. A relative base would make every relative path resolve against the local session directory, which is the defect this extension exists to prevent. The `pwd` fallback is also required to return an absolute path.
- **A path containing a Unicode space** (`U+00A0`, `U+2000`–`U+200A`, `U+202F`, `U+205F`, `U+3000`). pi's `resolveToCwd` rewrites these to an ASCII space _after_ this extension hands the path over, so the file that gets read or written would silently differ from the requested one. Rename the file on the remote host, or reach it with `ssh_bash`. An ordinary ASCII space in a filename is fine.

## Why path resolution lives in this extension

pi resolves tool paths as `ctx?.cwd || cwd` in each tool definition:

- `dist/core/tools/read.js:56` — `resolveReadPathAsync(path, ctx?.cwd || cwd)`
- `dist/core/tools/write.js:31` — `resolveToCwd(path, ctx?.cwd || cwd)`
- `dist/core/tools/edit.js:94` — `resolveToCwd(path, ctx?.cwd || cwd)`
- `dist/core/tools/bash.js:160` — `resolveSpawnContext(command, ctx?.cwd || cwd, …)`

`ctx.cwd` is the **local** session directory, and it short-circuits the `cwd` argument passed to `createReadToolDefinition` and friends. A factory `cwd` is only a fallback. So this extension makes every model-supplied path absolute against the remote working directory _before_ handing it to pi, and `ssh_bash` ignores the `cwd` argument it receives entirely.

Pre-resolving to an absolute path removes the `ctx.cwd` dependency but does **not** bypass every local-filesystem behaviour inside pi: `resolveToCwd` still applies `normalizeUnicodeSpaces` (hence the refusal above), and `resolveReadPathAsync` still probes _local_ files for alternate macOS screenshot and Unicode spellings. Those two are pi-side behaviours this extension can only avoid or reject, not correct.

Do not "simplify" this by passing `remoteCwd` to the tool factories and trusting it. That reintroduces the bug where `ssh_bash` tries to `cd` into a local path that does not exist on the remote host, and where `ssh_read` with a relative path reads a different file than the model asked for.

## There are no remote grep, find, or ls tools

Run them as commands inside `ssh_bash`:

```text
ssh_bash  ls -la
ssh_bash  grep -rn 'BatchMode' /etc/ssh
ssh_bash  find /var/log -name '*.log' -mtime -1
```

## Write semantics

- content is sent over **stdin**, never on the command line, so there is no argv size ceiling
- the remote side creates a **unique** temp file with `mktemp` in the target's own directory, so two writers to the same target never share a temp inode, and the rename stays on one filesystem
- a `trap` removes the temp file on **every** exit, including a failed rename
- the byte count is sent alongside and verified with `wc -c` **before** the rename, so a connection that drops mid-transfer cannot publish a truncated file over an intact one. `cat` exits 0 on an early EOF, so exit status alone does not prove the content arrived
- a **directory** target is refused: `mv -f file dir` succeeds by moving the file _inside_ the directory
- a **symlink** target is refused by `ssh_write` and `ssh_edit`. Renaming over a link replaces the link, not the file it points to, and the tool would report success while the file you meant is untouched. Edit the resolved path, or use `ssh_bash`
- consequence: the resulting file gets the remote umask's default mode and the SSH user's ownership. The previous implementation (`cat >` in place) preserved the original mode and owner. If you rewrite a file whose mode matters, restore it yourself or use a shell command with `ssh_bash`.

### Interrupted writes report an unknown outcome

If a write is aborted or times out, the extension cannot know whether the remote rename already committed. The tool says **outcome UNKNOWN** and tells the model to read the file before retrying, rather than claiming the previous file is intact. A clean non-zero exit is still reported as a plain failure, because there the script ran to completion and the outcome is known.

Unique temp files stop one writer from corrupting another. They do not prevent a lost update against an unrelated remote editor writing the same file at the same time.

## Transport limits

- an aborted tool call tears down its ssh child; the signal is threaded into the file operations, not just the shell one
- an already-aborted call never spawns anything
- a broken stdin pipe (`EPIPE` during a large write) rejects the tool call instead of raising an uncaught stream error
- backpressure is honoured, so a large payload is not truncated by ending stdin too early
- abort and timeout escalate `SIGTERM` → `SIGKILL` after a grace period
- **Killing the local ssh client does not guarantee the remote command dies.** A detached remote process can outlive the tool call. The extension does not claim otherwise.
- diagnostic output (streaming `ssh_bash` output, and stderr used in error messages) is capped at 1 MiB in memory; every byte still streams to the consumer
- a data-returning call such as `ssh_read` is capped at 16 MiB and **rejected** if exceeded, never silently truncated — a shortened file would look like a successful read of different content

An `ssh_bash` exit code of 255 is reported as an SSH transport, host-key, or authentication failure with the remote output attached. A remote command that itself exits 255 is indistinguishable from that, so the message says so rather than guessing.

## Requirements

- [pi](https://github.com/earendil-works/pi)
- local `ssh` client available in `$PATH`
- **key-based or agent-based SSH auth** — the transport passes `-o BatchMode=yes`, so a password or host-key prompt fails immediately instead of hanging the tool call
- `bash` available on the remote host

## Connection reuse

Every tool call is a separate `ssh` process, so each one pays a TCP connect and an auth handshake. Reuse one connection by adding this to `~/.ssh/config` (this extension does not modify your SSH config):

```sshconfig
Host devlab
    ControlMaster auto
    ControlPath ~/.ssh/cm/%r@%h:%p
    ControlPersist 60
```

If a stale control socket is left behind, clear it with `ssh -O exit devlab`.

## Notes

- image reads are supported for common extensions: jpg, jpeg, png, gif, webp
- a missing remote file is reported as `Remote path not found on <host>: <path>`, and an inaccessible one as `Remote path is not readable on <host>: <path>`
- an SSH transport or authentication failure reports exit 255 separately and includes the remote stderr verbatim

## License

MIT
