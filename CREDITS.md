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

## This repository's own work

The `microvm/` subtree — the product-agnostic in-browser x86-64 runtime
("microvm-lite"), its `window.vm` contract, the bundle-based asset loader, the
HTTP bridge, and the packaging — is original work in this repository. See
`microvm/README.md`.

Component licenses are those of their respective upstream projects; retain them
when redistributing.
