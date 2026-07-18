#!/usr/bin/env bash
# Regenerate blink-wasm.patch from the CURRENT edited state of blink-src.
#
# WHY THIS EXISTS: build.sh resets (git checkout) the patched files and
# re-applies blink-wasm.patch on every run. So direct edits to blink-src/blink/*
# are LOST on the next build unless captured back into the patch first. Always
# run this after editing blink-src sources, before build.sh.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$DIR/blink-src"
# Must list every file the patch touches (keep in sync with build.sh's checkout).
FILES="blink/close.c blink/debug.c blink/errno.c blink/errno.h blink/machine.c blink/machine.h blink/open.c blink/pipe.c blink/realpath.c blink/syscall.c blink/syscall.h blink/blink.c blink/throw.c"
cd "$SRC"
git diff $FILES > "$DIR/blink/patches/blink-wasm.patch"
echo "regenerated blink-wasm.patch ($(wc -l < "$DIR/blink/patches/blink-wasm.patch") lines) from blink-src edits"
