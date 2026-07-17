# Credits & Attribution

This project builds on excellent open-source work. Thank you to the authors and
communities below.

## Base

- **[busybox-wasm](https://github.com/mayflower/busybox-wasm)** by
  [mayflower](https://github.com/mayflower) — the BusyBox-to-WebAssembly build
  scripts this repository started from. The `microvm/` runtime is layered on top
  of that base.

## Vendored / bundled components

- **[BusyBox](https://busybox.net/)** — the in-VM shell and coreutils
  (GPL-2.0). Compiled to a static x86-64 musl binary.
- **[blink](https://github.com/jart/blink)** by Justine Tunney — the x86-64
  userspace emulator, compiled to WebAssembly (ISC). The `microvm/` runtime
  patches and builds blink; see `microvm/blink/`.
- **[Poppler](https://poppler.freedesktop.org/)** — PDF tooling
  (`pdftotext`/`pdfinfo`/…), GPL-2.0, loaded as a lazy bundle.
- **[SQLite](https://sqlite.org/)** — `sqlite3` (public domain).
- **[Emscripten](https://emscripten.org/)** — the WebAssembly toolchain.
- **[xterm.js](https://xtermjs.org/)** — terminal UI in the dev assets (MIT).
- **[em-shell / em-busybox](https://github.com/tbfleming/em-shell)** by
  [Todd Fleming](https://tbfleming.github.io/) — the `em-shell.c/.h/.js` files
  are based on this work (updated for modern Emscripten 4.x).
- **[nanozip](https://github.com/vadimkantorov/nanozip)** by Vadim Kantorov
  ([miniz](https://github.com/richgel999/miniz)-based) and
  **[diff3](https://github.com/openbsd/src/blob/master/usr.bin/diff3/diff3prog.c)**
  (OpenBSD) — custom BusyBox applets bundled here.

## This repository's own work

The `microvm/` subtree — the product-agnostic in-browser x86-64 runtime
("microvm-lite"), its `window.vm` contract, the bundle-based asset loader, the
HTTP bridge, and the packaging — is original work in this repository. See
`microvm/README.md`.

## License

This repository's own code (the `microvm/` runtime and build scripts) is MIT
licensed — see [`LICENSE`](LICENSE). The bundled/built third-party components
above retain their own licenses (BusyBox and Poppler are **GPL-2.0**, blink is
ISC, SQLite is public domain, xterm.js is MIT). Redistributing the built GPL
binaries carries those projects' obligations regardless of the MIT license on
this repo's own code.
