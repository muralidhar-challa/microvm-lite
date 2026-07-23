# microvm-lite

A kernel-less **x86-64 userland that runs in a browser tab** — no
SharedArrayBuffer, no COOP/COEP headers. It executes ordinary static/dynamic
Linux ELF binaries via the [blink](https://github.com/jart/blink) x86-64 emulator
compiled to WebAssembly (Emscripten + Asyncify).

**Base toolchain:** [dash](https://git.kernel.org/pub/scm/utils/dash/dash.git/)
(BSD-3-Clause) for `/bin/sh` + [toybox](https://landley.net/toybox/) (0BSD)
for coreutils.

It exposes a small `window.vm` API plus an HTTP bridge, so a host page can run
shell commands, move files in/out, and let guest tools reach the network — all
from a plain static file server.

## Why blink (and not WASIX / compile-to-WASM)

- **No SAB / no COOP-COEP.** blink is pure Asyncify; it runs on any page. WASIX
  needs SAB even single-threaded.
- **Runs existing binaries unmodified.** No recompiling tools to a WASM target.
- Cold boot ~200 ms; common tools run 3–11× faster than a full-system emulator
  (v86) on the common path. See `test/bench-results.md` — but note those
  numbers are the 2026-07-13 M1 gate, measured with poppler/sqlite/Rust
  binaries that the reference build no longer ships.

## What it ships, what you add

The reference build ships blink + dash + toybox — no app-specific tools,
endpoints, or paths baked in. You add the rest at runtime:

- **Binaries / skills / assets** → manifest *bundles*, `vm.loadBundle(name)`, or
  `vm.writeFile(path, data, { mode })`.
- **Network endpoints** → `init.vmRoutes` (hostname → URL); the runtime seeds
  `/etc/hosts` and routes guest HTTP to your handlers.
- **Working dir** → `/workspace` by default, set via `manifest.home` (the
  worker also honors `init.home`, but `startVM` does not forward it).

## Layout

```
src/vm-worker.js     the Web Worker: hosts blink, runs commands, HTTP bridge, FS
src/vm-host.js       main thread: window.vm API, endpoint registry, IDB snapshot
src/vm-host.d.ts     typed startVM/preloadVM surface for TS integrators
src/vm-terminal.js   drop-in xterm.js front end for window.vm (attachTerminal)
blink/               build.sh, config.h, stubs.c, patches/, toybox.config
blink/mvl_sched.*    cooperative fiber scheduler (see SCHEDULER-DESIGN.md)
blink/mvl_dispatch.* spawn/context-swap/fd-list machinery for scheduled jobs
dist/build-dist.sh   assembles dist/ + a hashed, bundle-based manifest.json
dist/console.html    an interactive terminal against the packaged dist
test/                playwright + bun specs; test/debug/ holds ad-hoc repros
```
`blink-src/`, `blink-wasm/`, `blink-native/`, and
`dist/{blink.*,bin,vm-worker.js,vm-host.js,manifest.json}` are build outputs
(gitignored — regenerate, see below). `dist/vm-terminal.js` and the `dist/xterm*`
assets are *also* produced by `build-dist.sh` but are checked in.

Design docs: [SCHEDULER-DESIGN.md](SCHEDULER-DESIGN.md) (concurrency, phase
status), [REAL-FORK.md](REAL-FORK.md) (private address space per fork child),
[CHILD-PID-COLLISION-BUG.md](CHILD-PID-COLLISION-BUG.md) (a fixed ECHILD bug
plus one still-open `&`+`wait` hang).

## Build

```sh
bash blink/build.sh          # blink.wasm + dash + toybox (needs emcc, musl-gcc, gsed)
bash dist/build-dist.sh      # → dist/ + manifest.json (buildId, bundles)
```

## Run it

```sh
cd . && python3 -m http.server 8080
# open http://localhost:8080/dist/console.html
```

## The `window.vm` contract

`vm-host.js` installs, on
`startVM({ cdnBase, workerUrl, vmRoutes, baseEtag, proxyTimeoutMs })`:

| API | Purpose |
|---|---|
| `vm.execute(cmd, timeout?)` → string | run a shell command, get combined stdout+stderr |
| `vm.run(cmd, timeout?, session?)` → `{done, output_file, pid, output}` | file-captured run with a guest pid |
| `vm.writeFile(path, data, {mode}?)` | push a file; `mode: 0o755` installs an executable |
| `vm.readFile(path)` / `vm.readFileRaw(path)` | read text / bytes |
| `vm.loadBundle(name)` | stage a named manifest bundle on demand |
| `vm.resetToFresh()` | wipe the snapshot and reboot |
| `vm.ready()` / `vm.isReady` | boot readiness |
| `vm._stat()` | diagnostic: wasm heap size + `/tmp` residue |
| `window.registerVmEndpoint(path, handler)` | answer guest HTTP to a virtual host |

`proxyTimeoutMs` caps how long a guest HTTP request may take before the bridge
synthesizes a 504; it defaults to 300 000 ms, which matters for backends that
legitimately run for minutes.

> **Sessions.** Passing `session` to `vm.run` scopes the call to an emulated
> shell session: `WORKDIR=/tmp/session_<session>` and `SESSION_ID` are exported,
> and exported env + cwd persist across calls sharing that id — a persistent
> shell without a live shell process. `/tmp` is included in the snapshot, so
> sessions survive a reboot. Omit it for a stateless call cd'd to `HOME`.

> **Backgrounding note:** blink runs each command to completion in one Asyncify
> call, so `vm.run` always returns `done:true` (no `vm.kill`). A truly hung
> command blocks the worker until it exits — reload to recover. A guest module
> *crash* is different: the worker latches it and the host auto-restarts the VM
> (up to 3 times in 60 s), failing the in-flight call with a `[vm fatal]`
> message rather than wedging.

## Manifest & asset loading

`dist/manifest.json` is bundle-based:

```jsonc
{
  "buildId": "…",
  "home": "/workspace",
  "applets": ["sh", "bash", "ls", "cat", …],
  "bundles": {
    "base": { "tier": "eager", "files": [
      {"url":"bin/dash","dest":"/bin/dash","mode":"0755","applets":["sh","bash"]},
      {"url":"bin/toybox","dest":"/bin/toybox","mode":"0755","applets":["ls","cat",…]}
    ]}
  }
}
```

- **eager** bundles stage at boot. Add your own **lazy** bundles with `triggers`
  for on-demand loading.
- **Add your own tools/skills**: publish them as additional bundles in *your*
  manifest, or push them at runtime — `vm.writeFile("/bin/mytool", bytes, {mode:"0755"})`
  for a binary, `vm.writeFile("/workspace/skills/x.md", text)` for a doc.

## Bringing your own binaries

The reference build ships only dash + toybox. You layer your own ELF binaries,
shared libraries, and data files on top — either eagerly at boot or lazily on
first use. No code changes, no recompilation.

### Via manifest (recommended for CDN-hosted binaries)

Drop your binaries on a CDN, then add a bundle to your manifest:

```jsonc
{
  "bundles": {
    // Eager: staged at boot before the VM signals ready.
    "sqlite": {
      "tier": "eager",
      "files": [
        {"url": "bins/sqlite3", "dest": "/bin/sqlite3", "mode": "0755"}
      ]
    },
    // Lazy: only fetched when a command matches one of the triggers.
    // Your 14 MB of PDF tooling never downloads until the user runs pdftotext.
    "pdf": {
      "tier": "lazy",
      "triggers": ["pdftotext", "pdfinfo", "pdftoppm"],
      "files": [
        {"url": "bins/pdftotext",  "dest": "/bin/pdftotext",  "mode": "0755"},
        {"url": "bins/pdfinfo",    "dest": "/bin/pdfinfo",    "mode": "0755"},
        {"url": "libs/libpoppler.so","dest":"/lib/libpoppler.so","mode":"0755"}
      ]
    },
    // Data / seeds — any file, any path.
    "seeds": {
      "tier": "eager",
      "files": [
        {"url": "data/prompts.json", "dest": "/workspace/prompts.json"}
      ]
    }
  }
}
```

### Via JS API (runtime push)

No manifest change — push files from the host page at any time:

```js
// ELF binary — blink runs it as a native x86-64 process.
const bin = await fetch("https://cdn.example.com/my-tool").then(r => r.arrayBuffer());
await vm.writeFile("/bin/my-tool", new Uint8Array(bin), { mode: 0o755 });

// Text / data / seed files.
await vm.writeFile("/workspace/config.json", JSON.stringify({ key: "value" }));

// Now run it.
await vm.execute("my-tool --config /workspace/config.json");
```

### Dynamic ELFs with shared libraries

If your binary links dynamically against musl (`.so` files), drop both the binary
and its library closure into the VM — the musl loader (`/lib/ld-musl-x86_64.so.1`)
resolves them from `/lib`:

```jsonc
{
  "tier": "lazy",
  "triggers": ["my-tool"],
  "files": [
    {"url": "bins/my-tool",        "dest": "/bin/my-tool",        "mode": "0755"},
    {"url": "libs/ld-musl-x86_64.so.1","dest":"/lib/ld-musl-x86_64.so.1","mode":"0755"},
    {"url": "libs/libfoo.so.1",    "dest": "/lib/libfoo.so.1",    "mode": "0755"}
  ]
}
```

> **Static linking is simpler.** A single statically-linked ELF (like dash or
> toybox) needs no library closure — just drop it in and run.

## HTTP bridge

Guest HTTP clients do the normal `getaddrinfo → socket → connect → write → read`.
The runtime implements virtual sockets in blink: `connect()` to a seeded route IP
hands the request to JS, which routes it to your `registerVmEndpoint` handler
(or a direct authed `fetch`, per your `vmRoutes`), and streams the HTTP response
back. Unknown hosts get a 403.

## Tests

```sh
bun test/contract.spec.mjs             # window.vm contract + writeFile-install
bun test/dist-smoke.spec.mjs           # packaging: cold boot, buildId etag, snapshot
bun test/stress.spec.mjs               # sustained-load soak (ITERS=N)
bun test/fiber-selftest.spec.mjs       # scheduler Phase 1: Emscripten Fibers
bun test/phase2-selftest.spec.mjs      # Phase 2: two Machines, one System
bun test/phase3-pthread-selftest.spec.mjs  # Phase 3: guest CLONE_THREAD
bun test/debug/realfork-test.mjs       # real fork(): pipelines, 60-iteration loop
```

`test/debug/` holds ad-hoc repros kept alongside the bugs they isolate
(`pidcollide-test.mjs`, `isolate-hang.mjs`, `session-id-test.mjs`, …).
`test/native-*.sh` run the native `MVL_NATIVE_DEBUG` + `lldb` builds — the
primary gate for scheduler work, since production's `-DNDEBUG` swallows
exactly the class of bug this codebase keeps hitting.

## Known limitations

- **Concurrency exists, but isn't exposed yet.** There *is* a cooperative
  fiber scheduler (Emscripten Fibers, preemption via an instruction-count
  checkpoint), guest `pthread_create` works, and `fork()` gives each child a
  private address space. What's not wired is the host-facing contract:
  `vm.run` still always returns `done:true`, and there's no `vm.kill`. See
  [SCHEDULER-DESIGN.md](SCHEDULER-DESIGN.md) (Phases 5–6).
- **`&` backgrounding is partially working.** A single background job followed
  by `wait` is verified; one shell backgrounding *two* jobs and `wait`ing on
  both hangs (see [CHILD-PID-COLLISION-BUG.md](CHILD-PID-COLLISION-BUG.md)).
  Sequential commands, pipelines, and subprocess capture are the well-trodden
  paths.
- **Host executions serialize.** All guest work runs through one promise chain
  in the worker, so a slow command blocks later ones until it finishes. This is
  a deliberate stopgap that Phase 5 retires.
- **fd lifetime across forks.** An open investigation: some pipe fds outlive
  their owner and leave a reader polling indefinitely. Long-lived sessions that
  fork heavily are the exposure.
