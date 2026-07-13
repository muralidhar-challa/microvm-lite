#!/usr/bin/env bash
# Assemble the microvm guest rootfs: full poppler-utils + sqlite3 (Alpine's
# prebuilt DYNAMIC x86_64-musl binaries) plus their complete shared-library
# closure and the musl loader. Output lands in microvm/test/rootfs/ (bin/, lib/,
# manifest.json), which the worker fetches into MEMFS at /bin and /lib.
#
# Why dynamic (not a static build): compiling poppler statically under
# x86_64-on-arm64 qemu is unstable (cc1/lto segfaults), and blink runs dynamic
# musl ELFs out of MEMFS fine — which a realistic rootfs needs anyway. See
# microvm/test/bench-results.md.
#
# Usage:  bash microvm/binaries/build-rootfs.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$HERE/test/rootfs"
ALPINE_TAG="alpine:3.21"

BINS="pdftotext pdfinfo pdftoppm pdfimages pdffonts pdfdetach pdfseparate pdfunite pdftops pdftohtml sqlite3"

docker rm -f mv-rootfs >/dev/null 2>&1 || true
docker run --name mv-rootfs --platform linux/amd64 "$ALPINE_TAG" sh -c '
  set -e
  apk add --no-cache poppler-utils sqlite scanelf >/dev/null 2>&1
  mkdir -p /out/bin /out/lib
  for b in '"$BINS"'; do
    cp "$(command -v "$b")" /out/bin/ || echo "missing: $b" >&2
  done
  cp /lib/ld-musl-x86_64.so.1 /out/lib/
  copydep() {
    for so in $(scanelf -nq "$1" | tr "," "\n"); do
      f=$(find /usr/lib /lib -name "$so" 2>/dev/null | head -1)
      if [ -n "$f" ] && [ ! -e "/out/lib/$so" ]; then cp "$f" /out/lib/; copydep "$f"; fi
    done
  }
  for b in /out/bin/*; do copydep "$b"; done
  echo "staged $(ls /out/bin | wc -l) binaries, $(ls /out/lib | wc -l) libs" >&2
'
rm -rf "$OUT"
docker cp mv-rootfs:/out "$OUT"
docker rm mv-rootfs >/dev/null

python3 - "$OUT" << 'PY'
import os, json, sys
out = sys.argv[1]
man = {d: sorted(os.listdir(os.path.join(out, d))) for d in ("bin", "lib")}
json.dump(man, open(os.path.join(out, "manifest.json"), "w"), indent=0)
print(f"manifest: {len(man['bin'])} bin, {len(man['lib'])} lib")
PY

du -sh "$OUT"
