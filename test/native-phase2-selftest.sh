#!/usr/bin/env bash
# Phase 2 scheduler gate: two Machines sharing one System, memory shared
# across a fiber swap. Links the FULL blink source tree natively (unlike
# native-sched-selftest.sh, this needs blink's real Machine/System/memory
# subsystem) as a NATIVE x86_64 binary and runs MvlSchedPhase2Test().
# Use -m/--lldb to run it under lldb instead.
#
#   test/native-phase2-selftest.sh        # plain run, exit code is the gate
#   test/native-phase2-selftest.sh --lldb # interactive lldb session
#
# See SCHEDULER-DESIGN.md for what this is proving and why. Requires
# blink-src/ to already have blink-wasm.patch applied (run blink/build.sh
# at least once first) and blink/config.h copied to blink-src/config.h.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$DIR/blink-src"
OUT="/tmp/mvl-phase2-native"
mkdir -p "$OUT"

cd "$SRC"
clang -g -O0 -arch x86_64 -D_XOPEN_SOURCE=600 -D_DARWIN_C_SOURCE \
  -DMVL_NATIVE_DEBUG -D__EMSCRIPTEN__ -DNDEBUG \
  -ffunction-sections -fdata-sections -Wl,-dead_strip \
  -Wno-deprecated-declarations -Wno-\#warnings \
  $(ls blink/*.c | grep -vE 'blinkenlights|cga\.c|mda\.c|panel\.c|ppc\.c|xnu\.c|jit\.c|jitflush\.c|magikarp|ancillary|sysinfo|statfs|cpucount|mkfifo|devfs|procfs|pty|ioctl|realpath|seekdir|memccpy|mkfifoat|wcwidth|vasprintf|oneoff|^blink/blink\.c$') \
  "$DIR/blink/stubs.c" "$DIR/blink/mvl_sched.c" "$DIR/blink/mvl_sched_phase2_test.c" \
  "$DIR/blink/native-debug/phase2-main.c" "$DIR/blink/native-debug/native-stubs.c" \
  -I. -I"$DIR/blink" -I"$DIR/blink/native-debug" \
  -o "$OUT/phase2"

if [ "${1:-}" = "-m" ] || [ "${1:-}" = "--lldb" ]; then
  exec lldb "$OUT/phase2"
else
  exec "$OUT/phase2"
fi
