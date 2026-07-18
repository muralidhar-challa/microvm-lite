#!/usr/bin/env bash
# Phase 0 scheduler gate: compiles blink/mvl_sched.c standalone (no blink headers
# needed — it's self-contained) as a NATIVE x86_64 binary and runs
# SchedSelftest(). Use -m/--lldb to run it under lldb instead.
#
#   test/native-sched-selftest.sh        # plain run, exit code is the gate
#   test/native-sched-selftest.sh --lldb # interactive lldb session
#
# See SCHEDULER-DESIGN.md for what this is proving and why.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="/tmp/mvl-sched-phase0"
mkdir -p "$OUT"

clang -g -O0 -arch x86_64 -D_XOPEN_SOURCE=600 -DMVL_NATIVE_DEBUG -D__EMSCRIPTEN__ \
  -Wall -Wno-deprecated-declarations \
  "$DIR/blink/mvl_sched.c" "$DIR/blink/native-debug/sched-selftest-main.c" \
  -o "$OUT/sched-selftest"

if [ "${1:-}" = "-m" ] || [ "${1:-}" = "--lldb" ]; then
  exec lldb "$OUT/sched-selftest"
else
  exec "$OUT/sched-selftest"
fi
