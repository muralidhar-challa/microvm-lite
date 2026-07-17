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
- Cold boot ~130 ms; common tools run 3–11× faster than a full-system emulator
  (v86) on the common path. See `test/bench-results.md`.

## What it ships, what you add

The reference build ships blink + dash + toybox — no app-specific tools,
endpoints, or paths baked in. You add the rest at runtime:

- **Binaries / skills / assets** → manifest *bundles*, `vm.loadBundle(name)`, or
  `vm.writeFile(path, data, { mode })`.
- **Network endpoints** → `init.vmRoutes` (hostname → URL); the runtime seeds
  `/etc/hosts` and routes guest HTTP to your handlers.
- **Working dir** → `/workspace` by default (`manifest.home` / `init.home`).

## Layout

```
src/vm-worker.js     the Web Worker: hosts blink, runs commands, HTTP bridge, FS
src/vm-host.js       main thread: window.vm API, endpoint registry, IDB snapshot
blink/               build.sh, config.h, stubs.c, patches/, toybox.config
dist/build-dist.sh   assembles dist/ + a hashed, bundle-based manifest.json
dist/console.html    an interactive terminal against the packaged dist
test/                contract.spec.mjs, dist-smoke.spec.mjs, stress.spec.mjs
```
`blink-src/`, `blink-wasm/`, `dist/{blink.*,bin,vm-*.js,manifest.json}` are
build outputs (gitignored — regenerate, see below).

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

`vm-host.js` installs, on `startVM({ cdnBase, workerUrl, vmRoutes, baseEtag, home })`:

| API | Purpose |
|---|---|
| `vm.execute(cmd, timeout?)` → string | run a shell command, get combined stdout+stderr |
| `vm.run(cmd, timeout?)` → `{done, output_file, pid, output}` | file-captured run with a guest pid |
| `vm.writeFile(path, data, {mode}?)` | push a file; `mode: 0o755` installs an executable |
| `vm.readFile(path)` / `vm.readFileRaw(path)` | read text / bytes |
| `vm.loadBundle(name)` | stage a named manifest bundle on demand |
| `vm.resetToFresh()` | wipe the snapshot and reboot |
| `vm.ready()` / `vm.isReady` | boot readiness |
| `window.registerVmEndpoint(path, handler)` | answer guest HTTP to a virtual host |

> **Backgrounding note:** blink runs each command to completion in one Asyncify
> call, so `vm.run` always returns `done:true` (no preemption/kill). A truly
> hung command blocks the worker until it exits — reload to recover.

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
bun test/contract.spec.mjs    # window.vm contract + writeFile-install
bun test/dist-smoke.spec.mjs  # packaging: cold boot, buildId etag, snapshot
bun test/stress.spec.mjs      # sustained-load soak (ITERS=N)
```

## Known limitations

- **No scheduler / no true concurrency.** Run-to-completion vfork: `fork→exec→wait`
  works (shell, pipelines, sequences, subprocess capture); `&` backgrounding,
  preemption, and `kill` do not.
- **Per-fork memory.** A single `sh -c` that forks heavily (deep `$()`, big
  loops spawning many externals) can grow the wasm heap toward its ~2 GB ceiling
  within that one invocation.
