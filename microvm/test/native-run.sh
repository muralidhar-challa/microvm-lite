#!/usr/bin/env bash
# Run a guest binary under NATIVE blink (fast local iteration, no browser).
#
#   microvm/test/native-run.sh xtool ping
#   microvm/test/native-run.sh pdftotext -f 1 -l 10 microvm/test/permit.pdf /tmp/out.txt
#
# Notes:
# - `-m` is required on 16K-page hosts (macOS arm64): our 4K-aligned ELFs are
#   rejected by blink's linear-memory optimization otherwise.
# - Native blink JITs to arm64 — MUCH faster than the wasm interpreter build.
#   Use this for guest-binary CORRECTNESS, never for wasm performance numbers.
# - Binaries resolve from microvm/blink-wasm/ first, then $PATH-style verbatim.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
BLINK="$DIR/blink-native/o/blink/blink"
[ -x "$BLINK" ] || { echo "native blink not built: (cd microvm/blink-native && ./configure && gmake -j8 o//blink/blink)" >&2; exit 1; }

CMD="$1"; shift
if [ -x "$DIR/blink-wasm/$CMD" ]; then
  exec "$BLINK" -m "$DIR/blink-wasm/$CMD" "$@"
else
  exec "$BLINK" -m "$CMD" "$@"
fi
