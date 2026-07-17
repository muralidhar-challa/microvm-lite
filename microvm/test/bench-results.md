# M1 Performance Gate — Results

Date: 2026-07-13 · Host: Apple Silicon Mac · blink.wasm **interpreter** (JIT
disabled), `-O2`, ASYNCIFY build · Chromium headless via Playwright.

Run it yourself: static server on :8765 serving `microvm/test/`, then
`bun microvm/test/bench.mjs`.

## Numbers

| bench | blink (ms) | v86 budget | verdict |
|---|---:|---|---|
| boot-to-ready (incl. all binary + rootfs fetches) | 193 | — | — |
| echo — simple shell | 24 | 150–400 ms | **6–16× faster** |
| xtool ping (Rust static) | 248 | — | — |
| xtool excel_create | 392 | 300 ms–10 s | within |
| xtool excel_set_batch 50 cells | 610 | 3–5 s | **5–8× faster** |
| xtool excel_get col | 433 | 300 ms–10 s | within |
| sqlite3 create + 1k rows + aggregate | 264 | — | fast |
| pdfinfo (1st dynamic exec — warms musl loader + lib closure) | 640 | — | — |
| **pdftotext 10 text pages** | **3 115** | **25–35 s** | **~8–11× faster** |
| pdftotext full 30 text pages | 8 172 | ~ (60–90 s / 100p) | **~3–4× faster** |
| pdftoppm 1 scanned page → PNG (raster @72dpi) | 27 594 | — | **slow — see note** |

Correctness verified: `pdftotext` extracted 36 895 bytes of real text from 10
pages / 111 570 bytes from 30 pages (not an empty fast-exit); `pdfinfo` reported
the right page counts; `sqlite3` returned `1000|500500`.

## Verdict: **GO** to M2

The performance gate passes decisively. Every tool on the common runner path —
shell, xtool (xlsx), sqlite3, and **pdftotext text extraction** — beats the v86
budget, most by ~5–11×, despite blink running as a pure interpreter with no JIT.
The M1 gate criterion was "≤ 2–3× of v86"; we're comfortably *faster* than v86,
not slower.

### The one caveat: raster rendering (pdftoppm) is slow
Rasterizing a scanned page to PNG took ~27.6 s (Splash software rasterizer, heavy
in an interpreter). This only affects the **scanned-PDF image fallback** path, is
per-page and on-demand, and the runner's primary strategy for scanned PDFs is the
`read_pdf` LLM tool (send the PDF directly), not local rasterization. Acceptable
for M1; revisit only if raster fallback becomes hot (options: lower DPI, or the
no-ASYNCIFY scheduler build should also speed the interpreter).

## Notes on methodology
- **Test PDFs**: `permit.pdf` (48p) and `item8.pdf` (105p) are *scanned* (image)
  PDFs — pdftotext returns near-empty on them in ~0.7 s, which is NOT a valid
  extraction measurement. `text30.pdf` (30 pages, generated via ps2pdf with
  FlateDecode-compressed text streams) is the real text-extraction workload.
- **Dynamic binaries**: poppler-utils + sqlite3 are Alpine's prebuilt **dynamic**
  musl binaries plus their 28-lib shared-object closure + `ld-musl-x86_64.so.1`,
  staged into MEMFS at `/bin` and `/lib`. blink runs the ELF interpreter out of
  MEMFS exactly like a real rootfs — this both sidestepped an unstable qemu
  static-compile and proved blink's dynamic-linking path (which a realistic
  rootfs needs anyway). First dynamic exec pays a one-time loader+lib cost
  (~0.6 s); subsequent execs are warm.
- **Static binaries**: static Rust tool binaries + busybox are
  static non-PIE (`-C relocation-model=static`), fetched into `/bin`.
- Numbers include full per-exec overhead (postMessage round-trip + Asyncify
  main() invocation), i.e. what the real `window.vm` contract will see.

## Next (M2)
`sh -c`, pipes, and multi-command lines currently fail with
`vfork/waitpid: Function not implemented` (HAVE_FORK off). Wiring
vfork/execve/waitpid + the cooperative scheduler is exactly M2 — and it's on the
critical path for the `runner` binary, whose Bash tool shells out via `sh -c`.
