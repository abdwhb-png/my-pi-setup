# Sandbox runtime

Sandbox uses the provenance-pinned Zerobox binary at `~/.pi/bin/zerobox`. The Pi policy compiler, binary and provenance must describe the same contract. A version string alone does not identify a locally patched build.

## Filesystem and tool baseline

The default Bash policy grants the project and these system resources in read-only mode:

```text
/bin
/sbin
/usr
/lib
/lib64
/etc/ld.so.cache
/etc/ld.so.conf
/etc/ld.so.conf.d
```

System PATH contains `/usr/local/bin`, `/usr/local/sbin`, `/usr/bin`, `/usr/sbin`, `/bin` and `/sbin`. A runtime installed elsewhere needs explicit read grants and a configured PATH entry. Neither PATH nor an executable's name grants access to other resources. Canonical targets of symlinks must also be authorized.

Configured denies remain enforced, including within a writable project. The policy does not grant all of HOME, all of `/etc` or the filesystem root. FUSE views enforce dynamic exclusions without reopening their parent directories.

## Private state

Bash and Think collection use separate leases below `~/.pi/zbx/`. Analysis uses a fresh lease per request. The physical lease control directory is masked, even when it is inside the project.

Zerobox mounts the current lease's private HOME at `/home/sandbox`. Shell HOME, XDG/Bun/npm caches and Docker configuration use this logical location. Its caches are writable while sibling leases and control data stay hidden. The mount uses a pre-opened directory descriptor rather than reopening an inaccessible source through the sandbox view.

A filesystem deny that intersects the logical private HOME is rejected explicitly when it cannot be enforced by this mount contract. It is never silently ignored. Configuration paths beginning with `~/` still expand from the host user's HOME before policy compilation. In a sandboxed command, shell `~` expands from its private HOME.

Bash uses private `/tmp` by default. Explicit global `tmpNamespace: "host"` permits host temporary storage, and the project can restrict it to `lease-private`. Think and Analysis always retain separate private temporary namespaces. Native file tools remain on the host, so use a project file when an artifact must be visible on both sides.

## Execution lifecycle

Bash enables `pipefail`. A failure in an earlier pipeline stage therefore affects the reported exit code. Commands that intentionally accept such a failure can explicitly change shell options.

The runtime distinguishes `uninitialized`, `reconfiguring`, `enabled`, `disabled` and `error`. Callers resolve the service at dispatch and recheck the policy fingerprint after preparation. A stale or revoked admission cannot dispatch against a wider old policy.

During reconfiguration, pending calls wait at most 30 seconds within their original deadline and cancellation signal. Ordinary valid configuration changes retain the old runtime while already admitted operations drain. Session replacement and Docker break-glass expiry preserve their interrupting behavior. Interrupted commands are never replayed automatically.

Removing a Unix socket or TCP publication takes effect when the next admission reloads the configuration. After validating the replacement runtime, Pi interrupts older shell runtimes that held the removed resource. This closes their existing connections and stops their commands, including other commands in the same runtime. Older runtimes whose resource grants remain valid continue draining normally. Think and Analysis receive no shell resource grants.

A missing or mismatched binary, invalid policy, failed setup protocol or unavailable Linux facility blocks sandbox execution. It never selects host execution as a fallback.

Docker uses its policy broker and a private connection. A Docker authorization does not mount the daemon socket. Its global ceiling and project activation are checked before each new admission.

## Qualification and activation

Linux and WSL are the supported targets. The current candidate's integration evidence was obtained on WSL. Native Linux, native Windows execution and a connection from a separate LAN peer require distinct evidence.

Private control paths must fit the Unix socket address budget. Preflight rejects a layout whose worst-case socket path is 108 bytes or longer. Long home directory paths can therefore block admission. The default Analysis IPC qualification uses a short fixture home and does not establish support for arbitrary home path lengths.

The runtime requires Linux user namespaces and the managed Zerobox/FUSE facilities. Think's Python analyzer also requires the configured Node runtime with JSPI support, `mkfifo` and `prlimit`.

Local build provenance records source commits, patch digests, the source diff and binary SHA-256 in `runtime/zerobox-provenance.json`. Rebuild and update that record together. Prepare activation separately and start a new Pi session after installing the matching code, binary and migrated configuration.

Real shell contract tests require both `PI_SANDBOX_ZEROBOX_BINARY` and `PI_SANDBOX_ZEROBOX_SHA256`. Supply the exact candidate explicitly. Tests that require that candidate skip when it is absent instead of using a personal installation. The standalone Analysis proof exercises the real engines; shell lifecycle fixtures simulate only their unrelated Analysis preflight.
