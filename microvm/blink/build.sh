#!/usr/bin/env bash
# Build blink WASM shell from scratch.
# Run from repo root: bash blink/build.sh
# Requires: emcc (Emscripten), x86_64-linux-musl-gcc (for busybox)

set -e

# emcc's Python shebang must resolve to >=3.10. On machines where the system
# default `python3` is older (e.g. macOS's bundled 3.8), put Homebrew's bin
# first so `python3` resolves to a modern interpreter for this script only —
# don't rely on the ambient shell's PATH order.
export PATH="/opt/homebrew/bin:$PATH"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BLINK_DIR="$REPO_ROOT/blink"
SRC_DIR="$REPO_ROOT/blink-src"
OUT_DIR="$REPO_ROOT/blink-wasm"
BLINK_COMMIT="main"  # pin to a commit hash for reproducibility

# ── 1. Clone blink source ────────────────────────────────────────────────────
if [ ! -d "$SRC_DIR/.git" ]; then
  echo "[1/5] Cloning blink..."
  git clone https://github.com/jart/blink "$SRC_DIR"
else
  echo "[1/5] blink source already present, skipping clone"
fi

# ── 2. Apply patches ─────────────────────────────────────────────────────────
echo "[2/5] Applying patches..."
cd "$SRC_DIR"
# Reset any previous patches before applying
git checkout blink/syscall.c blink/realpath.c 2>/dev/null || true
git apply "$BLINK_DIR/patches/blink-wasm.patch"

# ── 3. Copy our shell template and build config ──────────────────────────────
echo "[3/5] Copying custom files..."
cp "$BLINK_DIR/shell.html" "$SRC_DIR/blink/blink-shell.html"

# ── 4. Build blink.js + blink.wasm ───────────────────────────────────────────
echo "[4/5] Building blink WASM..."
mkdir -p "$OUT_DIR"

# blink/builtin.h does `#include "config.h"` and -I. comes first, so the copy at
# the blink-src root is what the build actually uses. It MUST be the crafted
# wasm config (DISABLE_JIT/THREADS/FORK...) — a `./configure`-generated native
# config here silently poisons the wasm build with host-OS feature detection.
cp "$BLINK_DIR/config.h" "$SRC_DIR/config.h"

cd "$SRC_DIR"
emcc \
  $(ls blink/*.c | grep -vE 'blinkenlights|cga\.c|mda\.c|panel\.c|ppc\.c|xnu\.c|jit\.c|jitflush\.c|magikarp|ancillary|sysinfo|statfs|cpucount|mkfifo|devfs|procfs|pty|ioctl|realpath|seekdir|memccpy|mkfifoat|wcwidth|vasprintf|oneoff') \
  "$BLINK_DIR/stubs.c" \
  -I. -I"$BLINK_DIR" \
  -o "$OUT_DIR/blink.js" \
  -DNDEBUG \
  "-DBUILD_MODE=\"wasm\"" "-DBUILD_TOOLCHAIN=\"emcc\"" \
  "-DBLINK_COMMITS=\"0\"" "-DBLINK_GITSHA=\"local\"" \
  "-DBUILD_TIMESTAMP=\"now\"" "-DCONFIG_ARGUMENTS=\"\"" \
  -O2 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s EXPORTED_RUNTIME_METHODS='["callMain","ccall","FS","TTY","ENV","HEAPU32","stringToNewUTF8"]' \
  -s EXPORTED_FUNCTIONS='["_main","_malloc","_free","_em_reset_getopt","_em_main","_em_last_exit"]' \
  -s INVOKE_RUN=0 -s EXIT_RUNTIME=0 -s FORCE_FILESYSTEM=1 \
  -s ASYNCIFY -s ASYNCIFY_IMPORTS='["emscripten_sleep"]' \
  -sUSE_ZLIB=1

# ── 5. Build busybox (NOMMU + hush) ──────────────────────────────────────────
echo "[5/5] Building busybox..."
BUSY_VER="1.36.1"
BUSY_DIR="/tmp/busybox-$BUSY_VER"
if [ ! -d "$BUSY_DIR" ]; then
  curl -L "https://busybox.net/downloads/busybox-$BUSY_VER.tar.bz2" | tar xj -C /tmp
fi
cd "$BUSY_DIR"
# Use our saved config (NOMMU + hush, no job control, nofork applets)
cp "$BLINK_DIR/busybox.config" .config
# Update cross compiler prefix to local path
sed -i.bak \
  's|CONFIG_CROSS_COMPILER_PREFIX=.*|CONFIG_CROSS_COMPILER_PREFIX="/opt/homebrew/bin/x86_64-linux-musl-"|' \
  .config
make -j"$(sysctl -n hw.logicalcpu 2>/dev/null || nproc)"
cp busybox "$OUT_DIR/busybox"

# ── Copy static assets ───────────────────────────────────────────────────────
cp "$BLINK_DIR"/assets/* "$OUT_DIR/"

# ── Generate blink.html from template ───────────────────────────────────────
python3 -c "
t = open('$SRC_DIR/blink/blink-shell.html').read()
open('$OUT_DIR/blink.html', 'w').write(t.replace('{{{ SCRIPT }}}', '<script src=\"blink.js\"></script>'))
print('blink.html generated')
"

echo ""
echo "Done! Serve with:"
echo "  cd $OUT_DIR && python3 -m http.server 8765"
echo "  open http://localhost:8765/blink.html"
