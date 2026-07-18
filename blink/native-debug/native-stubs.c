// Trivial stubs for symbols that native (non-wasm, non-JIT) linking pulls
// in but can never actually be called at runtime in this build:
//
// - FastCall/FastCallAbs/FastLeave/Jitter: real JIT-only (uop.c defines them
//   as MICRO_OP, which is just an attribute, not a compile-out — but the
//   ACTUAL calls into them from stack.c are unconditional, not gated behind
//   HAVE_JIT). blink/config.h sets DISABLE_JIT, so nothing ever reaches
//   these paths — dead code the linker can't prove dead on its own.
// - FixXnuSignal: macOS/XNU-only signal-handling refinement (xnu.c, which
//   the wasm file list excludes on purpose). blink.c's OnFatalSystemSignal
//   references it unconditionally; the reference is only ever reachable
//   when clang natively defines __APPLE__, which the real emcc/wasm build
//   never does — this only shows up in this native debug harness.
//
// Only linked into the native MVL_NATIVE_DEBUG harness (test/native-*.sh);
// never part of the shipped wasm build.
#include <stdlib.h>
#include <signal.h>
#include "blink/machine.h"

void FastCall(struct Machine *m, u64 disp) {
  (void)m; (void)disp;
  abort();
}

void FastCallAbs(u64 x, struct Machine *m) {
  (void)x; (void)m;
  abort();
}

void FastLeave(struct Machine *m) {
  (void)m;
  abort();
}

void Jitter(P, const char *fmt, ...) {
  (void)m; (void)rde; (void)disp; (void)uimm0; (void)fmt;
  abort();
}

int FixXnuSignal(struct Machine *m, int sig, siginfo_t *si) {
  (void)m; (void)si;
  return sig;
}
