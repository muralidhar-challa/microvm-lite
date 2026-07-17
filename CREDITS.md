# Credits & Attribution

This project builds on excellent open-source work. Thank you to the authors and
communities below.

## Vendored / built components

- **[dash](https://git.kernel.org/pub/scm/utils/dash/dash.git/)** — the
  in-VM `/bin/sh` (BSD-3-Clause). Compiled to a static x86-64 musl binary.
- **[toybox](https://landley.net/toybox/)** — the in-VM coreutils
  (`ls`, `cat`, `sed`, `grep`, etc.), 0BSD licensed.
- **[blink](https://github.com/jart/blink)** by Justine Tunney — the x86-64
  userspace emulator, compiled to WebAssembly (ISC). See `blink/`.
- **[Emscripten](https://emscripten.org/)** — the WebAssembly toolchain.
- **[xterm.js](https://xtermjs.org/)** — terminal UI, shipped in `dist/` and used
  by `vm-terminal.js` (MIT).

## This repository's own work

The runtime ("microvm-lite"), its `window.vm` contract, the bundle-based asset
loader, the HTTP bridge, and the packaging — is original work. See `README.md`.

## License

This repository's own code is MIT licensed — see [`LICENSE`](LICENSE). The
bundled/built third-party components retain their own licenses (dash is
**BSD-3-Clause**, toybox is **0BSD**, blink is ISC, xterm.js is MIT).
The reference build is permissively licensed throughout.
