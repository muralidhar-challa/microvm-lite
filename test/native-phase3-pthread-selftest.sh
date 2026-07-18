#!/usr/bin/env bash
# Phase 3 scheduler gate: builds a native blink CLI (the REAL blink.c main,
# not a custom test driver) with the Phase 3 scheduler linked in, cross-
# compiles blink/native-debug/pthread-counter-test.c (a real guest binary
# that calls pthread_create() twice) with musl, and runs it — proving real
# clone(CLONE_THREAD)/futex/pthread_join survive a round trip through
# mvl_dispatch.c's round-robin scheduler.
#
#   test/native-phase3-pthread-selftest.sh        # plain run
#   test/native-phase3-pthread-selftest.sh --lldb # interactive lldb session
#     (once at the lldb prompt: `b MvlSchedSwapToNext` then `run`, `c`,
#     `p g_mvl_current->m` repeatedly — the values cycle through 3 distinct
#     addresses (main + 2 workers) in a repeating round-robin, the direct
#     proof this session used that it's genuine preemptive interleaving,
#     not sequential execution that happens to compute the right answer.)
#
# See SCHEDULER-DESIGN.md for what this is proving and why. Requires
# blink-src/ to already have blink-wasm.patch applied (run blink/build.sh
# at least once first) and blink/config.h copied to blink-src/config.h.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$DIR/blink-src"
OUT="/tmp/mvl-phase3-blink"
GUEST_OUT="/tmp/mvl-phase3-guest"
mkdir -p "$OUT" "$GUEST_OUT"

x86_64-linux-musl-gcc -O2 -static -Wl,-z,common-page-size=65536,-z,max-page-size=65536 \
  -o "$GUEST_OUT/pthread-counter-test" \
  "$DIR/blink/native-debug/pthread-counter-test.c" -lpthread

cd "$SRC"
clang -g -O0 -arch x86_64 -D_XOPEN_SOURCE=600 -D_DARWIN_C_SOURCE \
  -DMVL_NATIVE_DEBUG -D__EMSCRIPTEN__ \
  "-DBUILD_MODE=\"native-debug\"" "-DBUILD_TOOLCHAIN=\"clang\"" \
  "-DBLINK_COMMITS=\"0\"" "-DBLINK_GITSHA=\"local\"" "-DBUILD_TIMESTAMP=\"now\"" "-DCONFIG_ARGUMENTS=\"\"" \
  -DNDEBUG \
  -ffunction-sections -fdata-sections -Wl,-dead_strip \
  -Wno-deprecated-declarations -Wno-\#warnings \
  $(ls blink/*.c | grep -vE 'blinkenlights|cga\.c|mda\.c|panel\.c|ppc\.c|xnu\.c|jit\.c|jitflush\.c|magikarp|ancillary|sysinfo|statfs|cpucount|mkfifo|devfs|procfs|pty|ioctl|realpath|seekdir|memccpy|mkfifoat|wcwidth|vasprintf|oneoff') \
  "$DIR/blink/stubs.c" "$DIR/blink/mvl_sched.c" "$DIR/blink/mvl_dispatch.c" \
  "$DIR/blink/mvl_sched_phase2_test.c" "$DIR/blink/native-debug/native-stubs.c" \
  -I. -I"$DIR/blink" -I"$DIR/blink/native-debug" \
  -o "$OUT/blink"

if [ "${1:-}" = "-m" ] || [ "${1:-}" = "--lldb" ]; then
  exec lldb -- "$OUT/blink" -m "$GUEST_OUT/pthread-counter-test"
else
  exec "$OUT/blink" -m "$GUEST_OUT/pthread-counter-test"
fi
