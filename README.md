## BusyBox + Emscripten + nanozip + diff3

BusyBox compiled to WebAssembly using Emscripten. This repo contains build scripts without being a full fork of BusyBox, making version upgrades easier.

**Current versions:** BusyBox 1.37.0, Emscripten 4.x

This repo also includes **[`microvm/`](microvm/README.md)** — an in-browser
x86-64 runtime (dash + toybox, zero GPL) built on the blink emulator.

### Download

Pre-built binaries are available on the [Releases](https://github.com/mayflower/busybox-wasm/releases) page:
- `busybox-linux-x86_64` - Native Linux binary
- `busybox.js` / `busybox.wasm` - WebAssembly build

### Build

Requires [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html) for WASM builds.

### Deno runner

The WASM build is emitted as an ES module (MODULARIZE + EXPORT_ES6) so it can be used directly in Deno.
The helper in `deno/busybox_runner.ts` loads `busybox.js`/`busybox.wasm` and exposes a simple `run()` API.
`busybox.js`/`busybox.wasm` are expected to live next to the runner in releases or your build output.

```shell
# native version
make build/native/busybox

# wasm version
make build/wasm/busybox_unstripped.js
```

### Custom Applets

This repo includes two [custom](https://git.busybox.net/busybox/plain/docs/new-applet-HOWTO.txt) BusyBox applets:

- [nanozip](https://github.com/vadimkantorov/nanozip) - [miniz](https://github.com/richgel999/miniz)-based imitation of `zip` utility:
  ```
  busybox nanozip [-r] [[-x EXCLUDED_PATH] ...] OUTPUT_NAME.zip INPUT_PATH [...]
  ```

- [diff3](https://github.com/openbsd/src/blob/master/usr.bin/diff3/diff3prog.c) - OpenBSD-based implementation of diff3:
  ```
  busybox diff3 [-exEX3] /tmp/d3a.?????????? /tmp/d3b.?????????? file1 file2 file3
  ```

### Credits & License

This repository's own code is [MIT](LICENSE) licensed. See [`CREDITS.md`](CREDITS.md) for attribution and licenses of every bundled and derived component.
