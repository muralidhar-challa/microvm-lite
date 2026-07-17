#!/usr/bin/env bash
# Build blink WASM + dash + toybox from scratch.
# Run from repo root: bash blink/build.sh
# Requires: emcc (Emscripten), x86_64-linux-musl-gcc, gsed,
#           autoconf/automake (for dash)

set -e

export PATH="/opt/homebrew/bin:$PATH"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BLINK_DIR="$REPO_ROOT/blink"
SRC_DIR="$REPO_ROOT/blink-src"
OUT_DIR="$REPO_ROOT/blink-wasm"
BLINK_COMMIT="main"

# ── 1. Clone blink source ────────────────────────────────────────────────────
if [ ! -d "$SRC_DIR/.git" ]; then
  echo "[1/6] Cloning blink..."
  git clone https://github.com/jart/blink "$SRC_DIR"
else
  echo "[1/6] blink source already present, skipping clone"
fi

# ── 2. Apply patches ─────────────────────────────────────────────────────────
# blink-wasm.patch carries every C change this project needs on top of stock
# blink: the M2 process model (vfork/execve/wait4 in syscall.c), the M3 HTTP
# bridge (virtual sockets), a real guest-memory snapshot/restore around every
# Fork() (true fork isolation without host COW — fixes a crash on any pipe or
# $() whose child never execve()s and corrupts the parent's shared memory),
# an EmSaveFds/EmRestoreFds fix (fd table save/restore at every fork nesting
# level, not just the outermost), a getdents() fix (real directory listing
# only requires the fd to BE a directory, not that O_DIRECTORY was passed to
# open() — toybox's ls opens plain O_RDONLY and was silently seeing 0 entries),
# and em_reset_children() (clears blink's own child-status table between
# top-level commands in this long-lived worker — see stubs.c's
# em_reset_getopt comment for why blink's C globals need this at all).
echo "[2/6] Applying patches..."
cd "$SRC_DIR"
git checkout blink/close.c blink/debug.c blink/errno.c blink/errno.h \
            blink/machine.c blink/machine.h blink/open.c blink/pipe.c \
            blink/realpath.c blink/syscall.c blink/syscall.h blink/blink.c \
            blink/throw.c 2>/dev/null || true
git apply "$BLINK_DIR/patches/blink-wasm.patch"

# ── 3. Copy our shell template and build config ──────────────────────────────
echo "[3/6] Copying custom files..."
cp "$BLINK_DIR/shell.html" "$SRC_DIR/blink/blink-shell.html"

# ── 4. Build blink.js + blink.wasm ───────────────────────────────────────────
echo "[4/6] Building blink WASM..."
mkdir -p "$OUT_DIR"
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
  -s EXPORTED_RUNTIME_METHODS='["callMain","ccall","FS","TTY","ENV","HEAPU32","stringToNewUTF8","UTF8ToString"]' \
  -s EXPORTED_FUNCTIONS='["_main","_malloc","_free","_em_reset_getopt","_em_reset_children","_em_main","_em_last_exit"]' \
  -s INVOKE_RUN=0 -s EXIT_RUNTIME=0 -s FORCE_FILESYSTEM=1 \
  -s ASYNCIFY -s ASYNCIFY_IMPORTS='["emscripten_sleep","__asyncjs__em_http_fetch"]' \
  -s STACK_SIZE=33554432 \
  -sUSE_ZLIB=1

# ── 5. Build dash (BSD-3-Clause /bin/sh) ─────────────────────────────────────
echo "[5/6] Building dash..."
DASH_VER="0.5.12"
DASH_DIR="/tmp/dash-$DASH_VER"
if [ ! -d "$DASH_DIR" ]; then
  curl -L "https://git.kernel.org/pub/scm/utils/dash/dash.git/snapshot/dash-$DASH_VER.tar.gz" | tar xz -C /tmp
  cd "$DASH_DIR" && bash autogen.sh 2>/dev/null
fi
cd "$DASH_DIR"
# Page-aligned for blink's linear memory: -Wl,-z,common-page-size=65536,-z,max-page-size=65536
CC=x86_64-linux-musl-gcc CFLAGS="-O2" \
  LDFLAGS="-static -Wl,-z,common-page-size=65536,-z,max-page-size=65536" \
  ./configure --host=x86_64-linux-musl --enable-static 2>/dev/null
make -j"$(sysctl -n hw.logicalcpu 2>/dev/null || nproc)" \
  LDFLAGS="-static -Wl,-z,common-page-size=65536,-z,max-page-size=65536" 2>/dev/null
x86_64-linux-musl-strip src/dash
cp src/dash "$OUT_DIR/dash"

# ── 6. Build toybox (0BSD coreutils) ────────────────────────────────────────
echo "[6/6] Building toybox..."
TOYBOX_VER="0.8.14"
TOYBOX_DIR="/tmp/toybox-$TOYBOX_VER"
if [ ! -d "$TOYBOX_DIR" ]; then
  curl -L "https://landley.net/toybox/downloads/toybox-$TOYBOX_VER.tar.gz" | tar xz -C /tmp
fi
cd "$TOYBOX_DIR"
cp "$BLINK_DIR/toybox.config" .config
CROSS_COMPILE=x86_64-linux-musl- SED=gsed LDFLAGS="-static" \
  LDOPTIMIZE="-Wl,--gc-sections -Wl,--as-needed" \
  make -j"$(sysctl -n hw.logicalcpu 2>/dev/null || nproc)"
chmod 755 toybox
x86_64-linux-musl-strip toybox
cp toybox "$OUT_DIR/toybox"

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
