# Blink WASM Shell — Build Notes

## What This Is

A browser-based x86-64 Linux emulator built from [blink](https://github.com/jart/blink)
compiled to WebAssembly via Emscripten. It runs real x86-64 Linux ELF binaries in the
browser with no server-side execution.

**Current state:** Working shell (busybox hush, NOMMU build) + file manager UI. Rust `docworker` binary
runs successfully inside the emulator. Shell stays alive; fork-based commands being resolved via NOMMU/vfork.

---

## Architecture

```
blink-src/          ← blink C source (cloned from github.com/jart/blink)
blink-wasm/         ← build output served via HTTP
  blink.html        ← main app (shell template expanded by emcc)
  blink.js          ← emscripten JS glue
  blink.wasm        ← compiled blink x86-64 emulator
  busybox           ← static x86-64 musl busybox binary
  xterm.min.js          ← terminal renderer (xterm 5.1.0)
  xterm-addon-fit.min.js ← FitAddon for proper terminal sizing (@xterm/addon-fit 0.10.0)
  xterm.css
  coi-serviceworker.js  ← enables SharedArrayBuffer
  stubs.c           ← stub implementations for excluded syscalls
  config.h          ← WASM-specific blink config (disables JIT, VFS, threads etc)
```

Both `blink-src/` and `blink-wasm/` are in `.gitignore` — local only.

---

## Build Command

```bash
cd /Volumes/Data/code/v86/blink-src

emcc \
  $(ls blink/*.c | grep -v "blinkenlights|cga\.c|mda\.c|panel\.c|ppc\.c|xnu\.c|jit\.c|jitflush\.c|magikarp|ancillary|sysinfo|statfs|cpucount|mkfifo|devfs|procfs|pty|ioctl|realpath|seekdir|memccpy|mkfifoat|wcwidth|vasprintf|oneoff") \
  /Volumes/Data/code/v86/blink-wasm/stubs.c \
  -I. -I/Volumes/Data/code/v86/blink-wasm \
  -o /Volumes/Data/code/v86/blink-wasm/blink.html \
  --shell-file blink/blink-shell.html \
  -DNDEBUG \
  "-DBUILD_MODE=\"wasm\"" "-DBUILD_TOOLCHAIN=\"emcc\"" \
  "-DBLINK_COMMITS=\"0\"" "-DBLINK_GITSHA=\"local\"" \
  "-DBUILD_TIMESTAMP=\"now\"" "-DCONFIG_ARGUMENTS=\"\"" \
  -O2 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s EXPORTED_RUNTIME_METHODS='["callMain","FS","TTY","ENV"]' \
  -s INVOKE_RUN=0 -s EXIT_RUNTIME=0 -s FORCE_FILESYSTEM=1 \
  -s ASYNCIFY -s ASYNCIFY_IMPORTS='["emscripten_sleep"]' \
  -sUSE_ZLIB=1
```

Serve with:
```bash
cd /Volumes/Data/code/v86/blink-wasm && python3 -m http.server 8765
```

Open: http://localhost:8765/blink.html

---

## Source Files Excluded From Build

These were excluded because they use platform headers unavailable in Emscripten
(sys/sysctl.h, sys/mount.h, sys/sysinfo.h) or have a conflicting `main()`:

| File | Reason |
|------|--------|
| `blinkenlights.c` | TUI debugger, has own main() |
| `jit.c`, `jitflush.c` | JIT disabled (DISABLE_JIT) |
| `cga.c`, `mda.c`, `panel.c` | Terminal/display (not needed) |
| `ppc.c`, `xnu.c` | Platform-specific |
| `clmul.c`, `rdrand.c`, `bmi2.c` | CPU extensions (x86-only intrinsics) |
| `ancillary.c` | Unix socket ancillary data (stubbed) |
| `sysinfo.c`, `statfs.c` | sys/sysinfo.h / sys/mount.h (stubbed) |
| `cpucount.c` | sys/sysctl.h (stubbed, returns 1) |
| `devfs.c`, `procfs.c` | Virtual filesystems |
| `pty.c`, `ioctl.c` | PTY/ioctl (stubbed) |
| `mkfifo.c`, `mkfifoat.c` | FIFOs |
| `realpath.c` | Uses strchrnul before it's declared |
| `seekdir.c`, `memccpy.c`, `mkfifoat.c`, `wcwidth.c`, `vasprintf.c` | Have HAVE_* shims |
| `oneoff.c` | Has its own main() |

Missing symbols from excluded files are provided by `stubs.c`:
`SysIoctl`, `SysStatfs`, `SysFstatfs`, `SendAncillary`, `ReceiveAncillary`,
`GetCpuCount`, `sysinfo_linux`

---

## Key Patches to blink Source

### `blink/syscall.c` — em_readv always polls
```c
// Original: only polls when O_NONBLOCK not set
// Fix: always poll — Emscripten sets stdin O_NONBLOCK by default
ssize_t em_readv(int fd, const struct iovec *iov, int iovcnt) {
  struct pollfd pfd = { .fd = fd, .events = POLLIN };
  while (em_poll(&pfd, 1, 50) == 0) {}
  ...
}
```

### `blink/realpath.c` — added missing include
```c
#include "blink/string.h"   // ← added for strchrnul declaration
```

---

## blink-shell.html Key Design

### stdin wiring
Emscripten TTY `get_char` returns `null` (block/retry) when buffer empty,
`undefined` would mean EOF. The `poll` function returns 0 when empty so
`em_poll` sleeps 50ms and retries.

### ASYNCIFY
`emscripten_sleep(50)` in `em_poll` requires `-s ASYNCIFY`. This suspends
the WASM stack and yields to the browser event loop, allowing keyboard input
to reach `stdinBuffer` while blink is waiting for stdin.

### Busybox loading
Uses `addRunDependency('busybox-fetch')` to pause Emscripten's `postRun` until
busybox is fetched async and written to `/bin/busybox`. Each applet (ls, cat,
sed, etc.) gets its own copy of the busybox binary so argv[0] detection works.

### \r → \n conversion
xterm sends `\r` (13) on Enter. Converted to `\n` (10) before pushing to
stdinBuffer so line-oriented programs (docworker's BufRead::lines()) see newlines
correctly.

### put_char \n → \r\n
`put_char` in the TTY ops writes one byte at a time from the emulated program's
stdout. xterm requires `\r\n` for proper line breaks — bare `\n` causes the
staircase effect where each line starts one column to the right. Fixed by
converting `val === 10` to `terminal.write('\r\n')`.

### Smart quote fix
macOS auto-corrects `"` to `"` `"`. Mapped back to straight quotes in the
`onData` handler so JSON input works.

### Terminal sizing (FitAddon)
Without FitAddon, xterm doesn't know the pixel dimensions of its container, so
it defaults to 80 columns but doesn't know the row height — any output with
newlines produces a staircase. Fixed by loading `@xterm/addon-fit` and calling
`fitAddon.fit()` after `terminal.open()` and again when the module is ready.
Also hooked to `window.resize`.

---

## Busybox Build

### Why NOMMU?

Blink's WASM build has `HAVE_FORK` disabled — fork requires the host OS to fork,
which is impossible in WebAssembly. The standard busybox `ash`/`sh` shell calls
`fork()` for every external command, so `ls` gives: `sh: can't fork: Function not implemented`.

The fix: build busybox with `CONFIG_NOMMU=y`. In NOMMU mode, `hush` uses `vfork`
instead of `fork` for running external commands. `HUSH_JOB` (job control) is also
disabled since it requires a PTY.

### Build commands

```bash
cd /tmp
curl -L https://busybox.net/downloads/busybox-1.36.1.tar.bz2 | tar xj
cd busybox-1.36.1
make defconfig

# Apply overrides to .config:
cat >> .config << 'EOF'
CONFIG_STATIC=y
CONFIG_NOMMU=y
CONFIG_CROSS_COMPILER_PREFIX="/opt/homebrew/bin/x86_64-linux-musl-"
CONFIG_HUSH=y
CONFIG_HUSH_INTERACTIVE=y
# CONFIG_ASH is not set
EOF

# Disable job control (needs PTY, not available)
sed -i '' 's/CONFIG_HUSH_JOB=y/# CONFIG_HUSH_JOB is not set/' .config

make olddefconfig
make -j$(sysctl -n hw.logicalcpu)
cp busybox /Volumes/Data/code/v86/blink-wasm/busybox
```

Requires: `x86_64-linux-musl-gcc` (install via homebrew: `brew install FiloSottile/musl-cross/musl-cross`)

### Shell invocation

```js
await Module.callMain(['/bin/busybox', 'hush', '-i']);
```

`hush` is the NOMMU-capable shell applet. `sh` in this build is also an alias for hush.

---

## docworker Integration

`docworker` is a Rust JSON-lines document processor (PDF + XLSX).
Binary: `docworker-rs/target/x86_64-unknown-linux-musl/release/docworker`

Upload via file manager → runs as `/root/docworker` in the shell.

Usage from shell:
```sh
./docworker
{"cmd":"ping"}
→ {"ok":true,"text":"pong"}
```

---

## Filesystem API (window.BlinkFS)

```js
BlinkFS.writeFile(name, arrayBuffer, dir?)  // write to /root by default
BlinkFS.readFile(path)                       // returns Uint8Array
BlinkFS.downloadFile(path)                   // triggers browser download
BlinkFS.readdir(path?)                       // list /root by default
```

---

## Known Issues / TODO

### Fork / vfork — resolved via JS REPL

Blink WASM has `HAVE_FORK` disabled (host OS fork impossible in WASM).
`vfork` maps to the same `SysFork` path and is also disabled.
No shell process can fork child processes.

Attempts that failed:
- `ash/sh` (defconfig): `fork: Function not implemented`
- `hush` NOMMU build: `vfork: Function not implemented` + `waitpid: Function not implemented`
- `FEATURE_PREFER_APPLETS` + `FEATURE_SH_NOFORK`: only marks trivial applets (echo, pwd, mkdir) as
  nofork — `ls`, `cat`, `grep` are `APPLET_NOEXEC` and still require fork
- `BUSYBOX_EXEC_PATH=/bin/busybox`: no effect since nofork only applies to the tiny applets above

**Solution: JS REPL** — no shell process at all. JS parses the command line and calls
`Module.callMain` per command. blink's `exit()` is overridden to `_exit()` in the Emscripten
build so `callMain` can be called repeatedly without tearing down the process. The FS persists
between calls.

## JS REPL Design

The shell is emulated entirely in JavaScript — no shell process runs inside blink.

- **Command parsing**: tokenizer handles single/double quotes and backslash escapes
- **Built-ins** (run in JS, no blink call): `cd`, `pwd`, `export`, `clear`, `exit`, `help`
- **External commands**: resolved via PATH, then run as `await Module.callMain(args)`
- **Pipes (`|`)**: implemented via temp files in the emscripten FS
  - Left side: stdout redirected by swapping `FS.streams[1]` and `FS.streams[2]` to a real FS file
    (TTY `put_char` swap was tried first but is unreliable with ASYNCIFY — FS streams approach
    is stable and guaranteed to restore via `try/finally`)
  - Right side: file bytes loaded into `stdinBuffer`; `stdinPipeMode=true` makes empty buffer
    return `undefined` (EOF) instead of `null` (block), so commands like `head`/`tail` terminate
  - Both flags reset at start and end of every `runCommand` so a failed pipe never hangs the shell
  - Temp files use timestamp-unique names (`/.pipeN_i`) and are deleted after use
- **stdin passthrough**: while a command is running (`replRunning=true`), keystrokes go to
  `stdinBuffer` so interactive programs (e.g. `docworker`) still work
- **`em_readv` fix**: only polls-loops on fd==0 (stdin). Previously polled all fds, causing
  `tail file` to hang even when reading a regular file argument.
- **Paste detection**: `data.length > 1` = paste; appended to line buffer without executing,
  `\r` stripped. User presses Enter to run.
- **Verified working**: `ls`, `cat`, `grep`, `sed`, `tail`, `wc`, `find`, `sort`, `uniq`, `cut`,
  `tr`, `head`, `diff`, `md5sum`, `chmod`, `stat`, `du`, `df`, pipes (`cmd | cmd`)

## Known Limitations / TODO

- [ ] No output redirection (`>`, `>>`, `<`) — not yet implemented
- [ ] No environment variable substitution in complex cases (`$(cmd)`, backticks)
- [ ] No persistent filesystem — files lost on page refresh
- [ ] File manager doesn't auto-refresh after shell creates files
- [ ] `vi` / interactive editors won't work without a PTY
- [ ] Large files slow to write into FS (full copy in memory)
- [ ] Need to integrate blink-shell into the main React/Vite app

---

# M0 Port Findings (busybox-wasm/microvm, 2026-07-13)

Ported from v86/blink into microvm/. Four root causes fixed to get Rust static
x86_64-musl binaries (xtool, probe) running in a Worker:

## 1. config.h shadowing (build.sh regression vs the original spike)
`blink/builtin.h` does `#include "config.h"` and emcc is invoked with `-I.`
before `-I$BLINK_DIR`, so a `./configure`-generated **native macOS** config.h at
the blink-src root silently overrode the crafted wasm config (JIT/THREADS/FORK
on, HAVE_SYSCTL etc). build.sh now copies the crafted config over the root copy
instead of running configure. (blink.wasm dropped 437KB → ~300KB once fixed.)

## 2. mkfifoat_ stub
With the crafted config (no HAVE_MKFIFOAT) and mkfifoat.c excluded from the
build, linking fails — the native config had been masking this. Added a stub
returning -ENOSYS to stubs.c.

## 3. Module.callMain is NOT Asyncify-safe — the big one
Rust std polls fds 0-2 at startup → blink's em_poll → emscripten_sleep →
Asyncify SUSPENDS the wasm. Plain callMain sees the export return mid-suspend
and reports a bogus exit 0; the guest keeps running detached (its output goes
to the already-restored streams = lost), and the next callMain corrupts the
suspended state (permanent hang). busybox applets never poll, which is why the
spike "worked". Fix: invoke main via `ccall("em_main", ..., {async:true})`
which resolves only on true completion. Requires EXPORTED_RUNTIME_METHODS
ccall/HEAPU32/stringToNewUTF8 and EXPORTED_FUNCTIONS _malloc/_free.

## 4. getopt state persists across main() invocations
blink's vendored getopt keeps optind_/optarg_/static place across calls; the
second main() invocation parses garbage (usage error / exit 127). Added
em_reset_getopt() to stubs.c (called by the host before each main), and the
host keeps the previous argv allocated until the next call so the static
place pointer never dangles into freed memory.

## Also
- Asyncify drops the return value of a suspended main() — em_main()/em_last_exit()
  in stubs.c store and expose it. Guest exit codes via process::exit still read
  as 0 host-side (KNOWN ISSUE — revisit in M2 where the process model owns exits).
- Static-PIE Rust binaries load but misbehave; build with
  `-C relocation-model=static` (plain ET_EXEC). rustc target x86_64-unknown-linux-musl,
  linker x86_64-linux-musl-gcc.
- emcc 5.x needs python ≥3.10: build.sh prepends /opt/homebrew/bin to PATH.
- Host-page gotcha: `var status = ...` collides with window.status (silent
  string coercion) — the test page uses statusEl.
- Timings (M0, arm64 Mac, -O2): busybox applets 20-50ms, Rust xtool help ~270ms,
  xtool ping ~230ms end-to-end per exec.
